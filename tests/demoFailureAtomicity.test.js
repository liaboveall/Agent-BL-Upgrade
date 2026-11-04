// Assessment 2026-11-04: F04 (a failed Demo payment left a payment proof behind, so the valid retry failed) and C01 (the
// workspace cookie lost Secure behind an HTTPS-terminating proxy). Both are checked through the real entry points: the
// event normalizer, the AgentService approval path, the Demo executor and the HTTP server's final Set-Cookie header.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createPool, resetStore, storeState } from '../src/app/store.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { createAgentService } from '../src/agent/runtime/factory.js';
import { EventValidationError, normalizeEvent } from '../src/agent/runtime/events.js';
import { SimExecutor } from '../src/agent/runtime/executors/simExecutor.js';
import { secureTransport, workspaceOwner } from '../src/app/workspaceAccess.js';
import { createServer } from '../src/app/server.js';
import { getRaw, listen } from './helpers/http.js';

const data = JSON.parse(await fs.readFile(new URL('../data/cases/ironore-au-tj.case.json', import.meta.url), 'utf8'));
const event = (type, amount, extra = {}) => ({ type, case_id: data.case_id, source: 'admin', data: { payment_proof: 'proof', repayment_amount: amount, ...extra } });

test('F04 a zero or malformed repayment is refused in either spelling before it reaches the agent', () => {
  for (const amount of ['0', '0.0', '0.000000', '00', '-1', '1.0000001', '', 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const type of ['PAYMENT_RECEIVED', 'SETTLEMENT_READY']) assert.throws(() => normalizeEvent(event(type, amount)), EventValidationError, `${type} ${String(amount)}`);
  }
  for (const amount of ['5', '0.000001', '12.5', 5, 0.5]) assert.equal(normalizeEvent(event('PAYMENT_RECEIVED', amount)).data.repayment_amount, amount);
});

function runningPool(settlement) {
  return { poolId: 'p', status: 'InTransit', subscribedUsd: 4, subscribedShares: 5, tokenSupply: 10, fundingFinalized: true, controlVersion: 4,
    simulationPolicy: 'controlled_terms', quote: { final_issue_price_usd: 0.8 }, redemptionValueUsd: 1, quoteVersion: 1, ...(settlement ? { settlement } : {}) };
}
const command = (action, key, params) => ({ action, pool_id: 'p', decision_id: `decision_${key}`, idempotency_key: key, params });

test('F04 a refused Demo action changes nothing, a corrected retry succeeds, and a repeated success records once', async () => {
  const pool = runningPool({ arrival_proof: 'arrived' });
  const executor = new SimExecutor({ store: { pools: new Map([['p', pool]]) } });
  const before = structuredClone(pool);
  const refused = [{ payment_proof: 'x', repayment_amount: 0 }, { payment_proof: 'x', repayment_amount: '0' }, { payment_proof: '', repayment_amount: 5 },
    { payment_proof: 'x', repayment_amount: 'abc' }, { payment_proof: 'x', repayment_amount: -2 }, { payment_proof: 'x' }];
  for (const [index, params] of refused.entries()) {
    await assert.rejects(executor.execute(command('RECORD_PAYMENT', `bad-${index}`, params)), { code: 'proof_required' });
    assert.deepEqual(pool, before, `attempt ${index} left the pool unchanged`);
  }
  const done = await executor.execute(command('RECORD_PAYMENT', 'good', { payment_proof: 'pay-1', repayment_amount: '5' }));
  assert.equal(done.success, true);
  assert.deepEqual([pool.settlement.payment_proof, pool.settlement.repayment_amount, pool.settlement.arrival_proof], ['pay-1', 5, 'arrived']);
  const recorded = structuredClone(pool);
  // The same command again is the same result, not a second record; another payment event is refused without effect.
  assert.equal((await executor.execute(command('RECORD_PAYMENT', 'good', { payment_proof: 'pay-1', repayment_amount: '5' }))).duplicate, true);
  await assert.rejects(executor.execute(command('RECORD_PAYMENT', 'again', { payment_proof: 'pay-2', repayment_amount: '6' })), { code: 'already_recorded' });
  assert.deepEqual(pool, recorded);
});

test('F04 a refused arrival record and a refused OPEN of a new pool leave nothing behind', async () => {
  const pool = runningPool();
  const store = { pools: new Map([['p', pool]]) }, executor = new SimExecutor({ store });
  const before = structuredClone(pool);
  await assert.rejects(executor.execute(command('RECORD_ARRIVAL', 'arrival', { arrival_proof: '' })), { code: 'proof_required' });
  assert.deepEqual(pool, before);
  // A quote that maps to Paused cannot be opened: the pool built for it is never stored.
  const quote = { ...quoteFromCase(data, { payout_speed: 'BALANCED' }), pricing_action: 'PAUSE_OFFERING' };
  await assert.rejects(executor.execute({ action: 'OPEN', pool_id: 'fresh', decision_id: 'decision_open', idempotency_key: 'open', params: { case_data: data, quote } }),
    { code: 'illegal_transition' });
  assert.equal(store.pools.has('fresh'), false);
  const opened = await executor.execute({ action: 'OPEN', pool_id: 'fresh', decision_id: 'decision_open2', idempotency_key: 'open2',
    params: { case_data: data, quote: { ...quote, pricing_action: 'OPEN_OFFERING' } } });
  assert.equal(opened.effects.state_after, 'Open'); assert.equal(store.pools.get('fresh').status, 'Open');
});

test('F04 through the AgentService: the zero event is refused, the valid payment then records once', async (t) => {
  resetStore(); storeState.agentActivities = [];
  const pool = createPool(data.case_id, data, quoteFromCase(data, { payout_speed: 'BALANCED' }));
  Object.assign(pool, { subscribedUsd: 4, subscribedShares: 5, status: 'InTransit', fundingFinalized: true });
  const service = createAgentService({ env: { NODE_TEST_CONTEXT: 'isolated-agent-review', REAL_DATA: 'off', LLM_PROXY_ENABLED: 'false' },
    config: loadAgentConfig({ AGENT_COOLDOWN_SEC: '0' }), store: storeState, getMode: () => 'demo', getGeneration: () => 1, sleep: async () => {} });
  await service.start(); t.after(() => service.stop());
  const raw = (id, amount) => ({ type: 'PAYMENT_RECEIVED', event_id: id, case_id: data.case_id, source: 'admin', data: { payment_proof: id, repayment_amount: amount } });
  await assert.rejects(service.submitEvent(raw('zero', '0'), { origin: 'api' }), { code: 'invalid_event' });
  assert.equal(pool.settlement, undefined, 'a refused event never reaches the pool');
  const approve = async () => {
    await service.bus.idle();
    const pending = service.approvals.list({ status: 'PENDING' }).find((approval) => approval.action === 'RECORD_PAYMENT');
    return pending ? (await service.approve(pending.approval_id)).decision : null;
  };
  assert.equal((await service.submitEvent(raw('valid', '5'), { origin: 'api' })).accepted, true);
  const decision = await approve();
  assert.notEqual(decision.status, 'FAILED', JSON.stringify(decision.error));
  assert.deepEqual([pool.settlement.payment_proof, pool.settlement.repayment_amount], ['valid', 5]);
  const recorded = structuredClone(pool.settlement);
  // Resubmitting the same occurrence is deduplicated; nothing new waits for approval and nothing changes.
  await service.submitEvent(raw('valid', '5'), { origin: 'api' });
  assert.equal(await approve(), null);
  assert.deepEqual(pool.settlement, recorded);
  // A different payment event after a recorded one fails as already recorded and changes nothing.
  await service.submitEvent(raw('second', '6'), { origin: 'api' });
  const second = await approve();
  assert.deepEqual([second.status, second.error?.code], ['FAILED', 'already_recorded']);
  assert.deepEqual(pool.settlement, recorded);
});

test('C01 Secure follows the transport the browser used, read from a declared proxy only', () => {
  const request = (headers = {}, encrypted = false) => ({ headers, socket: { encrypted } });
  assert.equal(secureTransport(request({}, true), {}), true);
  assert.equal(secureTransport(request(), {}), false);
  // Without a declared proxy the header is the client's own claim and changes nothing.
  assert.equal(secureTransport(request({ 'x-forwarded-proto': 'https' }), {}), false);
  assert.equal(secureTransport(request({ 'x-forwarded-proto': 'https' }), { TRUST_PROXY: '1' }), true);
  assert.equal(secureTransport(request({ 'x-forwarded-proto': 'http' }), { TRUST_PROXY: '1' }), false);
  // The trusted hop's entry decides; a value the client prepended does not.
  assert.equal(secureTransport(request({ 'x-forwarded-proto': 'http, https' }), { TRUST_PROXY: '1' }), true);
  assert.equal(secureTransport(request({ 'x-forwarded-proto': 'https, http' }), { TRUST_PROXY: '1' }), false);
  assert.equal(secureTransport(request({ 'x-forwarded-proto': 'https, http' }), { TRUST_PROXY: '2' }), true);
  // An operator who serves only HTTPS says so once.
  assert.equal(secureTransport(request(), { AGENTBL_COOKIE_SECURE: 'true' }), true);
  const headers = {};
  workspaceOwner(request({ 'x-forwarded-proto': 'https' }), { setHeader: (name, value) => { headers[name] = value; } }, { TRUST_PROXY: '1' });
  assert.match(headers['Set-Cookie'], /^agentbl_workspace=[a-f0-9]{48}; Path=\/; HttpOnly; SameSite=Strict; Secure$/u);
});

test('C01 the server\'s final Set-Cookie carries Secure behind a declared HTTPS proxy and not on plain local HTTP', async (t) => {
  const saved = { TRUST_PROXY: process.env.TRUST_PROXY, AGENTBL_COOKIE_SECURE: process.env.AGENTBL_COOKIE_SECURE };
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  delete process.env.AGENTBL_COOKIE_SECURE;
  const app = await listen(createServer());
  t.after(() => app.close());
  const cookie = async (headers) => {
    const response = await getRaw(app.base, '/api/agent/workspace/copies/CASE-EBL-CU-SIN-SHA', { headers });
    assert.equal(response.status, 200, response.body.toString());
    return [response.headers['set-cookie']].flat()[0];
  };
  delete process.env.TRUST_PROXY;
  assert.doesNotMatch(await cookie({ 'x-forwarded-proto': 'https' }), /Secure/u, 'an undeclared proxy header is ignored');
  process.env.TRUST_PROXY = '1';
  const secure = await cookie({ 'x-forwarded-proto': 'https' });
  assert.match(secure, /HttpOnly/u); assert.match(secure, /SameSite=Strict/u); assert.match(secure, /; Secure$/u);
  assert.doesNotMatch(await cookie({ 'x-forwarded-proto': 'http' }), /Secure/u);
});
