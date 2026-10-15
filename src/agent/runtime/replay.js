// Replay is read-only: no executor, wallet, provider, model, or current pool lookup.
import { createDecisionId, hashSnapshot } from '../decisionLogger.js';
import { proposeFromEvent } from '../pipelines/monitorPipeline.js';
import { quoteFromCase } from '../../core/pricingEngine.js';
import { checkDocumentConsistency } from '../documentConsistency.js';

export const REPLAY_SCHEMA = 'agent-replay-v1';

export function replayDecision(decision) {
  const checks = [];
  const check = (name, expected, actual) => checks.push({ name, expected: expected ?? null, actual: actual ?? null, passed: (expected ?? null) === (actual ?? null) });
  const saved = decision?.replay;
  if (saved?.schema !== REPLAY_SCHEMA) return { status: 'FAIL', passed: false, decision_id: decision?.decision_id ?? null,
    checks: [], code: 'snapshot_unavailable', note: 'This historical decision has no replay input. It cannot be backfilled from current state.' };
  try {
    check('replay_input_hash', decision.replay_hash, hashSnapshot(saved));
    let action, snapshot, evidenceHash, quoteHash, calculatedQuote;
    if (saved.kind === 'monitor') {
      const output = proposeFromEvent(saved.event, { pool: saved.pool, mode: saved.mode, now: () => saved.now_ms });
      const proposal = output.proposals[saved.proposal_index];
      if (!proposal) throw new Error('The saved input no longer produces a proposal');
      calculatedQuote = proposal.params?.quote ?? saved.pool?.quote ?? null;
      check('proposal_params', hashSnapshot(decision.proposal?.params ?? {}), hashSnapshot(proposal.params));
      ({ action, input_snapshot: snapshot, evidence_hash: evidenceHash, quote_hash: quoteHash } = proposal);
    } else if (saved.kind === 'ingest') {
      snapshot = saved.snapshot;
      action = saved.no_quote ? (saved.blocked ? 'REJECT' : 'HOLD_FOR_REVIEW') : null;
      if (!saved.no_quote) {
        const quote = quoteFromCase(saved.case_data, saved.pricing_options);
        calculatedQuote = quote;
        evidenceHash = quote.evidence_hash; quoteHash = quote.quote_hash;
        const kinds = new Set(saved.findings.map((finding) => finding.kind));
        action = kinds.has('COMPLIANCE_BLOCK') ? 'REJECT'
          : saved.parser_review || saved.below_floor || checkDocumentConsistency(saved.case_data).has_critical
            || ['PROMPT_INJECTION_SUSPECTED', 'OCR_REQUIRED', 'DOCUMENT_UNPARSEABLE', 'COMPLIANCE_REVIEW', 'STALE_EVIDENCE'].some((kind) => kinds.has(kind))
            ? 'HOLD_FOR_REVIEW'
            : ({ OPEN_OFFERING: 'OPEN', OPEN_WITH_WARNING: 'OPEN_WITH_WARNING' }[quote.pricing_action] ?? 'HOLD_FOR_REVIEW');
        // Rebuild the quote commitment inside the structured-input snapshot.
        snapshot = { ...snapshot, quote_hash: quoteHash };
      } else evidenceHash = hashSnapshot(snapshot);
    } else throw new Error('Unsupported replay pipeline');
    if (calculatedQuote) check('quote_snapshot', hashSnapshot(decision.quote_snapshot), hashSnapshot(calculatedQuote));
    check('proposed_action', decision.proposed_action ?? decision.action, action);
    check('input_snapshot', hashSnapshot(decision.input_snapshot), hashSnapshot(snapshot));
    check('evidence_hash', decision.evidence_hash, evidenceHash);
    check('quote_hash', decision.quote_hash, quoteHash);
    check('decision_id', decision.decision_id, createDecisionId({ ...decision, action, input_snapshot: snapshot, evidence_hash: evidenceHash }));
  } catch (error) {
    checks.push({ name: 'recompute', passed: false, actual: String(error.message).slice(0, 200) });
  }
  const passed = checks.length >= 6 && checks.every((entry) => entry.passed);
  return { status: passed ? 'PASS' : 'FAIL', passed, decision_id: decision.decision_id, schema: saved.schema, checks,
    scope: 'Saved structured inputs and deterministic decision/pricing; no source-document extraction, model recall, or chain execution.' };
}
