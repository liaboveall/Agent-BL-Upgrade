// Ingest pipeline adapter (docs/agent-implementation-plan.md WP2.4): turns a DOCUMENTS_INGESTED event
// into an action PROPOSAL, exactly like monitorPipeline does for the other event types. The heavy
// lifting is AgentOrchestrator.processDocuments; this file loads the stored documents, hands the
// orchestrator the exporter's preferences, saves the resulting case and shapes the proposal.
//
// Whether the proposal may run (Demo auto, Live approval, ...) is decided later by the policy engine.

import { hashSnapshot } from '../decisionLogger.js';

/** A compact, deterministic view of the three-speed comparison for the decision record. */
function quoteSummary(comparison) {
  return comparison.quotes.map((quote) => ({
    payout_speed: quote.payout_speed,
    final_issue_price_usd: quote.final_issue_price_usd,
    risk_level: quote.risk_level,
    pricing_action: quote.pricing_action,
    quote_hash: quote.quote_hash
  }));
}

/**
 * @param {object} event  a normalised DOCUMENTS_INGESTED event ({ job_id, document_ids } in data)
 * @param {object} deps
 * @param {import('../ingest/ingestService.js').IngestService} deps.ingest
 * @param {import('../orchestrator.js').AgentOrchestrator} deps.orchestrator
 * @param {{get(caseId: string): object|undefined}} deps.preferences
 * @param {object|null} deps.pool            the offchain pool for this case, if one already exists (its case is the template)
 * @param {(step: object) => Promise<void>|void} [deps.onStep]
 * @param {boolean} [deps.forceDeterministic]
 * @param {object} [deps.valuation]
 * @param {object} [deps.worldRisk]
 * @param {() => number} [deps.now]
 */
export async function proposeFromIngest(event, { ingest, orchestrator, preferences, pool, onStep, forceDeterministic, valuation, worldRisk, now }) {
  const job = ingest.getJob(event.data?.job_id);
  const ids = event.data?.document_ids ?? job?.document_ids ?? [];
  if (ids.length === 0) return { proposals: [], ignored: 'The ingest event names no documents' };
  const documents = await ingest.loadDocuments(ids);

  const result = await orchestrator.processDocuments({
    case_id: event.case_id,
    documents,
    template_case: pool?.caseData,
    exporter_preferences: preferences.get(event.case_id)
  }, { onStep, forceDeterministic, valuation, worldRisk, now });

  const opening = result.action === 'OPEN' || result.action === 'OPEN_WITH_WARNING';
  if (opening) await ingest.saveCase(result.case_data);

  const params = opening
    ? {
      case_data: result.case_data,
      quote: result.quote,
      quotes: quoteSummary(result.comparison),
      contract_action: result.contract_action,
      documents: result.documents,
      valuation_provider: result.valuation?.provider ?? null
    }
    : { documents: result.documents, ...(result.quote ? { quote: result.quote } : {}) };

  return {
    proposals: [{
      action: result.action,
      reasoning_summary: result.reasoning_summary,
      params,
      findings: result.findings,
      price_move_bps: undefined,
      new_issue_price_usd: undefined,
      evidence_hash: result.evidence_hash ?? hashSnapshot(result.input_snapshot),
      quote_hash: result.quote_hash,
      llm_only: false,
      pipeline: [{ step: 'event_validated', status: 'PASS', duration_ms: 0 }, ...result.pipeline],
      input_snapshot: result.input_snapshot
    }]
  };
}
