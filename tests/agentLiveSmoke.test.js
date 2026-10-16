import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveSmoke } from '../scripts/lib/agent-live-smoke.mjs';
import { smokeEvent, proposeLiveSmoke, previewSmokePlan } from '../src/agent/runtime/liveSmoke.js';
import { readSmokeChain } from '../src/agent/runtime/liveSmokeVerification.js';
import { loadChainConfig } from '../src/agent/runtime/factory.js';
import { Interface } from 'ethers';
import { toChainPricingArgs } from '../src/core/oracle.js';
import { PRICING_ACTION_FOR } from '../src/agent/runtime/executors/chainExecutor.js';
import { repriceWithWorldRisk } from '../src/core/worldRiskPricing.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';

const TX = `0x${'ab'.repeat(32)}`;
function harness({ pending = false, verified = true } = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    const pathname = new URL(url).pathname; calls.push({ pathname, method: options.method });
    const body = options.body ? JSON.parse(options.body) : {};
    let data;
    if (pathname === '/api/agent/status') data = { mode: 'live', autonomy: { effective: 'propose' }, protected_chain_pools: [2] };
    else if (pathname === '/api/agent/smoke/propose') data = { decision: { proposed_action: body.action, action: body.action, chain_pool_id: 2, mode: 'live',
      status: pending ? 'EXECUTING' : 'PENDING_APPROVAL', decision_id: body.action, approval: { approval_id: body.action } } };
    else data = { decision: { decision_id: pathname.split('/')[4], status: 'COMPLETED', execution: { mode: 'chain', tx_hash: TX } } };
    return { ok: true, json: async () => data };
  };
  return { calls, options: { base: 'http://127.0.0.1:3000', runId: 'smoke-test-1', token: 'test-admin', fetchFn, readChain: async () => ({ verified, state: 2 }) } };
}

test('default live smoke performs reads only, including when keys happen to exist', async () => {
  const { options, calls } = harness(); const result = await runLiveSmoke(options);
  assert.equal(result.status, 'DRY_RUN'); assert.equal(result.live_acceptance, false); assert.equal(result.real_transactions, 0);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('confirmed smoke approves exactly REPRICE, PAUSE, RESUME on protected pool #2 and verifies each', async () => {
  const { options, calls } = harness(); const result = await runLiveSmoke({ ...options, confirm: true });
  assert.equal(result.status, 'PASS'); assert.equal(result.real_transactions, 3);
  assert.deepEqual(result.steps.map((step) => step.action), ['REPRICE', 'PAUSE', 'RESUME']);
  assert.equal(calls.filter((call) => /approve$/u.test(call.pathname)).length, 3);
});

test('uncertain broadcast and mismatched receipt abort without retries or a second proposal', async () => {
  for (const fault of [{ pending: true }, { verified: false }]) {
    const { options, calls } = harness(fault);
    await assert.rejects(runLiveSmoke({ ...options, confirm: true }), /reconciliation|did not match/u);
    assert.equal(calls.filter((call) => call.pathname === '/api/agent/smoke/propose').length, 1);
    if (fault.pending) assert.equal(calls.filter((call) => /approve$/u.test(call.pathname)).length, 0);
  }
});

test('recovery verifies the two saved receipts historically and approves only the remaining RESUME', async () => {
  const { options, calls } = harness();
  const original = options.fetchFn;
  const observations = [];
  options.fetchFn = async (url, init) => {
    const result = await original(url, init);
    if (new URL(url).pathname === '/api/agent/smoke/propose') {
      const data = await result.json();
      if (data.decision.action !== 'RESUME') Object.assign(data.decision, { status: 'COMPLETED', execution: { mode: 'chain', tx_hash: TX } });
      return { ok: true, json: async () => data };
    }
    return result;
  };
  options.readChain = async (decision, verification) => { if (decision) observations.push(verification.historical); return { verified: true, state: 6 }; };
  const result = await runLiveSmoke({ ...options, confirm: true });
  assert.equal(result.status, 'PASS'); assert.equal(result.real_transactions, 1);
  assert.equal(result.confirmed_transactions, 3); assert.equal(result.reused_transactions, 2);
  assert.deepEqual(observations, [true, true, false]);
  assert.deepEqual(calls.filter((call) => /approve$/u.test(call.pathname)).map((call) => call.pathname), ['/api/agent/approvals/RESUME/approve']);
});

function receiptFixture(action) {
  const config = loadChainConfig();
  const oracleInterface = new Interface(config.abis.RiskPricingOracle), poolInterface = new Interface(config.abis.RWAOfferingPool);
  const beforeState = action === 'REPRICE' ? 2 : action === 'PAUSE' ? 6 : 7;
  const afterState = action === 'PAUSE' ? 7 : 6;
  const quote = repriceWithWorldRisk(globalThis.structuredClone(copperCase), [{ type: 'severe_weather', region: 'East China Sea', severity: action === 'PAUSE' ? 'critical' : 'warning',
    description: 'Explicit operator-triggered testnet smoke input', date: '2026-10-15' }], { payout_speed: 'FAST' }).after;
  const args = toChainPricingArgs({ ...quote, pricing_action: PRICING_ACTION_FOR[action] }, { pool_id: 2 });
  const values = [args.pool_id, args.issue_price_e6, args.risk_level, args.pricing_action, args.evidence_hash, args.quote_hash];
  const updater = `0x${'11'.repeat(20)}`, blockHash = `0x${'cd'.repeat(32)}`;
  const log = (iface, address, name, fields) => ({ address, ...iface.encodeEventLog(iface.getEvent(name), fields) });
  const logs = [log(oracleInterface, config.contracts.RiskPricingOracle, 'PricingUpdated', [...values, updater]),
    log(poolInterface, config.contracts.RWAOfferingPool, 'OfferingStateChanged', [2, beforeState, afterState, args.pricing_action])];
  if (action === 'REPRICE') logs.push(log(poolInterface, config.contracts.RWAOfferingPool, 'OfferingRepriced', [2, 984600, 982700, args.evidence_hash, args.quote_hash]));
  else if (action === 'PAUSE') logs.push(log(poolInterface, config.contracts.RWAOfferingPool, 'OfferingPaused', [2, args.evidence_hash]));
  else logs.push(log(poolInterface, config.contracts.RWAOfferingPool, 'OfferingResumed', [2, 6, args.evidence_hash]));
  const state = { after: afterState, price: '982700', current: afterState, canonical: blockHash };
  const tx = { to: config.contracts.RiskPricingOracle, from: updater, chainId: 1439, data: oracleInterface.encodeFunctionData('updatePricing', values) };
  const context = { provider: { send: async () => '0x59f', getBlockNumber: async () => 110,
    getTransaction: async () => tx, getTransactionReceipt: async () => ({ status: 1, blockNumber: 100, blockHash, logs }), getBlock: async () => ({ hash: state.canonical }) },
    oracle: { interface: oracleInterface, isDecisionProcessed: async () => true },
    pool: { interface: poolInterface, emergencyStopped: async () => false,
      stateOf: async (_, opts) => opts.blockTag === 99 ? beforeState : opts.blockTag === 100 ? state.after : state.current,
      offerings: async (_, opts) => ({ exists: true, issuePrice: opts.blockTag === 99 && action === 'REPRICE' ? '984600' : state.price }) } };
  const decision = { chain_pool_id: 2, proposed_action: action, proposal: { params: { quote } }, execution: { tx_hash: TX } };
  return { context, config, decision, state, tx };
}
const { copper: copperCase } = await import('./helpers/phase5.js');

test('read-only forecast separates oracle risk quotes from actual PAUSE/RESUME pool prices and states', async () => {
  const pool = { poolId: copperCase.case_id, caseData: copperCase, quote: quoteFromCase(copperCase), status: 'Open', subscribedUsd: 0 };
  const steps = await previewSmokePlan(pool, { now: new Date('2026-10-15') });
  assert.deepEqual(steps.map((s) => s.proposal.params.quote.final_issue_price_usd), [0.9827, 0.9811, 0.9827]);
  assert.deepEqual(steps.map((s) => s.effects.issue_price_after_usd), [0.9827, 0.9827, 0.9827]);
  assert.deepEqual(steps.map((s) => s.effects.state_after), ['Repriced', 'Paused', 'Repriced']);
  assert.equal(pool.status, 'Open'); assert.equal(pool.quote.final_issue_price_usd, 0.9846);
  await assert.rejects(previewSmokePlan({ ...pool, status: 'Frozen' }), /cannot propose REPRICE/u);
});

test('PAUSE verifies a lower oracle quote while the actual offering price stays unchanged', async () => {
  const f = receiptFixture('PAUSE');
  const result = await readSmokeChain(f.context, f.config, f.decision);
  assert.equal(result.verified, true); assert.equal(result.quote_issue_price_e6, '981100'); assert.equal(result.issue_price_e6, '982700');
  // Same oracle event cannot justify changing the pool price on a state-only action.
  f.context.pool.offerings = async (_, opts) => ({ exists: true, issuePrice: opts.blockTag === 99 ? '982700' : '981100' });
  assert.equal((await readSmokeChain(f.context, f.config, f.decision)).verified, false);
});

test('RESUME verifies the contract-restored Repriced state and unchanged issue price', async () => {
  const f = receiptFixture('RESUME');
  assert.equal((await readSmokeChain(f.context, f.config, f.decision)).verified, true);
  f.state.after = 2; f.state.current = 2;
  assert.equal((await readSmokeChain(f.context, f.config, f.decision)).verified, false);
});

test('a saved REPRICE receipt is verified at its block even after a later PAUSE', async () => {
  const f = receiptFixture('REPRICE'); f.state.current = 7;
  assert.equal((await readSmokeChain(f.context, f.config, f.decision)).verified, false);
  assert.equal((await readSmokeChain(f.context, f.config, f.decision, { historical: true })).verified, true);
});

test('receipt verification rejects a noncanonical block or mismatching transaction calldata/target', async () => {
  for (const mutate of [
    (f) => { f.state.canonical = `0x${'ef'.repeat(32)}`; },
    (f) => { f.tx.data = '0x'; },
    (f) => { f.tx.to = `0x${'22'.repeat(20)}`; }
  ]) {
    const f = receiptFixture('PAUSE'); mutate(f);
    assert.equal((await readSmokeChain(f.context, f.config, f.decision)).verified, false);
  }
});

test('lifecycle mode stops with the separately authorized owner/wallet checklist', async () => {
  const { options, calls } = harness(); const result = await runLiveSmoke({ ...options, confirm: true, lifecycle: true });
  assert.equal(result.status, 'OWNER_ACTION_REQUIRED'); assert.equal(result.live_acceptance, false);
  assert.equal(result.lifecycle.automatic_owner_transactions, 0); assert.ok(calls.every((call) => call.method === 'GET'));
});

test('smoke rejects unconfirmed writes, insecure remote URLs and terminal actions', async () => {
  const { options } = harness();
  await assert.rejects(runLiveSmoke({ ...options, confirm: true, token: '' }), /token/u);
  await assert.rejects(runLiveSmoke({ ...options, base: 'http://example.com' }), /HTTPS/u);
  for (const action of ['FREEZE', 'LIQUIDATE', 'CANCEL', 'SETTLE', 'OPEN']) assert.throws(() => smokeEvent({ action, runId: 'test-run', caseId: 'C', now: new Date() }), /Invalid/u);
  await assert.rejects(proposeLiveSmoke({ env: {}, getMode: () => 'live' }, {}), /explicitly enabled/u);
});

test('server smoke proposals enforce the pool, exact order and reuse the existing decision', async () => {
  const submitted = [];
  const decisions = [];
  const pool = { poolId: 'C', status: 'Open', subscribedUsd: 0, quote: { payout_speed: 'FAST', final_issue_price_usd: 0.9846 },
    caseData: (await import('./helpers/phase5.js')).copper };
  const service = { env: { AGENT_LIVE_SMOKE_ENABLED: 'true' }, running: true, getMode: () => 'live', ensurePools: async () => {},
    now: () => new Date('2026-10-15'), registry: { list: () => [{ case_id: 'C', pool_id: 'C', chain: { pool_id: 2 } }], isProtected: () => true },
    store: { pools: new Map([['C', pool]]) }, logger: { list: async () => decisions }, getDecision: async (id) => decisions.find((decision) => decision.decision_id === id),
    submitEvent: async (event) => { submitted.push(event); decisions.push({ event_id: event.event_id, decision_id: 'D', proposed_action: 'REPRICE', status: 'PENDING_APPROVAL' }); return { idempotency_key: event.idempotency_key }; },
    waitFor: async () => ({ result: { decisions: ['D'] } }) };
  await assert.rejects(proposeLiveSmoke(service, { action: 'PAUSE', run_id: 'test-run-1' }), /preceding/u);
  const first = await proposeLiveSmoke(service, { action: 'REPRICE', run_id: 'test-run-1' });
  assert.equal(first.reused, false);
  assert.equal((await proposeLiveSmoke(service, { action: 'REPRICE', run_id: 'test-run-1' })).reused, true);
  assert.equal(submitted.length, 1);
  service.registry.isProtected = () => false;
  await assert.rejects(proposeLiveSmoke(service, { action: 'REPRICE', run_id: 'test-run-1' }), /protected pool/u);
});
