import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEvaluationDataset, EVAL_THRESHOLDS } from '../src/agent/evaluation/dataset.js';
import { runEvaluation, runBlind, ndcgAt3, checkThresholds } from '../src/agent/evaluation/runner.js';
import { renderEvaluationReport, generateEvaluationReport } from '../src/agent/evaluation/evaluationReport.js';
import { parseDocument } from '../src/agent/documentParser.js';

const dataset = await loadEvaluationDataset();
const evaluation = await runEvaluation({ dataset });

test('measured Agent suites meet every frozen deterministic threshold using real components', () => {
  assert.equal(evaluation.real_components, true);
  assert.equal(evaluation.mode, 'deterministic');
  assert.equal(evaluation.passed, true, JSON.stringify(evaluation.gates.filter((gate) => !gate.passed)));
  assert.equal(evaluation.gates.length, Object.keys(EVAL_THRESHOLDS).length);
  assert.deepEqual(new Set(evaluation.results.map((result) => result.suite)), new Set(['extraction', 'consistency', 'compliance', 'pricing', 'loop', 'copilot', 'ranking', 'injection', 'redteam']));
  assert.ok(evaluation.counts.copilot.dialogues >= 40);
  assert.ok(evaluation.counts.copilot.turns >= 80);
  assert.ok(dataset.copilot.some((entry) => entry.input.locale === 'zh') && dataset.copilot.some((entry) => entry.input.locale === 'en'));
  assert.equal(evaluation.counts.pricing.seed, 5322);
  assert.ok(evaluation.counts.pricing.quotes >= 1000);
  assert.equal(evaluation.counts.copilot.llm_intent_turns, 0);
  assert.equal(evaluation.config.network_access, false);
});

test('scoring rejects missing and non-finite metrics rather than treating them as success', () => {
  assert.ok(checkThresholds({}).every((gate) => !gate.passed));
  assert.ok(checkThresholds({ ...evaluation.metrics, attack_success_rate: NaN }).find((gate) => gate.metric === 'attack_success_rate').passed === false);
  assert.ok(checkThresholds({ ...evaluation.metrics, duplicate_executions: 1 }).find((gate) => gate.metric === 'duplicate_executions').passed === false);
  assert.ok(checkThresholds({ ...evaluation.metrics, recommendation_constraint_rate: 0.99 }).find((gate) => gate.metric === 'recommendation_constraint_rate').passed === false);
});

test('label boundary rejects leaked labels at any depth and freezes the component input', async () => {
  for (const input of [{ expected: 1 }, { documents: [{ ground_truth: true }] }, { payload: { gold: {} } }]) {
    let called = false;
    await assert.rejects(runBlind(input, () => { called = true; }), /label leaked/u);
    assert.equal(called, false);
  }
  await runBlind({ text: 'hello', nested: { amount: 1 } }, (input) => {
    assert.throws(() => { input.nested.amount = 2; }, TypeError);
    assert.ok(Object.isFrozen(input));
  });
});

test('changing gold cannot change subject output, and broken extraction fails the quality gate', async () => {
  const altered = structuredClone(dataset);
  altered.documents[0].gold.fields.quantity_mt = 999999;
  let inputs = 0;
  const measured = await runEvaluation({ dataset: altered, adapters: { parseDocument: async (input) => {
    inputs++;
    assert.deepEqual(Object.keys(input).sort(), ['filename', 'text']);
    return parseDocument(input);
  }, processDocuments: async () => ({ action: 'HOLD_FOR_REVIEW', findings: [{ kind: 'PROMPT_INJECTION_SUSPECTED' }] }) } });
  assert.equal(inputs, altered.documents.length);
  const failed = measured.failed_cases.find((entry) => entry.id === 'copper-bl');
  assert.equal(failed.actual.quantity_mt, 500);
  assert.equal(failed.gold.quantity_mt, 999999);
  assert.equal(measured.metrics.benign_hold_rate, 1, 'denying everything must not pass injection quality');
  assert.equal(measured.passed, false);
  // Scoring a real missing-output failure separately prevents an always-perfect scorer.
  const empty = await runEvaluation({ adapters: { parseDocument: async () => ({ document_type: null, fields: {} }) } });
  assert.equal(empty.metrics.extraction_recall, 0);
  assert.equal(empty.metrics.extraction_precision, 0);
  assert.equal(empty.passed, false);
});

test('empty or truncated evaluation suites are rejected, never awarded perfect safety scores', async () => {
  for (const data of [{ ...dataset, copilot: [] }, { ...dataset, pricing: { ...dataset.pricing, samples: 0 } }, { ...dataset, injections: [] }]) {
    await assert.rejects(runEvaluation({ dataset: data }), /required|requires|Empty/u);
  }
});

test('NDCG penalizes reversed rankings, irrelevant and duplicate results, and empty output', () => {
  const gold = { best: 3, next: 2, last: 1 };
  assert.equal(ndcgAt3(['best', 'next', 'last'], gold), 1);
  assert.ok(ndcgAt3(['last', 'next', 'best'], gold) < 1);
  assert.ok(ndcgAt3(['best', 'best', 'best'], gold) < 1);
  assert.equal(ndcgAt3(['unrelated'], gold), 0);
  assert.equal(ndcgAt3([], gold), 0);
});

test('report shows failures and limits, and never claims an unrun provider evaluation', async () => {
  const report = renderEvaluationReport({ ...evaluation, failed_cases: [{ suite: 'example', id: 'failure', actual: 1, gold: 2 }] });
  assert.match(report, /example\/failure/u);
  assert.match(report, /SKIP/u);
  assert.match(report, /金标不传入/u);
  assert.match(report, /未执行真实提供方/u);
  const liveReport = renderEvaluationReport({ ...evaluation, live_llm: { status: 'SKIP', notice: 'Provider unavailable' } });
  assert.match(liveReport, /Provider unavailable/u);
  // Compatibility entrypoint executes the real runner too.
  assert.match(await generateEvaluationReport(), /AgentBL Agent 评测报告/u);
});
