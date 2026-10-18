import { AgentOrchestrator } from '../orchestrator.js';
import { checkDocumentConsistency } from '../documentConsistency.js';
import { checkCompliance } from '../complianceChecker.js';
import { cargoIdentityHashV2 } from '../../chain/cargoIdentity.js';
import { assessFreshness } from '../runtime/freshness.js';
import { generateRedteam } from './generator.js';

export async function runRedteam({ caseData, documents, seed = 5322, now = '2026-06-12T00:00:00Z' }) {
  const corpus = generateRedteam({ caseData, documents, seed, now });
  const orchestrator = new AgentOrchestrator();
  const results = [];
  for (const entry of corpus) {
    // The label is never passed to any subject component.
    const input = structuredClone(entry.input);
    let passed, actual;
    if (entry.category === 'injection') {
      const output = await orchestrator.processDocuments(input, { forceDeterministic: true, valuation: { env: {} }, worldRisk: { env: {} } });
      actual = output.action;
      passed = actual === 'HOLD_FOR_REVIEW' && output.findings.some((finding) => finding.kind === 'PROMPT_INJECTION_SUSPECTED');
    } else if (entry.category === 'duplicate-cargo') {
      actual = cargoIdentityHashV2(input) === cargoIdentityHashV2(caseData); passed = actual === entry.gold.same_cargo;
    } else if (entry.category === 'sanctioned-port') {
      actual = (await checkCompliance(input)).status; passed = actual === entry.gold.compliance;
    } else if (entry.category === 'stale-data') {
      actual = assessFreshness(input, Date.parse(input.now)).fresh; passed = actual === entry.gold.fresh;
    } else {
      actual = !checkDocumentConsistency(input).ok; passed = actual === entry.gold.inconsistent;
    }
    results.push({ id: entry.id, category: entry.category, passed, actual });
  }
  return { seed, corpus_size: corpus.length, passed: results.every((result) => result.passed), results,
    real_transactions: 0, real_provider_calls: 0, scope: 'Deterministic fictional mutations; finite corpus, not a general security guarantee.' };
}
