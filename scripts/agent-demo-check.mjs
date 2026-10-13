import assert from 'node:assert/strict';
import { loadEvaluationDataset } from '../src/agent/evaluation/dataset.js';
import { evaluateScenario, runBlind } from '../src/agent/evaluation/runner.js';
const dataset = await loadEvaluationDataset();
for (const entry of dataset.scenarios) {
  const actual = await runBlind(entry.input, evaluateScenario);
  assert.deepEqual(actual.actions, entry.gold.actions, entry.id);
  assert.equal(actual.final_state, entry.gold.final_state, entry.id);
  assert.equal(actual.duplicate_executions, 0);
  assert.equal(actual.policy_violations, 0);
  assert.equal(actual.stopped, true);
}
console.log('Demo Agent: 3 complete scenarios PASS; no duplicate execution; approvals enforced; runtime stopped');
