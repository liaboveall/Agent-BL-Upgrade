import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Interface } from 'ethers';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { createAgentService } from '../src/agent/runtime/factory.js';
import { chainConfig as historicalChainConfig } from './helpers/opening.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { ChainExecutor } from '../src/agent/runtime/executors/chainExecutor.js';
import { CopilotService } from '../src/copilot/service.js';
import { assessWorldRisk } from '../src/agent/worldRiskAgent.js';
import { EventBus } from '../src/agent/runtime/eventBus.js';
import { normalizeEvent } from '../src/agent/runtime/events.js';
import { cargoIdentityHash } from '../src/chain/cargoIdentity.js';

const copper = JSON.parse(await fs.readFile(new URL('../data/cases/archive/copper-sg-shanghai-2026-06.case.json', import.meta.url), 'utf8'));
const TX = `0x${'ac'.repeat(32)}`; // fake provider receipt only
const timeout = () => Object.assign(new Error('injected RPC outage'), { code: 'TIMEOUT' });
const storm = [{ type: 'severe_weather', severity: 'critical', region: 'East China Sea', description: 'storm', date: '2026-10-13' },
  { type: 'war_risk', severity: 'critical', region: 'Strait of Hormuz', description: 'closure', date: '2026-10-13' }];

function fakeChain() {
  const faults = { reads: 0, nonce: 0, wait: false, lookup: false, reverted: false, send: false };
  const calls = { sends: 0, lookups: 0, attempts: 0 };
  const oracle = '0x1111111111111111111111111111111111111111', pool = '0x2222222222222222222222222222222222222222';
  const updater = '0x3333333333333333333333333333333333333333', blockHash = `0x${'ab'.repeat(32)}`;
  const iface = new Interface(['function updatePricing(uint256,uint256,uint8,uint8,bytes32,bytes32)']);
  let data;
  const receipt = () => ({ hash: TX, from: updater, to: oracle, status: faults.reverted ? 0 : 1, blockNumber: 3, blockHash,
    logs: ['PricingUpdated', 'OfferingPaused'].map((name) => ({ name, address: name === 'PricingUpdated' ? oracle : pool })) });
  const parser = { parseLog: ({ name }) => ({ name }), encodeFunctionData: iface.encodeFunctionData.bind(iface) };
  const updatePricing = Object.assign(async (...args) => {
    calls.attempts++;
    if (faults.nonce-- > 0) throw Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' });
    calls.sends++;
    data = iface.encodeFunctionData('updatePricing', args);
    if (faults.send) throw timeout();
    return { hash: TX, wait: async () => { faults.onWait?.(); if (faults.wait) throw timeout(); return receipt(); } };
  }, { staticCall: async () => { faults.onPreflight?.(); if (faults.reads-- > 0) throw timeout(); } });
  return { faults, calls, ctx: {
    signers: { PRICING_UPDATER: updater }, explorerBase: 'https://example.invalid',
    provider: { send: async () => '0x59f', getBlockNumber: async () => 10, getBlock: async () => ({ hash: blockHash }),
      getTransaction: async () => ({ hash: TX, from: updater, to: oracle, chainId: 1439n, value: 0n, data }),
      getTransactionReceipt: async () => { calls.lookups++; if (faults.lookup) throw timeout(); return receipt(); } },
    oracle: { target: oracle, updatePricing, isDecisionProcessed: async () => false, interface: parser },
    pool: { target: pool, interface: parser, emergencyStopped: async () => false, stateOf: async () => 2,
      offerings: async () => ({ exists: true, eblId: 2, issuePrice: 800000, targetRedemptionValue: 1000000, subscribed: 0 }) },
    // Live bootstrap links pool #2 only after its eBL shows the registered cargo identity.
    registry: { cargoHashOf: async () => cargoIdentityHash(copper) }
  } };
}

async function runtime(t, { mode = 'live', dir, chain = fakeChain(), config = {}, state, store } = {}) {
  let clockMs = Date.parse('2026-10-13T00:00:00Z');
  const clock = { now: () => new Date(clockMs), advance: (ms) => { clockMs += ms; } };
  const current = state ?? { mode, generation: 1 };
  const quote = quoteFromCase(copper, { payout_speed: 'BALANCED' });
  const pools = store ?? { pools: new Map([[copper.case_id, { poolId: copper.case_id, caseData: structuredClone(copper), quote,
    targetUsd: quote.requested_cash_usd, subscribedUsd: 0, status: 'Open' }]]), agentActivities: [] };
  const service = createAgentService({ store: pools, env: {}, dir, now: clock.now, monitors: false,
    config: loadAgentConfig({ AGENT_COOLDOWN_SEC: '0', AGENT_APPROVAL_TTL_SEC: '60', ...config }),
    getMode: () => current.mode, getGeneration: () => current.generation, getChainContext: async () => chain.ctx,
    chainConfig: historicalChainConfig, sleep: async () => {} });
  await service.start();
  t.after(() => service.stop());
  return { service, state: current, clock, chain, store: pools };
}

async function propose(service, id = 'risk') {
  await service.submitEvent({ type: 'WORLD_RISK_UPDATED', case_id: copper.case_id, source: 'world-risk-monitor', event_id: id,
    occurred_at: '2026-10-13T00:00:00Z', data: { events: storm } });
  await service.bus.idle();
  return service.approvals.list({ status: 'PENDING' })[0];
}

test('matrix: late clearing cannot undo a newer escalation, including indexes written before the shared stream', async (t) => {
  const { service, store } = await runtime(t, { mode: 'demo' });
  await propose(service);
  assert.equal(store.pools.get(copper.case_id).status, 'Paused');
  await service.submitEvent({ type: 'RISK_CLEARED', case_id: copper.case_id, source: 'world-risk-monitor', event_id: 'late', occurred_at: '2026-10-12T23:00:00Z' });
  await service.bus.idle();
  assert.equal(service.bus.get('event:late').status, 'STALE');
  assert.equal(store.pools.get(copper.case_id).status, 'Paused');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-matrix-index-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const indexFile = path.join(dir, 'index.json');
  await fs.writeFile(indexFile, JSON.stringify({ entries: [], last_occurred: { 'C::WORLD_RISK_UPDATED': '2026-10-13T00:00:00Z' } }));
  let invoked = false;
  const bus = await new EventBus({ indexFile, handler: async () => { invoked = true; } }).init();
  bus.start();
  await bus.submit(normalizeEvent({ type: 'RISK_CLEARED', case_id: 'C', source: 'admin', occurred_at: '2026-10-12T00:00:00Z' }));
  await bus.idle();
  assert.equal(invoked, false);
  await bus.stop();
});

test('matrix: concurrent duplicate events produce one approval and one execution', async (t) => {
  const { service, chain } = await runtime(t);
  await Promise.all([propose(service), propose(service), propose(service)]);
  assert.equal((await service.listDecisions()).count, 1);
  const [approval] = service.approvals.list();
  const outcomes = await Promise.allSettled([service.approve(approval.approval_id), service.approve(approval.approval_id)]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(chain.calls.sends, 1);
});

for (const fault of ['reads', 'nonce']) test(`matrix: ${fault === 'reads' ? 'RPC preflight timeout' : 'mined nonce conflict'} recovers with bounded retry and one broadcast`, async (t) => {
  const chain = fakeChain(); chain.faults[fault] = 1;
  const { service } = await runtime(t, { chain });
  const approval = await propose(service);
  const result = await service.approve(approval.approval_id);
  assert.equal(result.decision.status, 'COMPLETED');
  assert.equal(result.approval.status, 'EXECUTED');
  assert.equal(chain.calls.sends, 1);
  if (fault === 'nonce') assert.equal(chain.calls.attempts, 2);
});

test('matrix: persistent RPC outage fails explicitly before any broadcast, never simulates', async (t) => {
  const chain = fakeChain(); chain.faults.reads = 10;
  const { service } = await runtime(t, { chain });
  const result = await service.approve((await propose(service)).approval_id);
  assert.equal(result.decision.status, 'FAILED');
  assert.equal(result.decision.error.code, 'rpc_unavailable');
  assert.equal(chain.calls.sends, 0);
  assert.equal(service.sim.done.size, 0);
});

test('matrix: broadcast timeout survives restart and transient reconciliation outage without resending', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-matrix-restart-'));
  // Registered before runtime cleanup: node:test runs after hooks in registration order.
  const chain = fakeChain(); chain.faults.wait = true;
  const first = await runtime(t, { dir, chain });
  const approval = await propose(first.service);
  const pending = await first.service.approve(approval.approval_id);
  assert.equal(pending.decision.status, 'EXECUTING');
  assert.equal(pending.decision.execution.tx_hash, TX);
  await first.service.stop();
  const second = await runtime(t, { dir, chain, store: first.store });
  chain.faults.lookup = true;
  await second.service.tick();
  assert.equal((await second.service.getDecision(pending.decision.decision_id)).status, 'EXECUTING');
  chain.faults.lookup = false;
  await Promise.all([second.service.tick(), second.service.tick()]);
  const done = await second.service.getDecision(pending.decision.decision_id);
  assert.equal(done.status, 'COMPLETED');
  assert.equal(second.service.approvals.get(approval.approval_id).status, 'EXECUTED');
  assert.equal(chain.calls.sends, 1);
  assert.equal(second.service.activity.list({ limit: 1000 }).filter((r) => r.action === 'EXECUTION_CONFIRMED').length, 1);
  await second.service.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

test('matrix: approval granted just before restart resumes once; an ambiguous broadcast requires operator reconciliation', async (t) => {
  const { service, chain } = await runtime(t);
  const approval = await propose(service);
  await service.approvals.approve(approval.approval_id); // durable checkpoint before EXECUTING
  await service.tick();
  await service.tick();
  assert.equal(chain.calls.sends, 1);
  assert.equal(service.approvals.get(approval.approval_id).status, 'EXECUTED');
  const other = await runtime(t);
  other.chain.faults.send = true;
  const pending = await other.service.approve((await propose(other.service)).approval_id);
  await other.service.tick();
  const record = await other.service.getDecision(pending.decision.decision_id);
  assert.equal(record.status, 'EXECUTING');
  assert.equal(record.execution.reconciliation_required, true);
  assert.equal(other.chain.calls.sends, 1);
  assert.equal(record.execution.tx_hash, undefined);
});

test('matrix: known reverted receipt fails decision and approval without retries', async (t) => {
  const chain = fakeChain(); chain.faults.reverted = true;
  const { service } = await runtime(t, { chain });
  const result = await service.approve((await propose(service)).approval_id);
  assert.equal(result.decision.status, 'FAILED');
  assert.equal(result.decision.error.code, 'tx_reverted');
  assert.equal(result.approval.status, 'FAILED');
  assert.equal(chain.calls.sends, 1);
});

test('matrix: an interrupted pricing broadcast without a hash recovers read-only from exact oracle replay protection', async (t) => {
  const { service, chain } = await runtime(t);
  chain.faults.send = true;
  const pending = await service.approve((await propose(service)).approval_id);
  assert.equal(pending.decision.status, 'EXECUTING');
  chain.ctx.oracle.isDecisionProcessed = async () => true;
  chain.ctx.provider.getBlockNumber = async () => 10;
  chain.ctx.oracle.filters = { PricingUpdated: () => ({}) };
  chain.ctx.oracle.queryFilter = async () => [{ transactionHash: TX, args: {
    poolId: 2, issuePrice: Math.round(pending.decision.proposal.params.quote.final_issue_price_usd * 1000000),
    action: 3, evidenceHash: pending.decision.proposal.params.quote.evidence_hash, quoteHash: pending.decision.proposal.params.quote.quote_hash
  } }];
  await service.tick();
  const recovered = await service.getDecision(pending.decision.decision_id);
  assert.equal(recovered.status, 'COMPLETED');
  assert.equal(recovered.execution.tx_hash, TX);
  assert.equal(chain.calls.sends, 1, 'recovery only reads the chain');
});

test('matrix: confirmation after a mode change records the Live fact without mutating Demo pools', async (t) => {
  const { service, chain, state, store } = await runtime(t);
  const approval = await propose(service);
  chain.faults.onWait = () => { state.mode = 'demo'; state.generation++; };
  const result = await service.approve(approval.approval_id);
  assert.equal(result.decision.status, 'COMPLETED');
  assert.equal(result.decision.mode, 'live');
  assert.equal(result.decision.execution.tx_hash, TX);
  assert.equal(store.pools.get(copper.case_id).status, 'Open');
  assert.equal(service.sim.done.size, 0);
});

test('matrix: a completed decision repairs an interrupted approval checkpoint without another broadcast', async (t) => {
  const { service, chain } = await runtime(t);
  const approval = await propose(service);
  const original = service.approvals.markExecuted.bind(service.approvals);
  service.approvals.markExecuted = async () => { throw new Error('injected approval write interruption'); };
  const result = await service.approve(approval.approval_id);
  assert.equal(result.decision.status, 'COMPLETED');
  assert.equal(service.approvals.get(approval.approval_id).status, 'APPROVED');
  service.approvals.markExecuted = original;
  await service.tick();
  assert.equal(service.approvals.get(approval.approval_id).status, 'EXECUTED');
  assert.equal(chain.calls.sends, 1);
});

test('matrix: injected clock expires approvals and synchronizes their decisions even if approve observed expiry first', async (t) => {
  const { service, clock, chain } = await runtime(t);
  const approval = await propose(service);
  assert.equal(approval.created_at, clock.now().toISOString());
  clock.advance(60001);
  await assert.rejects(service.approve(approval.approval_id), { code: 'approval_expired' });
  await service.tick();
  assert.equal((await service.getDecision(approval.decision_id)).status, 'SKIPPED');
  assert.equal(chain.calls.sends, 0);
});

test('matrix: switching away and back invalidates approvals and queued events by generation', async (t) => {
  const { service, state, chain } = await runtime(t);
  const approval = await propose(service);
  state.generation += 2;
  await assert.rejects(service.approve(approval.approval_id), { code: 'mode_changed' });
  assert.equal(chain.calls.sends, 0);
  await service.stop();
  await service.submitEvent({ type: 'RISK_CLEARED', case_id: copper.case_id, source: 'admin', event_id: 'queued' });
  state.generation++;
  await service.start(); await service.bus.idle();
  assert.match(service.bus.get('event:queued').result.ignored, /Runtime changed/u);
});

test('matrix: mode changes while signer queue waits prevent broadcast', async () => {
  const chain = fakeChain();
  const executor = new ChainExecutor({ getContext: async () => chain.ctx });
  const quote = quoteFromCase(copper);
  await assert.rejects(executor.execute({ decision_id: 'd', idempotency_key: 'e', action: 'PAUSE', chain_pool_id: 2,
    params: { quote }, assertCurrent: () => { throw Object.assign(new Error('changed'), { code: 'mode_changed' }); } }), { code: 'mode_changed' });
  assert.equal(chain.calls.sends, 0);
});

test('matrix: unavailable LLM and xAPI use labelled deterministic fallbacks and keep constraints', async () => {
  let llmCalls = 0, xapiCalls = 0;
  const copilot = new CopilotService({ env: {}, getPools: async () => [], llmConfigured: () => true,
    chatFn: async () => { llmCalls++; throw new Error('injected model outage'); } });
  const result = await copilot.query({ message: '铜，预算1000美元', locale: 'zh' });
  assert.ok(llmCalls > 0);
  assert.equal(result.intent_mode, 'deterministic');
  assert.equal(result.context.constraints.ticket_usd, 1000);
  assert.deepEqual(result.context.constraints.commodities_include, ['copper']);
  const risk = await assessWorldRisk(copper, { env: {}, execute: async () => { xapiCalls++; throw new Error('injected feed outage'); } });
  assert.ok(xapiCalls > 0);
  assert.equal(risk.live, false);
  assert.equal(risk.provider, 'xapi-empty->fixtures');
  assert.ok(risk.events.length > 0);
});

// Phase 5 freshness must be checked after a slow preflight, at the actual broadcast boundary.
test('matrix: evidence expiring during RPC preflight blocks the signer before any broadcast', async (t) => {
  const chain = fakeChain();
  const { service, clock } = await runtime(t, { chain });
  const approval = await propose(service);
  chain.faults.onPreflight = () => clock.advance(24 * 3600 * 1000);
  const result = await service.approve(approval.approval_id);
  assert.equal(result.decision.status, 'FAILED');
  assert.equal(result.decision.error.code, 'evidence_expired');
  assert.equal(chain.calls.sends, 0);
});
