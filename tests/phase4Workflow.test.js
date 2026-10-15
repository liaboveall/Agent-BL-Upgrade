import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { listen, requestJson } from './helpers/http.js';
import { createAgentService } from '../src/agent/runtime/factory.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { decisionReferences } from '../src/agent/runtime/references.js';
import { createPool, resetStore, storeState, subscribeToPool } from '../src/app/store.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { chatCompletion, completionMetadata } from '../src/agent/llm/openaiCompatClient.js';
import { runValuationAgent } from '../src/agent/valuationAgent.js';

process.env.AGENTBL_RATE_LIMIT_PER_MIN = '0';
process.env.AGENTBL_WRITE_RATE_LIMIT_PER_MIN = '0';
delete process.env.AGENTBL_ADMIN_TOKEN;
const { createServer, setAgentService, activityLog, closeActivityStreams } = await import('../src/app/server.js');
const { demoModeController } = await import('../src/demo/mode.js');
const copper = JSON.parse(await fs.readFile(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url), 'utf8'));
const weather = [{ type: 'severe_weather', region: 'East China Sea', severity: 'warning', description: 'Typhoon', date: '2026-06-11' }];

async function runtime(t, { persist, autonomy } = {}) {
  resetStore(); demoModeController.mode = 'demo'; demoModeController.generation += 1;
  createPool(copper.case_id, copper, quoteFromCase(copper, { payout_speed: 'BALANCED' }));
  const service = createAgentService({ env: {}, dir: persist, config: loadAgentConfig({ AGENT_VALUATION_LLM: 'false', AGENT_AUTONOMY: autonomy }),
    activity: activityLog, store: storeState, demoModeController, ensurePools: async () => {}, monitors: false, chainConfig: null, getChainContext: async () => null });
  setAgentService(service); await service.start(); service.scenarios.stepDelayMs = 0;
  t.after(async () => { await service.stop(); delete process.env.AGENTBL_ADMIN_TOKEN; demoModeController.mode = 'demo'; });
  return service;
}

test('Phase 4: full playback parses actual files and preserves separate payment and settlement approval', async (t) => {
  const service = await runtime(t);
  await service.scenarios.play('copper-lifecycle', { speed: 10 }); await service.scenarios.playTask;
  const playback = service.scenarios.playbackStatus();
  assert.equal(playback.state, 'completed', JSON.stringify(playback.error));
  assert.equal(playback.scenario.next_step, 10);
  const decisions = (await service.listDecisions({ limit: 50 })).decisions.reverse();
  assert.deepEqual(decisions.map((item) => item.action), ['OPEN', 'MARK_IN_TRANSIT', 'REPRICE', 'PAUSE', 'RESUME', 'RECORD_ARRIVAL', 'RECORD_PAYMENT']);
  const job = service.ingest.getJob(playback.scenario.log[0].job_id);
  assert.equal(job.status, 'DONE'); assert.equal(job.extraction.length, 3);
  assert.ok(job.steps.some((step) => step.step === 'document_consistency'));
  assert.ok(job.steps.some((step) => step.step === 'compliance'));
  assert.equal(storeState.investments.length, 1);
  assert.ok(decisions.every((decision) => !decision.execution?.tx_hash && !decision.execution?.explorer_url));
  const [payment] = service.approvals.list({ status: 'PENDING' });
  assert.equal(payment.action, 'RECORD_PAYMENT');
  await service.approve(payment.approval_id); await service.bus.idle();
  assert.notEqual(storeState.pools.get(copper.case_id).status, 'Repaid');
  const [settlement] = service.approvals.list({ status: 'PENDING' });
  assert.equal(settlement.action, 'SETTLE');
  await service.approve(settlement.approval_id);
  assert.equal(storeState.pools.get(copper.case_id).status, 'Repaid');
  assert.equal((await service.getDecision(settlement.decision_id)).execution.mode, 'demo');
});

test('Phase 4: repeated playback has no duplicate event, job, subscription or execution', async (t) => {
  const service = await runtime(t);
  await service.scenarios.play('copper-lifecycle'); await service.scenarios.playTask;
  const before = (await service.listDecisions({ limit: 50 })).decisions;
  await service.scenarios.play('copper-lifecycle'); await service.scenarios.playTask;
  assert.deepEqual((await service.listDecisions({ limit: 50 })).decisions, before);
  assert.equal(service.ingest.jobs.size, 1); assert.equal(storeState.investments.length, 1);
});

test('Phase 4: two starts and manual steps cannot race a paced run; stop drains and preserves progress', async (t) => {
  const service = await runtime(t); service.scenarios.stepDelayMs = 60_000;
  const first = service.scenarios.play('copper-typhoon');
  await assert.rejects(service.scenarios.play('copper-typhoon'), { code: 'demo_run_active' });
  await first;
  await assert.rejects(service.scenarios.step(), { code: 'demo_run_active' });
  await assert.rejects(service.scenarios.start('copper-lifecycle'), { code: 'demo_run_active' });
  const stopped = await service.scenarios.stopPlayback();
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.active, false);
  const snapshot = structuredClone(stopped.scenario.log);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(service.scenarios.status().log, snapshot);
  assert.equal(storeState.investments.length, 0);
});

test('Phase 4: playback rejects invalid speed/name, Live and non-auto autonomy', async (t) => {
  const service = await runtime(t);
  for (const speed of [0, -1, 11, '1', null, Infinity]) await assert.rejects(service.scenarios.play('copper-typhoon', { speed }), { code: 'invalid_speed' });
  await assert.rejects(service.scenarios.play('../secret'), { code: 'invalid_scenario_name' });
  assert.equal(service.scenarios.playbackStatus().active, false);
  service.autonomyOverride = 'observe';
  await assert.rejects(service.scenarios.play('copper-typhoon'), { code: 'demo_autonomy_required' });
  demoModeController.mode = 'live';
  await assert.rejects(service.scenarios.play('copper-typhoon'), { code: 'demo_only' });
});

test('Phase 4: speed only changes pacing; virtual event times, decisions and quote commitments stay deterministic', async (t) => {
  const service = await runtime(t);
  await service.scenarios.play('copper-typhoon', { speed: 0.5 }); await service.scenarios.playTask;
  const first = service.scenarios.status().log;
  const ids = (await service.listDecisions({ limit: 50 })).decisions.map((decision) => [decision.decision_id, decision.quote_hash]);
  await service.scenarios.play('copper-typhoon', { speed: 10 }); await service.scenarios.playTask;
  assert.deepEqual(service.scenarios.status().log.map((entry) => entry.virtual_time), first.map((entry) => entry.virtual_time));
  assert.deepEqual((await service.listDecisions({ limit: 50 })).decisions.map((decision) => [decision.decision_id, decision.quote_hash]), ids);
});

test('Phase 4: a mode generation change cancels playback before another step or subscription', async (t) => {
  const service = await runtime(t); service.scenarios.stepDelayMs = 60_000;
  await service.scenarios.play('copper-typhoon');
  demoModeController.generation += 1;
  await service.onModeChanged();
  assert.equal(service.scenarios.playbackStatus().state, 'stopped');
  assert.equal(storeState.investments.length, 0);
});

test('Phase 4: references distinguish report payment from decision execution; Demo never inherits a transaction', () => {
  const report = `rpt_${'ab'.repeat(32)}`, payment = `0x${'cd'.repeat(32)}`, execution = `0x${'ef'.repeat(32)}`;
  const decision = { decision_id: 'saved-decision', case_id: copper.case_id, quote_snapshot: { quote_hash: 'saved-quote',
    paid_report_evidence: [{ report_id: report, payment_tx: payment }, { report_id: 'forged' }] },
    execution: { mode: 'demo', tx_hash: execution } };
  const refs = decisionReferences(decision);
  assert.deepEqual(refs.report_ids, [report]); assert.equal(refs.quote_hash, 'saved-quote');
  assert.equal(refs.tx_hash, null); assert.deepEqual(refs.report_payment_txs, [{ report_id: report, tx_hash: payment }]);
  decision.execution.mode = 'chain'; assert.equal(decisionReferences(decision).tx_hash, execution);
});

test('Phase 4 HTTP: historical quote stays saved while latest market, timeline and portfolio share references', async (t) => {
  const service = await runtime(t), app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); });
  const api = (method, path, body, headers) => requestJson(app.base, method, path, body, headers);
  subscribeToPool('0xDemoWallet', copper.case_id, 1000);
  const send = async (id, events) => {
    const event = await service.submitEvent({ type: 'WORLD_RISK_UPDATED', event_id: id, case_id: copper.case_id, source: 'admin',
      occurred_at: '2026-06-12T00:00:00Z', data: { events } });
    await service.waitFor(event.idempotency_key);
    return (await service.listDecisions({ limit: 50 })).decisions[0];
  };
  const first = await send('first', weather), saved = structuredClone(first.quote_snapshot);
  await send('second', [{ ...weather[0], severity: 'critical' }]);
  assert.deepEqual((await service.getDecision(first.decision_id)).quote_snapshot, saved);
  const latest = (await api('GET', '/api/agent/references')).data.decisions[0];
  const list = (await api('GET', '/api/agent/decisions')).data.decisions[0];
  const detail = (await api('GET', `/api/agent/decisions/${latest.decision_id}`)).data.decision;
  const investment = (await api('GET', '/api/investors/portfolio?wallet_address=0xDemoWallet')).data.investments[0];
  assert.deepEqual(latest.references, list.references); assert.deepEqual(latest.references, detail.references);
  assert.deepEqual(latest.references, investment.references);
  demoModeController.generation += 1;
  assert.equal((await api('GET', '/api/agent/references')).data.decisions.length, 0);
  demoModeController.mode = 'live';
  assert.equal((await api('GET', '/api/agent/references')).data.pools.length, 0, 'unmapped Demo pools cannot be presented as Live chain mirrors');
});

test('Phase 4 HTTP: playback is asynchronous, admin-protected when configured, and rejects Live', async (t) => {
  const service = await runtime(t), app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); });
  const api = (method, path, body, headers) => requestJson(app.base, method, path, body, headers);
  process.env.AGENTBL_ADMIN_TOKEN = 'phase-four-test-token-long-enough';
  assert.equal((await api('POST', '/api/agent/demo/run', {})).status, 401);
  const headers = { authorization: `Bearer ${process.env.AGENTBL_ADMIN_TOKEN}` };
  assert.equal((await api('POST', '/api/agent/demo/run', { speed: 'fast' }, headers)).status, 400);
  assert.equal((await api('POST', '/api/agent/demo/run', { reset: true }, headers)).status, 400);
  const started = await api('POST', '/api/agent/demo/run', { scenario: 'copper-typhoon', speed: 10 }, headers);
  assert.equal(started.status, 202); await service.scenarios.playTask;
  assert.equal((await api('GET', '/api/agent/demo/run')).data.run.state, 'completed');
  assert.equal((await api('POST', '/api/agent/demo/stop', {}, headers)).status, 200);
  demoModeController.mode = 'live';
  assert.equal((await api('POST', '/api/agent/demo/run', {}, headers)).status, 409);
  assert.equal((await api('POST', '/api/agent/demo/stop', {}, headers)).status, 409);
});

test('Phase 4: actual provider usage reaches valuation metadata without changing or leaking into chat messages', async (t) => {
  const env = { LLM_BASE_URL: 'http://local-fixture.invalid/v1', LLM_API_KEY: 'local-fixture-only', LLM_MODEL: 'fixture-model' };
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    messages.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Local explanation.' } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, api_key: 'must-not-persist' } }), { status: 200 });
  });
  const message = await chatCompletion({ messages: [{ role: 'user', content: 'Fixture input' }] }, env);
  assert.deepEqual(JSON.parse(JSON.stringify(message)), { role: 'assistant', content: 'Local explanation.' });
  assert.deepEqual(completionMetadata(message).tokens, { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
  assert.doesNotMatch(JSON.stringify(completionMetadata(message)), /must-not-persist|local-fixture-only/u);
  const report = await runValuationAgent(copper, { env });
  assert.equal(report.model_usage[0].model, 'fixture-model');
  assert.equal(report.model_usage[0].provider, 'custom'); assert.ok(report.model_usage[0].latency_ms >= 0);
  assert.equal(report.model_usage[0].tokens.total_tokens, 20);
  assert.ok(messages.every((body) => body.model === 'fixture-model'));
});

test('Phase 4: mode switching during event initialization rejects the old scenario before bus submission', async (t) => {
  const service = await runtime(t);
  let release;
  service.init = () => new Promise((resolve) => { release = resolve; });
  const submitted = service.submitEvent({ type: 'CARGO_DEPARTED', source: 'scenario', case_id: copper.case_id });
  demoModeController.mode = 'live'; demoModeController.generation += 1;
  release(service);
  await assert.rejects(submitted, { code: 'mode_changed' });
  assert.equal(service.bus.status().queued, 0);
  assert.equal((await service.listDecisions({ limit: 50 })).count, 0);
});
