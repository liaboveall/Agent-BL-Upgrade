import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Interface } from 'ethers';
import { createPool, resetStore, storeState } from '../src/app/store.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { ChainExecutor } from '../src/agent/runtime/executors/chainExecutor.js';
import { createAgentService, loadChainConfig } from '../src/agent/runtime/factory.js';
import { LIVE_ADMIN_EVENT_TYPES } from '../src/agent/runtime/agentService.js';

const readCase = async (name) => JSON.parse(await fs.readFile(new URL(`../data/cases/${name}.case.json`, import.meta.url), 'utf8'));
const iron = await readCase('ironore-au-tj');
// The historical copper case is the one testnet pool #2 was opened from.
const copper = await readCase('archive/copper-sg-shanghai-2026-06');

const typhoon = [{ type: 'severe_weather', region: 'East China Sea', severity: 'warning', description: 'typhoon', date: '2026-10-12' }];
const warCrisis = [
  { type: 'war_risk', region: 'Strait of Hormuz', severity: 'critical', description: 'closure', date: '2026-10-12' },
  { type: 'severe_weather', region: 'East China Sea', severity: 'critical', description: 'storm', date: '2026-10-12' }
];

const ev = (type, extra = {}) => ({ type, case_id: iron.case_id, source: 'admin', ...extra });

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-svc-'));
}

/** A Demo-mode service over a fresh pool store. */
async function demoService({ configEnv = {}, dir, withIron = true } = {}) {
  resetStore();
  storeState.agentActivities = []; // the feed's buffer lives on the shared store
  if (withIron) createPool(iron.case_id, iron, quoteFromCase(iron, { payout_speed: 'BALANCED' }));
  const runtime = { mode: 'demo', generation: 1 };
  const service = createAgentService({
    config: loadAgentConfig({ AGENT_COOLDOWN_SEC: '0', ...configEnv }),
    dir,
    store: storeState,
    getMode: () => runtime.mode,
    getGeneration: () => runtime.generation,
    chainConfig: loadChainConfig(),
    sleep: async () => {}
  });
  await service.start();
  return { service, runtime, pool: () => storeState.pools.get(iron.case_id) };
}

async function settle(service, raw, options) {
  const result = await service.submitEvent(raw, options);
  await service.bus.idle();
  return result;
}

const lastDecision = async (service) => (await service.listDecisions()).decisions[0];
const actions = (service) => service.activity.list({ limit: 1000 }).map((r) => r.action);

// ---------------------------------------------------------------- Demo: the Phase 1 gate

test('Demo: a world-risk event becomes a decision, an executed simulated reprice, activity and a trace', async () => {
  const { service, pool } = await demoService();
  const before = pool().quote.final_issue_price_usd;
  const submitted = await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'e1', data: { events: typhoon } }));
  assert.equal(submitted.accepted, true);
  assert.equal(service.bus.get('event:e1').status, 'DONE');

  const decision = await lastDecision(service);
  assert.equal(decision.action, 'REPRICE');
  assert.equal(decision.status, 'COMPLETED');
  assert.equal(decision.mode, 'demo');
  assert.equal(decision.policy.verdict, 'AUTO');
  assert.ok(decision.policy.reasons.some((r) => r.rule === 'AUTONOMY_LEVEL'));
  assert.match(decision.decision_id, /^decision_[0-9a-f]{24}$/u);
  assert.match(decision.evidence_hash, /^0x[0-9a-f]{64}$/u);
  assert.ok(decision.pipeline.map((step) => step.step).includes('world_risk_reprice'));
  assert.ok(decision.pipeline.map((step) => step.step).includes('policy'));
  assert.ok(decision.reasoning_summary.length > 10);

  // the simulated execution: a demo reference, never a transaction
  assert.equal(decision.execution.mode, 'demo');
  assert.match(decision.execution.reference, /^demo:/u);
  assert.equal(decision.execution.tx_hash, undefined);
  assert.equal(decision.execution.explorer_url, undefined);
  assert.equal(decision.execution.effects.state_after, 'Repriced');

  // the offchain pool really changed
  assert.equal(pool().status, 'Repriced');
  assert.ok(pool().quote.final_issue_price_usd < before);
  assert.equal(pool().quote.final_issue_price_usd, decision.proposal.new_issue_price_usd);

  // activity: monotonic seq, the decision verbs, no tx fields in Demo
  const records = service.activity.list({ limit: 100 });
  const seqs = records.map((r) => r.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  const made = records.find((r) => r.action === 'DECISION_MADE');
  assert.equal(made.decision_id, decision.decision_id);
  assert.equal(made.details.decision_action, 'REPRICE');
  assert.deepEqual(actions(service).filter((a) => a.startsWith('EXECUTION')), ['EXECUTION_SUBMITTED', 'EXECUTION_CONFIRMED']);
  for (const record of records) {
    assert.equal(record.tx_hash, undefined);
    assert.equal(record.explorer_url, undefined);
  }
  assert.equal(records.find((r) => r.action === 'EXECUTION_CONFIRMED').reference, decision.execution.reference);

  // trace
  const trace = await service.getTrace(decision.decision_id);
  assert.equal(trace.decision_id, decision.decision_id);
  assert.equal(trace.status, 'ok');
  assert.deepEqual(trace.spans.map((s) => s.name).sort(), ['execute', 'monitor_pipeline', 'policy']);
  assert.ok(trace.spans.every((s) => Number.isFinite(s.duration_ms)));
});

test('Demo: injecting the same event again never produces a second execution', async () => {
  const { service } = await demoService();
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'dup', data: { events: typhoon } }));
  const again = await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'dup', data: { events: typhoon } }));
  assert.equal(again.duplicate, true);
  assert.equal((await service.listDecisions()).count, 1);
  assert.equal(actions(service).filter((a) => a === 'EXECUTION_CONFIRMED').length, 1);
  assert.equal(service.sim.done.size, 1);
});

test('Demo: the full risk cycle reprice → pause → resume restores the previous state', async () => {
  const { service, pool } = await demoService();
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'r1', occurred_at: '2026-10-12T10:00:00Z', data: { events: typhoon } }));
  assert.equal(pool().status, 'Repriced');
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'r2', occurred_at: '2026-10-12T10:05:00Z', data: { events: warCrisis } }));
  assert.equal(pool().status, 'Paused');
  await settle(service, ev('RISK_CLEARED', { event_id: 'r3', occurred_at: '2026-10-12T10:10:00Z' }));
  assert.equal(pool().status, 'Repriced', 'RESUME returns the pool to the state before the pause');
  const decisions = (await service.listDecisions()).decisions.reverse().map((d) => [d.action, d.status]);
  assert.deepEqual(decisions, [['REPRICE', 'COMPLETED'], ['PAUSE', 'COMPLETED'], ['RESUME', 'COMPLETED']]);
});

test('Demo: events that change nothing are ignored with a reason, not turned into decisions', async () => {
  const { service } = await demoService();
  await settle(service, ev('RISK_CLEARED', { event_id: 'c1' })); // not paused
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'c2', data: { events: [] } })); // no change
  await settle(service, { type: 'RISK_CLEARED', case_id: 'CASE-UNKNOWN', source: 'admin', event_id: 'c3' });
  assert.equal((await service.listDecisions()).count, 0);
  const ignored = service.activity.list({ limit: 100 }).filter((r) => r.action === 'EVENT_IGNORED');
  assert.equal(ignored.length, 3);
  assert.match(ignored[0].details.reason, /not Paused/u);
  assert.match(ignored[2].details.reason, /No pool is known/u);
});

test('invalid events are refused before they are queued', async () => {
  const { service } = await demoService();
  await assert.rejects(service.submitEvent({ type: 'NOPE', case_id: 'x', source: 'admin' }), { code: 'invalid_event' });
  await assert.rejects(service.submitEvent(ev('PAYMENT_RECEIVED', { data: {} })), /payment_proof/u);
  assert.equal(service.bus.status().queued, 0);
});

// ---------------------------------------------------------------- Demo: policy and approvals

test('policy: a price move above the cap waits for approval; approving it executes, rejecting does not', async () => {
  const { service, pool } = await demoService({ configEnv: { AGENT_MAX_PRICE_MOVE_BPS: '10' } });
  const before = pool().quote.final_issue_price_usd;
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'big1', occurred_at: '2026-10-12T10:00:00Z', data: { events: typhoon } }));
  const pending = await lastDecision(service);
  assert.equal(pending.status, 'PENDING_APPROVAL');
  assert.equal(pending.policy.verdict, 'NEEDS_APPROVAL');
  assert.ok(pending.policy.reasons.some((r) => r.rule === 'PRICE_GUARD'));
  assert.equal(pool().quote.final_issue_price_usd, before, 'nothing ran yet');
  const [approval] = service.approvals.list({ status: 'PENDING' });
  assert.equal(approval.route, 'sim');
  assert.equal(approval.decision_id, pending.decision_id);
  assert.ok(actions(service).includes('APPROVAL_REQUESTED'));

  const approved = await service.approve(approval.approval_id, { by: 'admin' });
  assert.equal(approved.approval.status, 'EXECUTED');
  assert.equal(approved.decision.status, 'COMPLETED');
  assert.match(approved.decision.execution.reference, /^demo:/u);
  assert.equal(pool().status, 'Repriced');
  assert.ok(pool().quote.final_issue_price_usd < before);
  assert.ok(actions(service).includes('APPROVAL_GRANTED'));
  await assert.rejects(service.approve(approval.approval_id), { code: 'invalid_transition' });

  // a second proposal that is rejected leaves the pool as it was
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'big2', occurred_at: '2026-10-12T11:00:00Z', data: { events: warCrisis } }));
  const second = await lastDecision(service);
  assert.equal(second.action, 'PAUSE');
  assert.equal(second.status, 'COMPLETED', 'PAUSE has no price move, so the guard does not apply');
});

test('policy: rejecting a pending proposal records it and changes nothing', async () => {
  const { service, pool } = await demoService({ configEnv: { AGENT_MAX_PRICE_MOVE_BPS: '10' } });
  const before = pool().quote.final_issue_price_usd;
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'rej', data: { events: typhoon } }));
  const [approval] = service.approvals.list({ status: 'PENDING' });
  const result = await service.reject(approval.approval_id, { by: 'admin', note: 'not now' });
  assert.equal(result.approval.status, 'REJECTED');
  assert.equal(result.decision.status, 'REJECTED');
  assert.equal(pool().quote.final_issue_price_usd, before);
  assert.equal(pool().status, 'Open');
  assert.ok(actions(service).includes('APPROVAL_REJECTED'));
});

test('policy: observe and off modes never execute; set_autonomy changes it at runtime and is logged', async () => {
  const { service, pool } = await demoService();
  await service.control({ action: 'set_autonomy', autonomy: 'observe' });
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'o1', occurred_at: '2026-10-12T10:00:00Z', data: { events: typhoon } }));
  assert.equal((await lastDecision(service)).status, 'SKIPPED');
  assert.equal(pool().status, 'Open');

  await service.control({ action: 'set_autonomy', autonomy: 'off' });
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'o2', occurred_at: '2026-10-12T11:00:00Z', data: { events: typhoon } }));
  assert.equal((await lastDecision(service)).status, 'REJECTED');

  await service.control({ action: 'set_autonomy', autonomy: 'auto' });
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'o3', occurred_at: '2026-10-12T12:00:00Z', data: { events: typhoon } }));
  assert.equal((await lastDecision(service)).status, 'COMPLETED');
  assert.equal(actions(service).filter((a) => a === 'AUTONOMY_CHANGED').length, 3);
  await assert.rejects(service.control({ action: 'set_autonomy', autonomy: 'wild' }), { code: 'invalid_autonomy' });
  await assert.rejects(service.control({ action: 'dance' }), { code: 'invalid_action' });
});

test('policy: an emergency stop blocks a reprice but lets a pause through, and can be lifted', async () => {
  const { service, pool } = await demoService();
  await service.control({ action: 'emergency_stop', reason: 'drill' });
  assert.equal((await service.status()).emergency_stop, true);
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'es1', occurred_at: '2026-10-12T10:00:00Z', data: { events: typhoon } }));
  const blocked = await lastDecision(service);
  assert.equal(blocked.status, 'REJECTED');
  assert.ok(blocked.policy.reasons.some((r) => r.rule === 'EMERGENCY_STOP'));
  assert.equal(pool().status, 'Open');
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'es2', occurred_at: '2026-10-12T10:05:00Z', data: { events: warCrisis } }));
  assert.equal(pool().status, 'Paused');
  await service.control({ action: 'emergency_stop', stopped: false });
  assert.equal((await service.status()).emergency_stop, false);
});

test('policy: the cooldown stops a flapping signal from acting twice in a row', async () => {
  const { service } = await demoService({ configEnv: { AGENT_COOLDOWN_SEC: '600' } });
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'f1', occurred_at: '2026-10-12T10:00:00Z', data: { events: typhoon } }));
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'f2', occurred_at: '2026-10-12T10:01:00Z', data: { events: [...typhoon, { ...typhoon[0], region: 'South China Sea', description: 'second storm' }] } }));
  const decisions = (await service.listDecisions()).decisions.reverse();
  assert.deepEqual(decisions.map((d) => [d.action, d.status]), [['REPRICE', 'COMPLETED'], ['REPRICE', 'SKIPPED']]);
  assert.ok(decisions[1].policy.reasons.some((r) => r.rule === 'COOLDOWN'));
});

test('settlement actions: RECORD_PAYMENT always needs approval, RECORD_ARRIVAL does not', async () => {
  const { service, pool } = await demoService();
  pool().subscribedUsd = 1000;
  await settle(service, ev('CARGO_DEPARTED', { event_id: 's0', occurred_at: '2026-10-12T09:00:00Z' }));
  assert.equal(pool().status, 'InTransit');
  await settle(service, ev('CARGO_ARRIVED', { event_id: 's1', occurred_at: '2026-10-12T10:00:00Z', data: { arrival_proof: 'bol-77' } }));
  assert.equal(pool().settlement.arrival_proof, 'bol-77');
  await settle(service, ev('PAYMENT_RECEIVED', { event_id: 's2', occurred_at: '2026-10-12T10:10:00Z', data: { payment_proof: 'wire-9', repayment_amount: 1100 } }));
  const payment = await lastDecision(service);
  assert.equal(payment.action, 'RECORD_PAYMENT');
  assert.equal(payment.status, 'PENDING_APPROVAL');
  assert.ok(payment.policy.reasons.some((r) => r.rule === 'IRREVERSIBLE'));
  const [approval] = service.approvals.list({ status: 'PENDING' });
  await service.approve(approval.approval_id);
  assert.equal(pool().settlement.payment_proof, 'wire-9');
  assert.equal(pool().settlement.repayment_amount, 1100);
});

test('a failing action is recorded as FAILED with its reason, and the event itself still completes', async () => {
  const { service } = await demoService();
  // RECORD_PAYMENT on a pool nobody subscribed to: the executor refuses (no subscribers).
  await settle(service, ev('PAYMENT_RECEIVED', { event_id: 'bad1', data: { payment_proof: 'p', repayment_amount: 5 } }));
  const [approval] = service.approvals.list({ status: 'PENDING' });
  const result = await service.approve(approval.approval_id);
  assert.equal(result.decision.status, 'FAILED');
  assert.equal(result.decision.error.code, 'no_subscribers');
  assert.equal(result.approval.status, 'FAILED');
  assert.ok(actions(service).includes('EXECUTION_FAILED'));
  assert.equal((await service.status()).last_error.message.includes('nobody subscribed'), true);
});

// ---------------------------------------------------------------- status, reads, reset

test('status reports mode, autonomy, signers (booleans only) and queue depth', async () => {
  const { service } = await demoService();
  const status = await service.status();
  assert.equal(status.running, true);
  assert.equal(status.mode, 'demo');
  assert.equal(status.executor, 'sim');
  assert.deepEqual(status.autonomy, { configured: null, effective: 'auto', downgraded: false });
  assert.deepEqual(Object.keys(status.signers).sort(), ['AGENT_EXECUTOR', 'PRICING_UPDATER']);
  for (const signer of Object.values(status.signers)) assert.deepEqual(Object.keys(signer), ['configured']);
  assert.equal(status.pending_approvals, 0);
  assert.deepEqual(status.protected_chain_pools, [2]);
  assert.ok(status.scheduler.next_tick_at, 'a started service has its next tick scheduled');
  await service.stop();
  assert.equal((await service.status()).running, false);
});

test('listDecisions filters and paginates; getDecision returns one', async () => {
  const { service } = await demoService();
  for (let i = 0; i < 3; i += 1) {
    await settle(service, ev('INSURANCE_EXPIRING', { event_id: `w${i}`, occurred_at: `2026-10-12T10:0${i}:00Z`, data: { days_left: 3 - i } }));
  }
  const all = await service.listDecisions();
  assert.equal(all.count, 3);
  const page = await service.listDecisions({ limit: 2 });
  assert.equal(page.decisions.length, 2);
  assert.ok(page.next_cursor);
  const rest = await service.listDecisions({ limit: 2, cursor: page.next_cursor });
  assert.equal(rest.decisions.length, 1);
  assert.equal((await service.listDecisions({ action: 'REPRICE' })).count, 0);
  assert.equal((await service.listDecisions({ case_id: iron.case_id })).count, 3);
  assert.equal((await service.getDecision(all.decisions[0].decision_id)).decision_id, all.decisions[0].decision_id);
  assert.equal(await service.getDecision('decision_nope'), null);
});

test('Demo reset clears the agent state of Demo mode only', async () => {
  const { service, runtime } = await demoService();
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'x1', data: { events: typhoon } }));
  // A Live record that must survive a Demo reset.
  runtime.mode = 'live';
  service.activity.append({ type: 'SYSTEM', action: 'LIVE_NOTE', details: {} });
  await service.logger.record({ decision_id: 'decision_live', case_id: 'C', action: 'WARNING', reasoning_summary: 'live', mode: 'live', status: 'COMPLETED' });
  runtime.mode = 'demo';
  const result = await service.resetDemo();
  // The server's /api/demo/reset also rebuilds the offchain pools; do the same here.
  resetStore();
  createPool(iron.case_id, iron, quoteFromCase(iron, { payout_speed: 'BALANCED' }));
  assert.equal(result.removed_decisions, 1);
  assert.equal((await service.listDecisions()).decisions.map((d) => d.decision_id).join(), 'decision_live');
  assert.equal(service.bus.get('event:x1'), null, 'the event can be injected again');
  assert.deepEqual(service.activity.list({ limit: 100 }).map((r) => r.action), ['LIVE_NOTE']);
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'x1', data: { events: typhoon } }));
  assert.equal((await service.listDecisions()).count, 2);
});

// ---------------------------------------------------------------- persistence

test('decisions, activity, approvals and event state survive a restart; a duplicate stays a duplicate', async () => {
  const dir = await tempDir();
  const first = await demoService({ dir, configEnv: { AGENT_MAX_PRICE_MOVE_BPS: '10' } });
  await first.service.activity.attachFile(path.join(dir, 'agent-activity.jsonl'));
  await settle(first.service, ev('WORLD_RISK_UPDATED', { event_id: 'p1', data: { events: typhoon } }));
  const [approval] = first.service.approvals.list({ status: 'PENDING' });
  const decisionBefore = await lastDecision(first.service);
  const seqBefore = first.service.activity.seq;
  await first.service.stop();
  await first.service.activity.flush();

  const second = await demoService({ dir, configEnv: { AGENT_MAX_PRICE_MOVE_BPS: '10' } });
  await second.service.activity.attachFile(path.join(dir, 'agent-activity.jsonl'));
  const decisionAfter = await lastDecision(second.service);
  assert.equal(decisionAfter.decision_id, decisionBefore.decision_id);
  assert.equal(decisionAfter.status, 'PENDING_APPROVAL');
  assert.equal(second.service.approvals.get(approval.approval_id).status, 'PENDING');
  assert.ok(second.service.activity.list({ limit: 100 }).some((r) => r.action === 'APPROVAL_REQUESTED'), 'activity is still there');

  const again = await second.service.submitEvent(ev('WORLD_RISK_UPDATED', { event_id: 'p1', data: { events: typhoon } }));
  assert.equal(again.duplicate, true);
  assert.equal((await second.service.listDecisions()).count, 1);
  assert.ok(second.service.activity.seq > seqBefore, 'the feed sequence continues instead of restarting');

  // the persisted approval can still be acted on after the restart
  const approved = await second.service.approve(approval.approval_id);
  assert.equal(approved.decision.status, 'COMPLETED');
  for (const file of ['agent-decisions.json', 'agent-approvals.json', 'agent-event-index.json', 'agent-events.jsonl', 'agent-traces.jsonl', 'agent-pools.json', 'agent-activity.jsonl']) {
    await fs.access(path.join(dir, file));
  }
});

test('a replayed event whose decision already exists does not decide again', async () => {
  const dir = await tempDir();
  const { service } = await demoService({ dir });
  const replayed = ev('WORLD_RISK_UPDATED', { event_id: 'rp1', occurred_at: '2026-10-12T10:00:00Z', data: { events: typhoon } });
  await settle(service, replayed);
  const decision = await lastDecision(service);
  // The bus index is lost (e.g. restored from an older backup) but the decision log remains.
  await service.stop(); // Release the exclusive Phase 7 sequence writer before simulating a restart.
  await fs.rm(path.join(dir, 'agent-event-index.json'), { force: true });
  const fresh = await demoService({ dir, withIron: true });
  const result = await settle(fresh.service, replayed);
  assert.equal(result.accepted, true);
  assert.equal((await fresh.service.listDecisions()).count, 1);
  assert.equal((await lastDecision(fresh.service)).decision_id, decision.decision_id);
  assert.equal(fresh.service.sim.done.size, 0, 'the existing completed decision was not executed again');
});

// ---------------------------------------------------------------- Live (fake chain)

const TXH = `0x${'ab'.repeat(32)}`;

function fakeLiveContext(state = { stateIndex: 2, subscribed: 0, price: 790_000 }) {
  const sent = [];
  const oracle = '0x1111111111111111111111111111111111111111', pool = '0x2222222222222222222222222222222222222222';
  const updater = '0x3333333333333333333333333333333333333333', blockHash = `0x${'cd'.repeat(32)}`;
  const iface = new Interface(['function updatePricing(uint256,uint256,uint8,uint8,bytes32,bytes32)']);
  const parse = { parseLog: (log) => (log.name ? { name: log.name } : null), encodeFunctionData: iface.encodeFunctionData.bind(iface) };
  const receipt = { hash: TXH, from: updater, to: oracle, status: 1, blockNumber: 4242, blockHash,
    logs: ['PricingUpdated', 'OfferingPaused', 'OfferingRepriced', 'OfferingResumed'].map((name) => ({ name, address: name === 'PricingUpdated' ? oracle : pool })) };
  const transaction = { hash: TXH, from: updater, to: oracle, chainId: 1439n, value: 0n };
  const updatePricing = Object.assign(async (...args) => {
    sent.push(args); transaction.data = iface.encodeFunctionData('updatePricing', args);
    return { hash: TXH, wait: async () => receipt };
  }, { staticCall: async () => {} });
  return {
    sent, state, receipt,
    provider: { send: async () => '0x59f', getBlockNumber: async () => 5000, getBlock: async () => ({ hash: blockHash }),
      getTransaction: async () => transaction, getTransactionReceipt: async () => receipt },
    explorerBase: 'https://explorer.example',
    signers: { PRICING_UPDATER: updater },
    oracle: { target: oracle, interface: parse, isDecisionProcessed: async () => false, updatePricing, filters: {}, queryFilter: async () => [] },
    pool: {
      target: pool,
      interface: parse,
      owner: async () => '0xOwner',
      stateOf: async () => state.stateIndex,
      emergencyStopped: async () => false,
      offerings: async () => ({ exists: true, eblId: 2, subscribed: state.subscribed, issuePrice: state.price, targetRedemptionValue: 1_000_000 }),
      settlementProofs: async () => [`0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`]
    }
  };
}

async function liveService({ context = fakeLiveContext(), link = true, autonomy } = {}) {
  resetStore();
  storeState.agentActivities = [];
  createPool(copper.case_id, copper, quoteFromCase(copper, { payout_speed: 'BALANCED' }));
  const runtime = { mode: 'live', generation: 1 };
  const service = createAgentService({
    config: loadAgentConfig({ AGENT_COOLDOWN_SEC: '0', ...(autonomy ? { AGENT_AUTONOMY: autonomy } : {}) }),
    store: storeState,
    getMode: () => runtime.mode,
    getGeneration: () => runtime.generation,
    chainConfig: loadChainConfig(),
    getChainContext: async () => context,
    sleep: async () => {}
  });
  await service.init();
  if (link) {
    await service.registry.linkChain({ case_id: copper.case_id, pool_id: copper.case_id, chain_pool_id: 2, ebl_id: 2 }, {
      readPool: async () => ({ exists: true, eblId: 2, state: 'Open' })
    });
  }
  await service.start();
  return { service, runtime, context };
}

const copperEv = (type, extra = {}) => ({ type, case_id: copper.case_id, source: 'admin', source_mode: 'live', ...extra });

test('Live: a mapped pool gets a proposal that waits for approval; approving sends exactly one real-looking transaction and records its hash', async () => {
  const { service, context } = await liveService();
  await settle(service, copperEv('WORLD_RISK_UPDATED', { event_id: 'l1', data: { events: warCrisis } }), { origin: 'api' }).catch(() => {});
  // WORLD_RISK_UPDATED cannot be injected by hand in Live; the monitor (internal) can.
  await settle(service, copperEv('WORLD_RISK_UPDATED', { event_id: 'l1', data: { events: warCrisis } }));
  const decision = await lastDecision(service);
  assert.equal(decision.action, 'PAUSE');
  assert.equal(decision.mode, 'live');
  assert.equal(decision.status, 'PENDING_APPROVAL');
  assert.ok(decision.policy.reasons.some((r) => r.rule === 'LIVE_REQUIRES_APPROVAL'));
  assert.equal(decision.chain_pool_id, 2);
  assert.equal(context.sent.length, 0, 'nothing is sent before approval');
  const [approval] = service.approvals.list({ status: 'PENDING' });
  assert.equal(approval.route, 'server');

  context.state.stateIndex = 2;
  const approved = await service.approve(approval.approval_id, { by: 'admin' });
  assert.equal(approved.decision.status, 'COMPLETED');
  assert.equal(context.sent.length, 1);
  assert.equal(context.sent[0][0], 2, 'sent to on-chain pool 2');
  assert.equal(context.sent[0][3], 3, 'PAUSE_OFFERING');
  assert.equal(approved.decision.execution.mode, 'chain');
  assert.equal(approved.decision.execution.tx_hash, TXH);
  assert.equal(approved.decision.execution.explorer_url, `https://explorer.example/tx/${TXH}`);
  assert.equal(approved.decision.execution.signer_role, 'PRICING_UPDATER');
  const confirmed = service.activity.list({ limit: 100 }).find((r) => r.action === 'EXECUTION_CONFIRMED');
  assert.equal(confirmed.tx_hash, TXH);
  assert.equal(confirmed.explorer_url, `https://explorer.example/tx/${TXH}`);
  assert.equal(storeState.pools.get(copper.case_id).status, 'Paused', 'the offchain mirror follows the chain');
});

test('Live: AGENT_AUTONOMY=auto is downgraded to propose and the downgrade is visible', async () => {
  const { service } = await liveService({ autonomy: 'auto' });
  const status = await service.status();
  assert.deepEqual(status.autonomy, { configured: 'auto', effective: 'propose', downgraded: true });
  assert.equal(status.executor, 'chain');
  await settle(service, copperEv('WORLD_RISK_UPDATED', { event_id: 'la', data: { events: warCrisis } }));
  assert.equal((await lastDecision(service)).status, 'PENDING_APPROVAL');
  assert.equal(storeState.pools.get(copper.case_id).status, 'Open');
});

test('Live: a pool with no on-chain mapping gets a recorded proposal and nothing is executed', async () => {
  const context = fakeLiveContext();
  context.pool.offerings = async () => ({ exists: false }); // the known pool cannot be verified, so it is not linked
  const { service } = await liveService({ context, link: false });
  assert.equal(service.registry.get(copper.case_id)?.chain ?? null, null);
  await settle(service, copperEv('WORLD_RISK_UPDATED', { event_id: 'lm', data: { events: warCrisis } }));
  const decision = await lastDecision(service);
  assert.equal(decision.status, 'SKIPPED');
  assert.match(decision.note, /No on-chain pool is mapped/u);
  assert.equal(service.approvals.pendingCount(), 0);
  assert.equal(context.sent.length, 0);
});

test('Live: the protected pool refuses terminal actions outright and never queues them', async () => {
  const { service } = await liveService();
  assert.equal(service.registry.isProtected(copper.case_id), true);
  storeState.pools.get(copper.case_id).subscribedUsd = 1000;
  // SETTLE is only ever proposed internally (WP2.6); drive the policy through the service the same way.
  const decision = await service.logger.record({ decision_id: 'decision_probe', case_id: copper.case_id, action: 'SETTLE', reasoning_summary: 'probe', mode: 'live', status: 'DECIDED' });
  assert.equal(decision.status, 'DECIDED'); // the record exists; policy itself is covered in agentPolicy.test.js
  const protectedRecord = service.registry.get(copper.case_id);
  assert.equal(protectedRecord.protected, true);
  assert.equal(protectedRecord.chain.pool_id, 2);
});

test('Live: an action only the owner can sign becomes an owner-CLI approval; the reported tx is verified before anything completes', async () => {
  const { service, context } = await liveService();
  context.state.stateIndex = 4; // Funded
  context.state.subscribed = 1;
  storeState.pools.get(copper.case_id).subscribedUsd = 1000; // the offchain mirror has subscribers too
  await settle(service, copperEv('CARGO_DEPARTED', { event_id: 'ld', data: { departure_proof: 'dep-001' } }), { origin: 'api' });
  const decision = await lastDecision(service);
  assert.equal(decision.action, 'MARK_IN_TRANSIT');
  assert.equal(decision.status, 'PENDING_APPROVAL');
  const [approval] = service.approvals.list({ status: 'PENDING' });
  assert.equal(approval.route, 'owner_cli');
  assert.equal(approval.plan.steps.length, 1);
  assert.equal(approval.plan.steps[0].method, 'markInTransit');
  assert.equal(approval.plan.steps[0].args[0], '2');

  const granted = await service.approve(approval.approval_id);
  assert.equal(granted.approval.status, 'AWAITING_OWNER_SIGNATURE');
  assert.equal(granted.decision.status, 'AWAITING_OWNER_SIGNATURE');
  assert.equal(context.sent.length, 0, 'the server never signs an owner action');
  assert.ok(actions(service).includes('OWNER_SIGNATURE_REQUIRED'));

  // a wrong transaction is refused and nothing completes
  const refuse = async () => ({ ok: false, errors: ['argument 1 is 0xdead, expected 0x1234'], confirmed_events: [] });
  await assert.rejects(service.attachTx(approval.approval_id, { tx_hash: TXH }, { verify: refuse }), (error) => {
    assert.equal(error.code, 'tx_verification_failed');
    assert.equal(error.status, 422);
    assert.match(error.message, /argument 1/u);
    return true;
  });
  assert.equal(service.approvals.get(approval.approval_id).status, 'AWAITING_OWNER_SIGNATURE');
  assert.equal((await service.getDecision(decision.decision_id)).status, 'AWAITING_OWNER_SIGNATURE');
  assert.ok(actions(service).includes('OWNER_TX_REJECTED'));

  // the genuine transaction completes it, with the hash and a real explorer link
  const accept = async () => ({ ok: true, errors: [], block_number: 99, from: '0xOwner', confirmed_events: ['DepartureRecorded'] });
  const done = await service.attachTx(approval.approval_id, { tx_hash: TXH }, { verify: accept });
  assert.equal(done.complete, true);
  assert.equal(done.decision.status, 'COMPLETED');
  assert.equal(done.decision.execution.signer_role, 'OWNER_CLI');
  assert.equal(done.decision.execution.tx_hash, TXH);
  assert.equal(done.decision.execution.explorer_url, `${loadChainConfig().explorerBase}/tx/${TXH}`);
  assert.equal(done.approval.status, 'EXECUTED');
  assert.equal(storeState.pools.get(copper.case_id).departure_proof, 'dep-001');
  await assert.rejects(service.attachTx(approval.approval_id, { tx_hash: TXH }, { verify: accept }), { code: 'invalid_transition' });
});

test('Live: an approval is not executed after the runtime mode changed', async () => {
  const { service, runtime, context } = await liveService();
  await settle(service, copperEv('WORLD_RISK_UPDATED', { event_id: 'lmc', data: { events: warCrisis } }));
  const [approval] = service.approvals.list({ status: 'PENDING' });
  runtime.mode = 'demo';
  await assert.rejects(service.approve(approval.approval_id), { code: 'mode_changed' });
  assert.equal(context.sent.length, 0);
  assert.equal(service.approvals.get(approval.approval_id).status, 'FAILED');
  assert.equal((await service.getDecision(approval.decision_id)).status, 'FAILED');
});

test('Live: only proof-carrying events can be injected by hand', async () => {
  const { service } = await liveService();
  assert.ok(LIVE_ADMIN_EVENT_TYPES.includes('PAYMENT_RECEIVED'));
  for (const type of ['WORLD_RISK_UPDATED', 'RISK_CLEARED', 'INSURANCE_EXPIRING']) {
    await assert.rejects(service.submitEvent(copperEv(type, { event_id: `x-${type}` }), { origin: 'api' }), { code: 'event_not_allowed_in_live', status: 403 });
  }
  await service.submitEvent(copperEv('CARGO_DEPARTED', { event_id: 'ok-1', data: { departure_proof: 'p' } }), { origin: 'api' });
});

test('Live: a hand-injected arrival without a proof is rejected before queueing', async () => {
  const { service } = await liveService();
  await assert.rejects(settle(service, copperEv('CARGO_ARRIVED', { event_id: 'noproof' }), { origin: 'api' }), { code: 'proof_required' });
  assert.equal((await service.listDecisions()).count, 0);
  assert.equal(service.bus.get('event:noproof'), null);
});

test('Live: a broadcast transaction that is not yet confirmed stays EXECUTING and is reconciled on the next tick', async () => {
  const context = fakeLiveContext();
  let confirmed = false;
  const receipt = context.receipt, send = context.oracle.updatePricing;
  context.oracle.updatePricing = Object.assign(async (...args) => {
    await send(...args); return { hash: TXH, wait: () => new Promise(() => {}) };
  }, { staticCall: async () => {} });
  context.provider.getTransactionReceipt = async () => (confirmed ? receipt : null);
  const { service } = await liveService({ context });
  service.getChain = async () => new ChainExecutor({ getContext: async () => context, txTimeoutMs: 30 });
  await settle(service, copperEv('WORLD_RISK_UPDATED', { event_id: 'pend', data: { events: warCrisis } }));
  const [approval] = service.approvals.list({ status: 'PENDING' });
  const result = await service.approve(approval.approval_id);
  assert.equal(result.decision.status, 'EXECUTING');
  assert.equal(result.decision.execution.tx_hash, TXH);
  assert.equal(result.decision.execution.pending, true);
  assert.equal(result.approval.status, 'APPROVED');

  confirmed = true;
  await service.tick();
  const done = await service.getDecision(approval.decision_id);
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.execution.tx_hash, TXH);
  assert.equal(service.approvals.get(approval.approval_id).status, 'EXECUTED');
});

test('Live: an unreachable chain never degrades to a simulated result', async () => {
  const { service } = await liveService({ context: null });
  const status = await service.status();
  assert.equal(status.executor, 'chain');
  await settle(service, copperEv('WORLD_RISK_UPDATED', { event_id: 'nochain', data: { events: warCrisis } }));
  const decision = await lastDecision(service);
  // Without a chain context there is no mapping either: recorded, not executed, never simulated.
  assert.equal(decision.status, 'SKIPPED');
  assert.equal(decision.execution, undefined);
  assert.equal(storeState.pools.get(copper.case_id).status, 'Open');
});
