import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPool, resetStore, storeState } from '../src/app/store.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';

import { createAgentService } from '../src/agent/runtime/factory.js';


const readCase = async (name) => JSON.parse(await fs.readFile(new URL(`../data/cases/${name}.case.json`, import.meta.url), 'utf8'));
const iron = await readCase('ironore-au-tj');
// The historical copper case is the one testnet pool #2 was opened from.


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
  assert.equal(decision.execution.effects.state_after, 'Open');

  // the offchain pool really changed
  assert.equal(pool().status, 'Open');
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
  assert.equal(pool().status, 'Open');
  await settle(service, ev('WORLD_RISK_UPDATED', { event_id: 'r2', occurred_at: '2026-10-12T10:05:00Z', data: { events: warCrisis } }));
  assert.equal(pool().status, 'Paused');
  await settle(service, ev('RISK_CLEARED', { event_id: 'r3', occurred_at: '2026-10-12T10:10:00Z' }));
  assert.equal(pool().status, 'Open', 'RESUME returns the pool to the state before the pause');
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
  assert.equal(pool().status, 'Open');
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
  assert.deepEqual(Object.keys(status.signers).sort(), []);
  for (const signer of Object.values(status.signers)) assert.deepEqual(Object.keys(signer), ['configured']);
  assert.equal(status.pending_approvals, 0);
  assert.deepEqual(status.protected_chain_pools, []);
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
    await fs.access(path.join(file === 'agent-activity.jsonl' ? dir : path.dirname(second.service.registry.file), file));
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
  await fs.rm(path.join(path.dirname(service.registry.file), 'agent-event-index.json'), { force: true });
  const fresh = await demoService({ dir, withIron: true });
  const result = await settle(fresh.service, replayed);
  assert.equal(result.accepted, true);
  assert.equal((await fresh.service.listDecisions()).count, 1);
  assert.equal((await lastDecision(fresh.service)).decision_id, decision.decision_id);
  assert.equal(fresh.service.sim.done.size, 0, 'the existing completed decision was not executed again');
});

// ---------------------------------------------------------------- Live (fake chain)
