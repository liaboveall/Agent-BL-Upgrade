import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AbiCoder, Interface, Transaction, Wallet, getCreateAddress, keccak256 } from 'ethers';
import { CORE_V3, createProtocolV3Plan, executeProtocolV3Step, planDigest } from '../scripts/lib/protocol-v3-deployment.mjs';
import { createAgentService, loadChainConfig } from '../src/agent/runtime/factory.js';
import { PoolRegistry } from '../src/agent/runtime/poolRegistry.js';
import { cargoIdentityHashV2 } from '../src/chain/cargoIdentity.js';
import { watcherChain, watcherService, oil, hash } from './helpers/chainWatcher.js';

// Offline deterministic keys; never a configured account or a provider connection.
const owner = new Wallet(`0x${'11'.repeat(32)}`), updater = new Wallet(`0x${'22'.repeat(32)}`);
const artifacts = Object.fromEntries(CORE_V3.map((name) => [name, { bytecode: '0x60006000', deployedBytecode: '0x6000',
  abi: ['function owner() view returns (address)', ...(name === 'RWAOfferingPool' ? ['constructor(address,address)', 'function setOracle(address)', 'event OracleSet(address indexed oracle)']
    : name === 'RiskPricingOracle' ? ['constructor(address)', 'function setUpdater(address,bool)', 'event UpdaterSet(address indexed updater,bool allowed)']
      : name === 'RWAToken' ? ['function setPool(address)', 'event PoolSet(address indexed pool)'] : [])] }]));
const inventory = { chain_id: 1439, actors: { DEPLOYER_PRIVATE_KEY: { address: owner.address, nonce_latest: 39, nonce_pending: 39, balance_INJ: '0.6' }, PRICING_UPDATER_PRIVATE_KEY: { address: updater.address } },
  owners: Object.fromEntries(CORE_V3.map((name) => [name, owner.address])), pools: [{ pool_id: 2, subscribed: '0' }, { pool_id: 3, subscribed: '0' }] };
const makePlan = (overrides = {}) => createProtocolV3Plan({ inventory, chainRegistry: { networks: { 'injective-testnet': { contracts: {} } } }, artifacts, gasPrice: 160000000n, sourceCommit: '8afdb2c', ...overrides });

test('v3 deployment: the only seven transactions are four creations and necessary wiring; exact nonces, gas and artifacts are bound', async () => {
  const plan = await makePlan();
  assert.deepEqual(plan.transactions.map((t) => t.label), ['deploy:EBLRegistry', 'deploy:RWAToken', 'deploy:RWAOfferingPool', 'deploy:RiskPricingOracle', 'RWAToken.setPool', 'RWAOfferingPool.setOracle', 'RiskPricingOracle.setUpdater']);
  assert.deepEqual(plan.transactions.map((t) => t.nonce), [39, 40, 41, 42, 43, 44, 45]);
  assert.equal(plan.addresses.RWAOfferingPool, getCreateAddress({ from: owner.address, nonce: 41 }));
  assert.equal(BigInt(plan.maximum_fee_wei), 10800000n * 160000000n);
  const old = planDigest(plan); const changed = structuredClone(plan); changed.transactions[6].args[0] = owner.address;
  assert.notEqual(planDigest(changed), old);
  await assert.rejects(makePlan({ gasPrice: 1000000000n }), /fee ceiling/u);
  const pending = structuredClone(inventory); pending.actors.DEPLOYER_PRIVATE_KEY.nonce_pending++;
  await assert.rejects(makePlan({ inventory: pending }), /pending owner/u);
  const held = structuredClone(inventory); held.pools[0].subscribed = '1';
  await assert.rejects(makePlan({ inventory: held }), /separate migration/u);
});

function fakeChain(plan) {
  const entries = new Map(), txs = new Map(), receipts = new Map();
  const state = { broadcasts: 0, nonce: 39, acceptedTimeout: false, estimate: 100000n, canonical: '0xaaa' };
  const journal = { withLock: async (_id, fn) => fn(), read: async (_id, i) => entries.get(i), write: async (_id, i, value) => entries.set(i, value) };
  const provider = {
    send: async (method) => method === 'eth_chainId' ? '0x59f' : method === 'eth_gasPrice' ? '0x9896800' : `0x${state.nonce.toString(16)}`,
    estimateGas: async () => state.estimate,
    broadcastTransaction: async (raw) => {
      state.broadcasts++; const tx = Transaction.from(raw); txs.set(tx.hash, tx); state.nonce++;
      const index = tx.nonce - 39, step = plan.transactions[index];
      const event = step.expected_event ? new Interface(artifacts[step.contract].abi).encodeEventLog(step.expected_event, step.args) : null;
      receipts.set(tx.hash, { hash: tx.hash, status: 1, blockNumber: 100 + index, blockHash: '0xaaa', contractAddress: step.address ?? null,
        gasUsed: 100000n, gasPrice: tx.gasPrice, logs: event ? [{ address: step.to, ...event }] : [] });
      if (state.acceptedTimeout) { state.acceptedTimeout = false; throw new Error('RPC timed out after acceptance'); }
      return { hash: tx.hash };
    },
    getTransactionReceipt: async (hash) => receipts.get(hash), getTransaction: async (hash) => txs.get(hash),
    getBlock: async () => ({ hash: state.canonical }), getCode: async () => '0x6000',
    call: async () => AbiCoder.defaultAbiCoder().encode(['address'], [owner.address])
  };
  return { provider, journal, state, entries, txs, receipts };
}

test('v3 deployment: an accepted broadcast timeout reconciles the same hash; all seven receipts and exact wiring events verify', async () => {
  const plan = await makePlan(), chain = fakeChain(plan);
  const run = (stepIndex) => executeProtocolV3Step({ plan, stepIndex, owner, artifacts, ...chain, waitMs: 1 });
  chain.state.acceptedTimeout = true;
  await assert.rejects(run(0), /RPC timed out/u);
  assert.equal(chain.entries.get(0).status, 'BROADCASTING');
  assert.ok(!JSON.stringify(chain.entries.get(0)).includes(owner.privateKey));
  assert.equal((await run(0)).status, 'CONFIRMED'); assert.equal(chain.state.broadcasts, 1);
  for (let i = 1; i < 7; i++) assert.equal((await run(i)).status, 'CONFIRMED');
  assert.equal(chain.state.broadcasts, 7);
  await run(6); assert.equal(chain.state.broadcasts, 7, 'a confirmed initialization is never resent');
  chain.state.canonical = '0xbbb'; await assert.rejects(run(6), /canonical block/u);
});

test('v3 deployment: changed artifacts, wrong nonce, missing dependencies and excess estimates all stop before signing/broadcast', async () => {
  const plan = await makePlan(), chain = fakeChain(plan);
  const run = (stepIndex, extra = {}) => executeProtocolV3Step({ plan, stepIndex, owner, artifacts, ...chain, waitMs: 1, ...extra });
  await assert.rejects(run(1), /earlier transaction/u);
  chain.state.nonce++; await assert.rejects(run(0), /Nonce changed/u); chain.state.nonce--;
  chain.state.estimate = 6000000n; await assert.rejects(run(0), /gas limit/u);
  const changed = structuredClone(artifacts); changed.EBLRegistry.bytecode = '0x6001';
  await assert.rejects(run(0, { artifacts: changed }), /Artifacts changed/u);
  assert.equal(chain.state.broadcasts, 0); assert.equal(chain.entries.size, 0);
});

test('v3 runtime: replacement addresses isolate persisted approvals and pool numbers; legacy state is retained', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-v3-scope-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const oldFile = path.join(dir, 'agent-pools.json'); await fs.writeFile(oldFile, JSON.stringify({ pools: [{ case_id: 'OLD', chain: { pool_id: 2 } }] }));
  const c = { ...loadChainConfig(), protocolVersion: 3, knownLivePools: [], contracts: { ...loadChainConfig().contracts, RWAOfferingPool: updater.address } };
  const service = createAgentService({ chainConfig: c, dir, env: {}, store: { pools: new Map(), agentActivities: [] }, monitors: false, chainWatcher: false });
  assert.match(service.registry.file, /protocol-v3-0x[0-9a-f]{40}/u);
  await service.registry.init(); assert.equal(service.registry.get('OLD'), null);
  assert.equal(JSON.parse(await fs.readFile(oldFile, 'utf8')).pools[0].case_id, 'OLD');
  assert.deepEqual(service.config.protectedChainPools, []);
  const reader = { readPool: async (id) => ({ exists: true, eblId: id, state: 'Open' }) };
  await service.registry.linkChain({ case_id: 'NEW', chain_pool_id: 1 }, reader);
  assert.equal(service.registry.get('NEW').history_only, false);
  assert.deepEqual(await service.registry.bootstrapLive(reader, []), []);
  const legacy = new PoolRegistry(); await assert.rejects(legacy.linkChain({ case_id: 'OLD', chain_pool_id: 1 }, reader), { code: 'history_pool' });
  const other = createAgentService({ chainConfig: { ...c, contracts: { ...c.contracts, RWAOfferingPool: owner.address } }, dir, env: {}, monitors: false, chainWatcher: false });
  assert.notEqual(service.registry.file, other.registry.file);
  assert.equal(keccak256(artifacts.EBLRegistry.bytecode), (await makePlan()).bytecode_hashes.EBLRegistry.creation);
});

test('v3 watcher: a replacement pool with number 2 resolves its title instead of the historical copper case', async (t) => {
  const chain = watcherChain();
  chain.chainConfig.protocolVersion = 3; chain.chainConfig.knownLivePools = [];
  chain.state.pools.clear();
  const pool = chain.addPool(2, oil, { cargoHash: cargoIdentityHashV2(oil) });
  chain.state.logs = [chain.log('OfferingCreated', [2, pool.eblId, pool.tokenSupply, pool.issuePrice, pool.targetRedemptionValue])];
  const h = await watcherService({ chain }); t.after(() => h.service.stop());
  await h.poll();
  assert.equal(h.service.registry.getByChainPoolId(2).case_id, oil.case_id);
  assert.equal(h.service.registry.isProtected(oil.case_id), false);
});

test('v3 watcher: a reviewed epoch can omit archived auxiliary history but cannot skip new core or unarchived history', async (t) => {
  const build = async () => {
    const chain = watcherChain();
    const c = chain.chainConfig;
    c.protocolVersion = 3; c.knownLivePools = []; c.watcherStartBlock = 100;
    for (const name of ['PaymentOracle', 'AgentBLRWA']) c.deployments[name].blockNumber = 80;
    c.legacyProtocols = [{ protocolVersion: 2, config: { contracts: { ...c.contracts }, deployments: structuredClone(c.deployments) } }];
    const h = await watcherService({ chain }); h.watcher.startBlock = 100;
    t.after(() => h.service.stop()); return h;
  };
  const valid = await build(); await valid.poll();
  assert.equal(valid.watcher.status().state, 'healthy');
  assert.equal(valid.watcher.saved.start_block, 100);
  const receiptArchive = await build(), c = receiptArchive.chain.chainConfig;
  const deployment = { address: c.contracts.PaymentOracle, deployTx: hash(55) };
  c.deployments.PaymentOracle = deployment;
  c.legacyProtocols[0].config.deployments.PaymentOracle = { ...deployment };
  receiptArchive.chain.provider.getTransactionReceipt = async () => ({ status: 1, contractAddress: deployment.address,
    hash: deployment.deployTx, blockNumber: 80, blockHash: hash(80) });
  await receiptArchive.poll(); assert.equal(receiptArchive.watcher.status().state, 'healthy', 'an archived deployment receipt also binds old auxiliary history');
  const wrongArchive = await build(); wrongArchive.chain.chainConfig.legacyProtocols[0].config.contracts.PaymentOracle = updater.address;
  await wrongArchive.poll(); assert.equal(wrongArchive.watcher.status().last_error.code, 'start_block_skips_deployment');
  const skippedCore = await build(); skippedCore.chain.chainConfig.deployments.RWAOfferingPool.blockNumber = 99;
  await skippedCore.poll(); assert.equal(skippedCore.watcher.status().last_error.code, 'start_block_skips_deployment');
});
