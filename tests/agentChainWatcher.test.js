import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Interface } from 'ethers';
import { createChainContext } from '../src/agent/runtime/executors/chainExecutor.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { WATCHED_EVENTS } from '../src/agent/runtime/sources/chainWatcher.js';
import { evaluatePolicy } from '../src/agent/runtime/policy.js';
import { poolCandidate } from '../src/copilot/retrieval.js';
import { hashSnapshot } from '../src/agent/decisionLogger.js';
import { watcherChain, watcherService, oil, copper, hash, ZERO } from './helpers/chainWatcher.js';

async function tmp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-watch-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const created = (chain, id = 11, options) => { const p = chain.state.pools.get(id); return chain.log('OfferingCreated', [id, p.eblId, p.tokenSupply, p.issuePrice, p.targetRedemptionValue], options); };
const observed = (service) => service.bus.list({ limit: 1000 }).map((entry) => ({ ...entry,
  event: service.chainTestJournal.get(entry.idempotency_key) })).filter((entry) => entry.event?.source === 'chain-watcher');

async function legacyCursor(dir, chain) {
  const file = path.join(dir, 'agent-chain-cursor.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  const contracts = Object.entries(WATCHED_EVENTS).map(([name, events]) => ({ name,
    address: chain.chainConfig.contracts[name].toLowerCase(),
    topics: events.map((event) => new Interface(chain.chainConfig.abis[name]).getEvent(event).topicHash) }));
  const legacy = { ...saved, version: 1, identity: hashSnapshot({ chain_id: 1439, contracts,
    deployments: chain.chainConfig.deployments, start_override: null }) };
  await fs.writeFile(file, JSON.stringify(legacy));
  return legacy;
}

test('chain configuration: independent polling defaults, interval bounds and opt-out', () => {
  assert.equal(loadAgentConfig({}).chainPollSec, 15);
  assert.equal(loadAgentConfig({}).chainWatcherEnabled, true);
  assert.equal(loadAgentConfig({}).chainStartBlock, null);
  assert.equal(loadAgentConfig({ AGENT_CHAIN_POLL_SEC: '-3' }).chainPollSec, 1);
  assert.equal(loadAgentConfig({ AGENT_CHAIN_POLL_SEC: '9000' }).chainPollSec, 3600);
  assert.equal(loadAgentConfig({ AGENT_CHAIN_WATCHER_ENABLED: 'false' }).chainWatcherEnabled, false);
});

test('read-only chain context does not resolve any private key or create a wallet', async () => {
  const chain = watcherChain();
  const context = await createChainContext({ chainConfig: chain.chainConfig, env: {}, readOnly: true,
    resolveKey: () => { throw new Error('Key resolution is forbidden'); } });
  assert.deepEqual(context.signers, {});
  assert.equal(context.pool.runner, context.provider);
  assert.equal(context.oracle.runner, context.provider);
  context.provider.destroy();
});

test('confirmed logs are sorted, decoded, deduplicated, observed and committed after durable delivery', async (t) => {
  const dir = await tmp(t), chain = watcherChain();
  chain.state.logs = [chain.log('Subscribed', [11, '0x1111111111111111111111111111111111111111', 10n, 8000000n], { index: 2 }), created(chain, 11, { index: 0 })];
  chain.state.logs.push(chain.state.logs[0]);
  chain.state.pools.get(11).subscribed = 10n; chain.state.pools.get(11).state = 3;
  const h = await watcherService({ chain, dir });
  assert.equal((await h.poll()).state, 'healthy');
  const events = observed(h.service).sort((a, b) => a.event.data.log_index - b.event.data.log_index);
  assert.deepEqual(events.map((e) => e.type), ['OFFERING_CREATED', 'SUBSCRIPTION_RECEIVED']);
  assert.equal(events[1].event.data.args.paidAmount, '8000000');
  assert.equal(events[1].event.chain_pool_id, 11);
  assert.equal(events[1].event.source_mode, 'live');
  assert.equal(events[1].result.observed, true);
  assert.equal(h.service.registry.chainPoolIdFor(oil.case_id), 11);
  assert.equal(h.store.pools.get(oil.case_id).status, 'Subscribed');
  assert.equal((await h.service.listDecisions()).count, 0);
  assert.equal(h.service.approvals.pendingCount(), 0);
  const cursor = JSON.parse(await fs.readFile(path.join(dir, 'agent-chain-cursor.json')));
  assert.equal(cursor.next_block, 111); assert.equal(cursor.last_block_hash, hash(110));
  assert.ok(cursor.snapshots[11]);
  await h.poll(); assert.equal(observed(h.service).length, 2);
});

test('confirmations defer recent logs and all snapshot reads use the confirmed batch block', async () => {
  const chain = watcherChain(); chain.state.logs = [created(chain, 11, { height: 110 })];
  const h = await watcherService({ chain, confirmations: 3 });
  assert.equal((await h.poll()).last_block, 108); assert.equal(observed(h.service).length, 0);
  chain.state.latest = 112;
  await h.poll(); assert.equal(observed(h.service).length, 1);
  assert.ok(chain.state.calls.filter((c) => c.method === 'offerings' && c.blockTag !== undefined).every((c) => [108, 110].includes(c.blockTag)));
});

test('each log request is capped at 5000 blocks, empty batches advance and catching up gates execution', async () => {
  const h = await watcherService({ chain: watcherChain({ latest: 10150 }), batchBlocks: 9000 });
  assert.equal((await h.poll()).state, 'catching-up');
  assert.equal(h.watcher.saved.next_block, 5100);
  assert.equal(h.service.emergencyStopped, true);
  await h.poll(); await h.poll();
  assert.equal(h.watcher.saved.next_block, 10151);
  assert.equal(h.service.emergencyStopped, false);
  assert.ok(h.chain.state.calls.filter((c) => c.method === 'getLogs').every((c) => c.filter.toBlock - c.filter.fromBlock + 1 <= 5000));
});

test('restart resumes from the next block and restores a confirmed mirror without reprocessing logs', async (t) => {
  const dir = await tmp(t), chain = watcherChain(); chain.state.logs = [created(chain)];
  const first = await watcherService({ chain, dir }); await first.poll();
  await first.service.stop();
  const second = await watcherService({ chain, dir });
  await second.poll(); assert.equal(observed(second.service).length, 1);
  assert.equal(second.store.pools.get(oil.case_id).chainSnapshot.block_number, 110);
  chain.state.latest = 113;
  await second.poll(); assert.equal(chain.state.calls.filter((c) => c.method === 'getLogs').at(-1).filter.fromBlock, 111);
});

test('RPC failure keeps the cursor, sanitizes errors, backs off and recovers only on a fresh successful poll', async () => {
  const h = await watcherService(); await h.poll(); const before = h.watcher.saved.next_block;
  h.chain.state.latest += 1; h.chain.state.failLogs = true;
  const failed = await h.poll(); assert.equal(failed.state, 'degraded');
  assert.equal(h.watcher.saved.next_block, before); assert.equal(h.service.emergencyStopped, true);
  assert.ok(!JSON.stringify(failed).includes('credential'));
  const calls = h.chain.state.calls.length; await h.poll(); assert.equal(h.chain.state.calls.length, calls);
  h.advance(15000); h.chain.state.failLogs = false; await h.poll();
  assert.equal(h.watcher.saved.next_block, before + 1); assert.equal(h.service.emergencyStopped, false);
  assert.ok(h.service.activity.buffer.some((e) => e.action === 'CHAIN_WATCHER_RECOVERED'));
});

test('hung RPC is bounded and cannot fabricate observations or advance a cursor', async () => {
  const chain = watcherChain(); chain.provider.getLogs = async () => new Promise(() => {});
  const h = await watcherService({ chain, timeoutMs: 30 });
  assert.equal((await h.poll()).last_error.code, 'rpc_timeout');
  assert.equal(h.watcher.saved.next_block, 100); assert.equal(observed(h.service).length, 0);
});

test('a restart with changed chain addresses preserves the cursor and requires reconciliation', async (t) => {
  const dir = await tmp(t), chain = watcherChain(); const h = await watcherService({ chain, dir }); await h.poll();
  await h.service.stop();
  chain.chainConfig.contracts.AgentBLRWA = '0x2222222222222222222222222222222222222222';
  const second = await watcherService({ chain, dir });
  assert.equal((await second.poll()).last_error.code, 'cursor_config_mismatch');
  assert.equal(second.watcher.saved.next_block, 111);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'agent-chain-cursor.json'))).reconciliation_required, true);
});

for (const beforeDeployment of [true, false]) test(`v1 cursor migrates exactly ${beforeDeployment ? 'before' : 'after'} the independent Phase 7 deployment`, async (t) => {
  const dir = await tmp(t), chain = watcherChain();
  const logDeployment = structuredClone(chain.chainConfig.deployments.AgentDecisionLog);
  if (beforeDeployment) delete chain.chainConfig.deployments.AgentDecisionLog;
  const first = await watcherService({ chain, dir }); await first.poll(); await first.service.stop();
  const legacy = await legacyCursor(dir, chain);
  chain.chainConfig.deployments.AgentDecisionLog = logDeployment;
  const second = await watcherService({ chain, dir }); t.after(() => second.service.stop());
  assert.equal((await second.poll()).state, 'healthy');
  const migrated = JSON.parse(await fs.readFile(path.join(dir, 'agent-chain-cursor.json')));
  assert.equal(migrated.version, 2); assert.notEqual(migrated.identity, legacy.identity);
  assert.deepEqual(migrated, { ...legacy, version: 2, identity: migrated.identity });
  assert.equal(second.service.emergencyStopped, false);
});

test('v2 cursor ignores unrelated deployment metadata and retains every committed position', async (t) => {
  const dir = await tmp(t), chain = watcherChain(), first = await watcherService({ chain, dir });
  await first.poll(); const saved = structuredClone(first.watcher.saved); await first.service.stop();
  chain.chainConfig.deployments.AgentDecisionLog = { deployTx: hash(888), blockNumber: 999, versions: ['new-version'] };
  const second = await watcherService({ chain, dir }); t.after(() => second.service.stop());
  assert.equal((await second.poll()).state, 'healthy'); assert.deepEqual(second.watcher.saved, saved);
});

for (const [label, mutate, confirmations = 1] of [
  ['watched deployment', (chain) => { chain.chainConfig.deployments.RWAOfferingPool.blockNumber += 1; }],
  ['collateral registry address', (chain) => { chain.chainConfig.contracts.EBLRegistry = '0x2222222222222222222222222222222222222222'; }],
  ['confirmation depth', () => {}, 2]
]) test(`v2 cursor rejects a changed ${label}`, async (t) => {
  const dir = await tmp(t), chain = watcherChain(), first = await watcherService({ chain, dir });
  await first.poll(); const saved = structuredClone(first.watcher.saved); await first.service.stop(); mutate(chain);
  const second = await watcherService({ chain, dir, confirmations }); t.after(() => second.service.stop());
  assert.equal((await second.poll()).last_error.code, 'cursor_config_mismatch');
  assert.equal(second.watcher.saved.identity, saved.identity); assert.equal(second.watcher.saved.next_block, saved.next_block);
  assert.equal(second.service.emergencyStopped, true);
});

for (const label of ['watched deployment', 'canonical block', 'write failure', 'unresolved reconciliation']) test(`v1 migration preserves history on ${label}`, async (t) => {
  const dir = await tmp(t), chain = watcherChain(), first = await watcherService({ chain, dir });
  await first.poll(); await first.service.stop(); const legacy = await legacyCursor(dir, chain);
  if (label === 'watched deployment') chain.chainConfig.deployments.RWAOfferingPool.blockNumber += 1;
  if (label === 'canonical block') chain.state.blockOverrides.set(legacy.last_block, hash(999));
  if (label === 'unresolved reconciliation') {
    legacy.reconciliation_required = true;
    await fs.writeFile(path.join(dir, 'agent-chain-cursor.json'), JSON.stringify(legacy));
  }
  const second = await watcherService({ chain, dir }); t.after(() => second.service.stop());
  if (label === 'write failure') second.watcher.write = async () => { throw new Error('disk unavailable'); };
  const result = await second.poll();
  const expected = { 'watched deployment': 'cursor_config_mismatch', 'canonical block': 'chain_reorg',
    'write failure': 'poll_failed', 'unresolved reconciliation': 'reconciliation_required' }[label];
  assert.equal(result.last_error.code, expected); assert.equal(second.service.emergencyStopped, true);
  const stored = JSON.parse(await fs.readFile(path.join(dir, 'agent-chain-cursor.json')));
  assert.equal(stored.version, 1); assert.equal(stored.identity, legacy.identity);
  assert.equal(stored.next_block, legacy.next_block); assert.deepEqual(stored.snapshots, legacy.snapshots);
  if (label === 'write failure') assert.deepEqual(stored, legacy);
  else assert.equal(stored.reconciliation_required, true);
});

test('wrong RPC chain never accepts logs or changes a mirror', async () => {
  const chain = watcherChain(); chain.state.network = 1776; chain.state.logs = [created(chain)];
  const h = await watcherService({ chain });
  assert.equal((await h.poll()).last_error.code, 'chain_mismatch');
  assert.equal(h.watcher.saved, null); assert.equal(observed(h.service).length, 0);
});

test('a changed committed block freezes the original cursor and persists the reorg boundary', async (t) => {
  const dir = await tmp(t), h = await watcherService({ dir }); await h.poll();
  h.chain.state.latest = 111; h.chain.state.blockOverrides.set(110, hash(999));
  assert.equal((await h.poll()).last_error.code, 'chain_reorg');
  assert.equal(h.watcher.saved.last_block_hash, hash(110));
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'agent-chain-cursor.json'))).reconciliation_required, true);
  h.advance(30000); h.chain.state.blockOverrides.delete(110); await h.poll();
  assert.equal(h.watcher.saved.next_block, 111, 'No automatic rewind or release after the fork');
});

test('cursor corruption fails closed without replacing evidence', async (t) => {
  const dir = await tmp(t), file = path.join(dir, 'agent-chain-cursor.json'); await fs.writeFile(file, '{bad-json');
  const h = await watcherService({ dir });
  assert.equal((await h.poll()).state, 'degraded');
  assert.equal(await fs.readFile(file, 'utf8'), '{bad-json'); assert.equal(observed(h.service).length, 0);
});

for (const [name, mutate, code] of [
  ['removed', (log) => { log.removed = true; }, 'invalid_log'],
  ['wrong canonical hash', (log) => { log.blockHash = hash(999); }, 'chain_reorg'],
  ['wrong address', (log) => { log.address = '0x1111111111111111111111111111111111111111'; }, 'unexpected_log'],
  ['invalid watched payload', (log) => { log.data = '0x'; }, 'log_decode_failed'],
  ['pending index', (log) => { log.index = null; }, 'invalid_rpc_data']
]) test(`reject ${name} log without observation or cursor progress`, async () => {
  const chain = watcherChain(), log = created(chain); mutate(log); chain.state.logs = [log];
  const h = await watcherService({ chain }); assert.equal((await h.poll()).last_error.code, code);
  assert.equal(h.watcher.saved.next_block, 100); assert.equal(observed(h.service).length, 0);
});

test('conflicting duplicate positions fail instead of arbitrarily choosing one log', async () => {
  const chain = watcherChain(); chain.state.logs = [created(chain), chain.log('OfferingPaused', [11, hash(11)])];
  const h = await watcherService({ chain }); assert.equal((await h.poll()).last_error.code, 'conflicting_log');
  assert.equal(observed(h.service).length, 0);
});

test('every promised event ABI is watched and remains informational, including both non-pool contracts', async () => {
  const chain = watcherChain();
  for (const [contract, names] of Object.entries(WATCHED_EVENTS)) {
    const iface = new Interface(chain.chainConfig.abis[contract]);
    for (const name of names) {
      const fragment = iface.getEvent(name);
      const args = fragment.inputs.map((input) => input.name === 'poolId' ? 11n : input.name === 'eblId' ? 21n
        : input.type === 'bool' ? true : input.type === 'address' ? '0x1111111111111111111111111111111111111111'
          : input.type === 'bytes32' ? hash(777) : input.type === 'string' ? 'fixture' : 1n);
      chain.state.logs.push(chain.log(name, args, { contract, index: chain.state.logs.length }));
    }
  }
  const h = await watcherService({ chain }); assert.equal((await h.poll()).state, 'healthy');
  assert.equal(observed(h.service).length, Object.values(WATCHED_EVENTS).flat().length);
  assert.equal((await h.service.listDecisions()).count, 0);
  for (const event of observed(h.service)) if (['PaymentOracle', 'AgentBLRWA'].includes(event.event.data.contract)) assert.equal(event.event.chain_pool_id, undefined);
});

test('PaymentAttested correlates its SHA-256 case hash and does not assert trade repayment', async () => {
  const chain = watcherChain(); const { createHash } = await import('node:crypto');
  const caseIdHash = `0x${createHash('sha256').update(oil.case_id).digest('hex')}`;
  chain.state.logs = [chain.log('PaymentAttested', [hash(1), hash(2), caseIdHash, hash(3),
    '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', 1000n,
    '0x3333333333333333333333333333333333333333', 1n], { contract: 'PaymentOracle' })];
  const h = await watcherService({ chain }); await h.poll();
  assert.equal(observed(h.service)[0].event.case_id, oil.case_id);
  assert.equal(observed(h.service)[0].type, 'CHAIN_STATE_CHANGED');
  assert.equal(h.service.settlementEvidence.list().length, 0);
});

test('unknown cargo is registered for chain monitoring but excluded from risk and investor eligibility', async () => {
  const chain = watcherChain(); chain.state.pools.get(11).cargoHash = hash(123456); chain.state.logs = [created(chain)];
  const h = await watcherService({ chain }); await h.poll();
  const entry = h.service.registry.getByChainPoolId(11);
  assert.equal(entry.case_id, 'chain:1439:offering:11');
  const mirror = h.store.pools.get(entry.pool_id);
  assert.equal(mirror.chainOnly, true); assert.equal(mirror.investorEligible, false);
  assert.equal(mirror.quote.risk_level, 'UNKNOWN'); assert.equal(mirror.complianceStatus, 'UNKNOWN');
  assert.equal(h.store.pools.get(oil.case_id).chainSnapshot, undefined);
});

test('new terminal offerings remain history and existing CLI mappings are not replaced', async () => {
  const chain = watcherChain(); chain.state.pools.get(11).state = 9; chain.state.logs = [created(chain)];
  const h = await watcherService({ chain }); await h.poll();
  assert.equal(h.service.registry.getByChainPoolId(11).history_only, true);
  const first = h.service.registry.getByChainPoolId(2);
  chain.state.latest++; chain.state.logs = [created(chain, 2, { height: 111 })];
  await h.poll(); assert.deepEqual(h.service.registry.getByChainPoolId(2), first);
});

test('current stop takes effect before history replay; historical false cannot release a current chain stop', async () => {
  const chain = watcherChain(); chain.state.headStop = true;
  chain.state.logs = [chain.log('EmergencyStopSet', [false, '0x1111111111111111111111111111111111111111', hash(1)])];
  const h = await watcherService({ chain }); await h.poll();
  assert.equal(h.service.chainEmergencyStopped, true); assert.equal(h.service.emergencyStopped, true);
  await h.service.control({ action: 'emergency_stop', stopped: false });
  assert.equal(h.service.emergencyStopped, true);
  const status = await h.service.status(); assert.equal(status.emergency_stop_sources.local, false); assert.equal(status.emergency_stop_sources.chain, true);
});

test('chain stop release waits for confirmed state and preserves an independent local stop', async () => {
  const chain = watcherChain(); chain.state.headStop = false; chain.state.confirmedStop = true;
  const h = await watcherService({ chain, confirmations: 2 }); await h.poll();
  assert.equal(h.service.emergencyStopped, true);
  await h.service.control({ action: 'emergency_stop', stopped: true });
  chain.state.confirmedStop = false; chain.state.latest++; await h.poll();
  assert.equal(h.service.chainEmergencyStopped, false); assert.equal(h.service.emergencyStopped, true);
});

test('Demo mode makes no RPC calls, restores independent Demo mirrors and preserves the Live cursor', async () => {
  const h = await watcherService(); const original = structuredClone(h.store.pools.get(copper.case_id));
  h.chain.state.pools.get(2).state = 7; await h.poll(); assert.equal(h.store.pools.get(copper.case_id).status, 'Paused');
  const next = h.watcher.saved.next_block, calls = h.chain.state.calls.length;
  h.runtime.mode = 'demo'; h.runtime.generation++; await h.poll();
  assert.deepEqual(h.store.pools.get(copper.case_id), original); assert.equal(h.chain.state.calls.length, calls);
  assert.equal(h.watcher.saved.next_block, next); assert.equal((await h.service.status()).chain_watcher.state, 'inactive');
});

test('a mode switch while an RPC is in flight cannot inject chain logs into Demo or commit a cursor', async () => {
  const h = await watcherService(); let release;
  h.chain.provider.getLogs = () => new Promise((resolve) => { release = resolve; });
  const running = h.watcher.poll(h.service);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  h.runtime.mode = 'demo'; h.runtime.generation++; release([created(h.chain)]); await running;
  assert.equal(observed(h.service).length, 0); assert.equal(h.watcher.saved.next_block, 100);
  assert.equal(h.store.pools.get(oil.case_id).chainSnapshot, undefined);
});

test('overlapping polls share one request and never apply a batch twice', async () => {
  const h = await watcherService(); h.chain.state.logs = [created(h.chain)];
  await Promise.all([h.watcher.poll(h.service), h.watcher.poll(h.service)]); await h.service.bus.idle();
  assert.equal(h.chain.state.calls.filter((c) => c.method === 'getLogs').length, 1);
  assert.equal(observed(h.service).length, 1);
});

test('delivery failure keeps the cursor and retries the same log without another observation or decision', async () => {
  const h = await watcherService(); h.chain.state.logs = [created(h.chain)];
  const submit = h.service.submitEvent.bind(h.service); let failed = false;
  h.service.submitEvent = async (...args) => { const result = await submit(...args); if (!failed) { failed = true; throw new Error('after delivery'); } return result; };
  assert.equal((await h.poll()).state, 'degraded'); assert.equal(h.watcher.saved.next_block, 100);
  h.advance(15000); assert.equal((await h.poll()).state, 'healthy');
  assert.equal(observed(h.service).length, 1);
  assert.equal(h.service.activity.buffer.filter((e) => e.action === 'CHAIN_EVENT_OBSERVED').length, 1);
});

test('missing deployment block resolves the canonical deployment receipt and never guesses an origin', async () => {
  const chain = watcherChain(); delete chain.chainConfig.deployments.PaymentOracle.blockNumber;
  const h = await watcherService({ chain }); assert.equal((await h.poll()).start_block, 100);
  const bad = watcherChain(); delete bad.chainConfig.deployments.PaymentOracle.blockNumber;
  bad.provider.getTransactionReceipt = async () => ({ status: 1, contractAddress: bad.chainConfig.contracts.AgentBLRWA });
  const broken = await watcherService({ chain: bad }); assert.equal((await broken.poll()).last_error.code, 'deployment_receipt_invalid');
  assert.equal(broken.watcher.saved, null);
});

test('deployment start override cannot silently skip historical logs', async () => {
  const h = await watcherService(); h.watcher.startBlock = 105;
  assert.equal((await h.poll()).last_error.code, 'start_block_skips_deployment'); assert.equal(h.watcher.saved, null);
});

test('large atomic amounts remain exact strings and cannot acquire rounded UI prices', async () => {
  const h = await watcherService(); const exact = 900719925474099312345n;
  h.chain.state.pools.get(2).issuePrice = exact; await h.poll();
  const pool = h.store.pools.get(copper.case_id);
  assert.equal(pool.chainSnapshot.issue_price_atomic, exact.toString()); assert.equal(pool.chainIssuePriceUsd, null);
  assert.equal(pool.quote.quote_hash, quoteHashBefore(h));
});
function quoteHashBefore(h) { return h.watcher.backups.get(copper.case_id).quote.quote_hash; }

test('confirmed repayment proofs are observations and never fabricate a verified payment or SETTLE approval', async () => {
  const h = await watcherService(); Object.assign(h.chain.state.pools.get(11), { paymentProof: hash(8), arrivalProof: hash(9), repaymentAmount: 1234567n });
  h.chain.state.logs = [created(h.chain), h.chain.log('SettlementProofRecorded', [11, hash(8), hash(9)], { index: 1 })];
  await h.poll(); const mirror = h.store.pools.get(oil.case_id);
  assert.equal(mirror.settlement.repayment_amount_atomic, '1234567'); assert.equal(mirror.settlement.payment_verification, undefined);
  assert.equal(h.service.approvals.pendingCount(), 0); assert.equal(h.service.settlementEvidence.list().length, 0);
  assert.equal(mirror.chainSnapshot.payment_proof, hash(8)); assert.notEqual(mirror.chainSnapshot.arrival_proof, ZERO);
});

test('unavailable chain observation blocks every state-changing proposal, including PAUSE, while records remain available', () => {
  const ctx = { mode: 'live', autonomy: 'propose', chainObservationUnavailable: true };
  for (const action of ['OPEN', 'PAUSE', 'RESUME', 'REPRICE', 'SETTLE']) {
    const policy = evaluatePolicy({ action }, ctx);
    assert.equal(policy.verdict, 'REJECTED'); assert.equal(policy.reasons[0].rule, 'CHAIN_OBSERVATION_UNAVAILABLE');
  }
  assert.equal(evaluatePolicy({ action: 'WARNING' }, ctx).verdict, 'AUTO');
});

test('chain price drift is exposed without rewriting a priced quote hash or offering stale investor action cards', async () => {
  const h = await watcherService(); const before = structuredClone(h.store.pools.get(copper.case_id).quote);
  h.chain.state.pools.get(2).issuePrice = 777000n; await h.poll(); const pool = h.store.pools.get(copper.case_id);
  assert.deepEqual(pool.quote, before); assert.equal(pool.chainIssuePriceUsd, 0.777); assert.equal(pool.chainQuoteMismatch, true);
  assert.equal(poolCandidate(pool, null).eligible, false);
});

test('known collateral mismatch requires reconciliation rather than silently relinking a case', async () => {
  const h = await watcherService(); h.chain.state.pools.get(2).eblId = 888n;
  assert.equal((await h.poll()).last_error.code, 'ebl_mismatch');
  assert.equal(h.service.registry.getByChainPoolId(2).chain.ebl_id, 2);
  assert.equal(h.watcher.saved.next_block, 100);
});

test('mode-change notification immediately restores Demo scope before the next scheduled poll', async () => {
  const h = await watcherService(); const before = structuredClone(h.store.pools.get(copper.case_id));
  h.chain.state.pools.get(2).state = 7; await h.poll();
  h.runtime.mode = 'demo'; h.runtime.generation++; await h.service.onModeChanged();
  assert.deepEqual(h.store.pools.get(copper.case_id), before);
});

test('Demo reset discards old backup balances while preserving the Live cursor', async () => {
  const h = await watcherService(); h.store.pools.get(copper.case_id).subscribedUsd = 99; await h.poll();
  const cursor = h.watcher.saved.next_block;
  h.runtime.mode = 'demo'; h.runtime.generation++; h.store.pools.clear(); await h.service.resetDemo();
  assert.equal(h.store.pools.size, 0); assert.equal(h.watcher.saved.next_block, cursor);
});

test('cursor persistence failure retries an already delivered log without losing or duplicating its proof', async (t) => {
  const dir = await tmp(t), h = await watcherService({ dir }); h.chain.state.logs = [created(h.chain)];
  const original = h.watcher.file;
  h.watcher.file = path.join(dir, 'blocked-cursor'); await fs.mkdir(h.watcher.file);
  h.watcher.initialized = true; // Initialization already has the original cursor; fault the commit only.
  assert.equal((await h.poll()).state, 'degraded'); assert.equal(h.watcher.saved.next_block, 100);
  assert.equal(observed(h.service).length, 1);
  h.watcher.file = original; h.advance(15000); await h.poll();
  assert.equal(h.watcher.saved.next_block, 111); assert.equal(observed(h.service).length, 1);
});

test('an approved server action remains pending during a watcher outage and recovers after confirmation', async () => {
  const h = await watcherService(); await h.poll(); let sent = 0;
  h.service.getChain = async () => ({ execute: async (command) => {
    command.assertCurrent(); sent++; return { mode: 'chain', tx_hash: hash(98765), confirmed_events: ['PricingUpdated'], block_number: 111 };
  } });
  await h.service.submitEvent({ event_id: 'watch-approved-reprice', type: 'WORLD_RISK_UPDATED', case_id: copper.case_id,
    source: 'admin', source_mode: 'live', data: { events: [{ type: 'severe_weather', severity: 'warning', region: 'East China Sea', description: 'typhoon', date: '2026-10-15' }] } });
  await h.service.bus.idle();
  const approval = h.service.approvals.list({ status: 'PENDING' })[0]; assert.ok(approval);
  await h.service.approvals.approve(approval.approval_id, { by: 'test' });
  h.chain.state.latest++; h.chain.state.failLogs = true; await h.service.tick();
  assert.equal(sent, 0); assert.equal(h.service.approvals.get(approval.approval_id).status, 'APPROVED');
  await assert.rejects(h.service.approve(approval.approval_id), { code: 'chain_observation_unavailable' });
  h.chain.state.failLogs = false; h.advance(15000); await h.service.tick();
  assert.equal(sent, 1); assert.equal(h.service.approvals.get(approval.approval_id).status, 'EXECUTED');
});

test('an owner payment correction removes stale verification and decimal amounts from the Live mirror', async () => {
  const h = await watcherService(); h.store.pools.get(oil.case_id).settlement = {
    payment_proof: hash(123), repayment_amount_atomic: '999999', repayment_amount: '0.999999',
    payment_verification: { tx_hash: hash(123), amount_atomic: '999999' }
  };
  Object.assign(h.chain.state.pools.get(11), { paymentProof: hash(456), repaymentAmount: 1234567n });
  h.chain.state.logs = [created(h.chain)]; await h.poll();
  const proof = h.store.pools.get(oil.case_id).settlement;
  assert.equal(proof.payment_proof, hash(456)); assert.equal(proof.repayment_amount_atomic, '1234567');
  assert.equal(proof.payment_verification, undefined); assert.equal(proof.repayment_amount, undefined);
});
