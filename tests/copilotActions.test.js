import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CopilotService } from '../src/copilot/service.js';
import { usdMicros } from '../src/copilot/actions.js';
import { executeAction } from '../web/src/lib/copilot-actions.js';
import { createPool, resetStore, storeState, subscribeToPool } from '../src/app/store.js';
import { listen, requestJson, clearLlmEnv } from './helpers/http.js';
import { pool } from './helpers/copilot.js';

function fixture(extra = {}) {
  resetStore(); const candidate = pool('C');
  createPool('C', candidate.caseData, candidate.quote, { createdAt: new Date(0).toISOString() });
  const service = new CopilotService({ getPools: async () => [...storeState.pools.values()], getDecisions: async () => [],
    now: () => 0, env: {}, llmConfigured: () => false,
    subscribeDemo: (wallet, poolId, amount, source) => subscribeToPool(wallet, poolId, amount, { source }), ...extra });
  const query = (context, message = 'subscribe USD 1000', options = {}) => service.query({ message, pool_ids: ['C'], ...options }, { sessionId: context.session_id });
  return { service, query };
}

test('Copilot actions: a message creates a priced card, explicit confirmation records one real Demo position, and retries return the same reference', async () => {
  const { service, query } = fixture(); const context = await service.create();
  const response = await query(context), action = response.action_proposal;
  assert.equal(action.price_usd, 0.8); assert.equal(action.amount_usd, 1000); assert.equal(action.shares, '1250');
  assert.equal(storeState.investments.length, 0);
  await assert.rejects(service.confirmAction(context.session_id, action.id, {}), { code: 'confirmation_required' });
  const results = await Promise.all([1, 2].map(() => service.confirmAction(context.session_id, action.id, { confirm: true })));
  assert.equal(storeState.investments.length, 1); assert.equal(results[0].reference, results[1].reference);
  assert.equal(results[0].txHash, null); assert.match(results[0].reference, /^demo:sub:/u);
  assert.equal(storeState.investments[0].source.kind, 'COPILOT');
});

test('Copilot actions: ambiguity, missing amounts, model amounts and saved budget breaches cannot create executable cards', async () => {
  const { service, query } = fixture(); const context = await service.create();
  assert.equal((await query(context, 'subscribe')).action_proposal.blocked, 'amount_required');
  await service.query({ message: 'budget USD 1000' }, { sessionId: context.session_id });
  assert.equal((await query(context, 'subscribe USD 1001')).action_proposal.blocked, 'budget_exceeded');
  assert.equal((await query(context, 'subscribe')).action_proposal.amount_usd, 1000);
  createPool('A', pool('A', { commodity: 'Aluminium' }).caseData, pool('A').quote, { createdAt: new Date(0).toISOString() });
  assert.equal((await service.query({ message: 'subscribe USD 1000' }, { sessionId: context.session_id })).action_proposal.blocked, 'select_pool');
  const model = fixture({ llmConfigured: () => true, chatFn: async () => ({ content: '{"intent":"ACTION_SUBSCRIBE","constraints_delta":{"ticket_usd":999},"confidence":0.9}' }) });
  const modelContext = await model.service.create();
  assert.equal((await model.query(modelContext, 'subscribe')).action_proposal.blocked, 'amount_required');
});

test('Copilot actions: cancel, new messages, expiry and runtime changes invalidate old consent', async () => {
  let now = 0, mode = { demoMode: true, generation: 0 };
  const { service, query } = fixture({ now: () => now, runtimeMode: () => mode }); const context = await service.create();
  let action = (await query(context)).action_proposal;
  await service.cancelAction(context.session_id, action.id);
  await assert.rejects(service.confirmAction(context.session_id, action.id, { confirm: true }), { code: 'action_not_pending' });
  action = (await query(context)).action_proposal;
  await service.query({ message: 'copper' }, { sessionId: context.session_id });
  await assert.rejects(service.confirmAction(context.session_id, action.id, { confirm: true }), { code: 'action_superseded' });
  action = (await query(context)).action_proposal; now = 300_001;
  await assert.rejects(service.confirmAction(context.session_id, action.id, { confirm: true }), { code: 'action_expired' });
  now = 0; action = (await query(context)).action_proposal; mode = { demoMode: false, generation: 1 };
  await assert.rejects(service.confirmAction(context.session_id, action.id, { confirm: true }), { code: 'session_mode_changed' });
  assert.equal(storeState.investments.length, 0);
});

test('Copilot actions: changed prices, capacity, pauses and unresolved document holds are checked again before mutation', async () => {
  for (const change of ['price', 'capacity', 'pause', 'hold']) {
    const decisions = [];
    const { service, query } = fixture({ getDecisions: async () => decisions }); const context = await service.create();
    const action = (await query(context)).action_proposal, candidate = storeState.pools.get('C');
    if (change === 'price') candidate.quote.final_issue_price_usd = 0.7;
    if (change === 'capacity') candidate.subscribedUsd = candidate.targetUsd - 500;
    if (change === 'pause') candidate.status = 'Paused';
    if (change === 'hold') decisions.unshift({ pool_id: 'C', action: 'HOLD_FOR_REVIEW', decision_id: 'D1' });
    await assert.rejects(service.confirmAction(context.session_id, action.id, { confirm: true }), { status: 409 });
    assert.equal(storeState.investments.length, 0, change);
  }
});

test('Copilot actions: Demo subscriptions accept repriced pools and snapshots persist without wallets', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-actions-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sessions.json');
  const { service, query } = fixture({ file }); const context = await service.create();
  storeState.pools.get('C').status = 'Repriced';
  const action = (await query(context)).action_proposal;
  await service.confirmAction(context.session_id, action.id, { confirm: true, wallet_address: '0xPrivateWallet' });
  const contents = await fs.readFile(file, 'utf8'); assert.doesNotMatch(contents, /PrivateWallet/u);
  const recovered = new CopilotService({ file, now: () => 0, env: {}, getPools: service.getPools });
  assert.equal((await recovered.get(context.session_id)).action.status, 'COMPLETED');
});

test('Copilot actions: Live cards use chain price and integer shares; confirmation only prepares the wallet and cannot run twice', async () => {
  let chain = { pool_id: 2, chain_id: 1439, contract: '0x1111111111111111111111111111111111111111', price_e6: '900000', remaining_shares: '10000', status: 'Open', exists: true, emergency_stopped: false };
  const { service, query } = fixture({ runtimeMode: () => ({ demoMode: false, generation: 1 }), getLiveOffering: async () => chain });
  const context = await service.create(); const action = (await query(context)).action_proposal;
  assert.equal(action.price_usd, 0.9); assert.equal(action.shares, '1111'); assert.equal(action.amount_usd, 999.9);
  const confirmed = await service.confirmAction(context.session_id, action.id, { confirm: true });
  assert.equal(confirmed.action.status, 'CONFIRMING'); assert.equal(storeState.investments.length, 0);
  await assert.rejects(service.confirmAction(context.session_id, action.id, { confirm: true }), { code: 'action_not_pending' });
  const newer = (await query(context)).action_proposal; chain = { ...chain, price_e6: '950000' };
  await assert.rejects(service.confirmAction(context.session_id, newer.id, { confirm: true }), { code: 'quote_changed' });
});

test('Copilot actions: unmapped, paused, empty and tiny Live offerings fail closed without a simulated substitute', async () => {
  for (const chain of [null, { exists: true, status: 'Paused' },
    { exists: true, status: 'Open', price_e6: '800000', remaining_shares: '1' },
    { exists: true, status: 'Open', price_e6: '9000000000', remaining_shares: '10000' }]) {
    const { service, query } = fixture({ runtimeMode: () => ({ demoMode: false, generation: 1 }), getLiveOffering: async () => chain });
    const context = await service.create(); const result = await query(context);
    assert.ok(result.action_proposal.blocked); assert.equal(result.action_proposal.id, undefined);
    // A research case without an on-chain pool points to the wallet flow; it is not reported as a chain outage.
    if (chain === null) assert.equal(result.action_proposal.blocked, 'live_wallet_flow');
    assert.equal(storeState.investments.length, 0);
  }
});

test('Copilot actions: report cards use the paid-service catalogue, enforce budget and become single-use before any payment', async () => {
  const { service, query } = fixture(); const context = await service.create();
  const action = (await query(context, 'buy report', { service_id: 'premium-valuation' })).action_proposal;
  assert.equal(action.amount_usd, 0.002); assert.equal(action.endpoint, '/api/x402/valuation/premium');
  const confirmed = await service.confirmAction(context.session_id, action.id, { confirm: true });
  assert.equal(confirmed.caseData.case_id, 'C'); assert.equal(confirmed.action.status, 'CONFIRMING');
  await assert.rejects(service.confirmAction(context.session_id, action.id, { confirm: true }), { code: 'action_not_pending' });
  await service.query({ message: 'budget USD 0.001' }, { sessionId: context.session_id });
  assert.equal((await query(context, 'buy report', { service_id: 'premium-valuation' })).action_proposal.blocked, 'budget_exceeded');
  await assert.rejects(query(context, 'buy report', { service_id: 'not-a-service' }), { status: 400 });
});

test('Copilot browser actions: generation changes after preparation prevent wallet signing; Demo reports use the existing simulated flow', async () => {
  const context = { session_id: 'S' }, action = { id: 'A', type: 'ACTION_SUBSCRIBE', mode: 'live' };
  let changed = false, signed = false;
  await assert.rejects(executeAction(context, action, { assertCurrent: () => { if (changed) throw new Error('changed'); },
    postFn: async () => { changed = true; return { action }; }, subscribeFn: async () => { signed = true; } }), /changed/u);
  assert.equal(signed, false);
  const requests = [];
  const result = await executeAction(context, { id: 'R', type: 'ACTION_BUY_REPORT', mode: 'demo', service_id: 'premium-risk' }, {
    postFn: async (url, body) => { requests.push({ url, body }); return requests.length === 1
      ? { caseData: { case_id: 'C' } } : { report_envelope: { report_id: 'rpt_demo' } }; }
  });
  assert.equal(requests[0].body.confirm, true); assert.equal(requests[1].url, '/api/x402/smoke');
  assert.equal(requests[1].body.case.case_id, 'C'); assert.equal(result.reference, 'rpt_demo'); assert.equal(result.mode, 'demo');
});

test('Copilot actions: decimal and scientific budgets never round up; legacy Demo report hashes are not rendered as transactions', async () => {
  assert.equal(usdMicros(1000.0000009), 1000000000n);
  assert.equal(usdMicros(1e12), 1000000000000000000n);
  assert.equal(usdMicros(1e-7), 0n);
  const result = await executeAction({ session_id: 'S' }, { id: 'R', type: 'ACTION_BUY_REPORT', mode: 'demo' }, {
    postFn: async (url) => url === '/api/x402/smoke' ? { payment: { txHash: 'synthetic', receipt: { paymentRef: 'x402:ref' }, mode: 'demo' }, steps: [{ txHash: 'synthetic', mode: 'demo' }] } : { caseData: {} }
  });
  assert.equal(result.reference, 'demo:x402:ref'); assert.equal(result.report.payment.txHash, undefined);
  assert.equal(result.report.steps[0].txHash, undefined);
});

test('Copilot actions API: the real subscribe route accepts a confirmed card, ignores tampered amounts and records Copilot attribution', async (t) => {
  clearLlmEnv();
  const { createServer, copilotService, closeActivityStreams } = await import('../src/app/server.js');
  resetStore(); t.after(() => { closeActivityStreams(); copilotService.closeStreams(); resetStore(); });
  const candidate = pool('C'); createPool('C', candidate.caseData, candidate.quote);
  copilotService.llmConfigured = () => false;
  const server = await listen(createServer()); t.after(server.close);
  const context = (await requestJson(server.base, 'POST', '/api/copilot/sessions', {})).data.context;
  const query = await requestJson(server.base, 'POST', `/api/copilot/sessions/${context.session_id}/messages`, { message: 'subscribe USD 1000', pool_ids: ['C'] });
  assert.equal(query.status, 200); assert.equal(storeState.investments.length, 0);
  const action = query.data.action_proposal;
  const body = { confirm: true, amount_usd: 9999, pool_id: 'tampered', copilot_action: { session_id: context.session_id, action_id: action.id } };
  const confirmed = await requestJson(server.base, 'POST', '/api/pool/subscribe', body);
  assert.equal(confirmed.status, 200); assert.equal(confirmed.data.amountUsd, 1000);
  assert.equal(storeState.investments[0].poolId, 'C'); assert.equal(storeState.investments[0].source.kind, 'COPILOT');
  assert.equal((await requestJson(server.base, 'POST', '/api/pool/subscribe', body)).data.reference, confirmed.data.reference);
  assert.equal(storeState.investments.length, 1);
});
