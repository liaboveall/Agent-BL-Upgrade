import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { AGENT_LOG_ABI, createAnchorChainAdapter } from '../src/agent/runtime/anchorChain.js';
import { createAgentVersion } from '../src/agent/runtime/agentVersion.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { hashSnapshot } from '../src/agent/decisionLogger.js';



const version = createAgentVersion(loadAgentConfig({}), {}, hashSnapshot('test source'));
const address = `0x${'12'.repeat(20)}`, signer = `0x${'34'.repeat(20)}`, other = `0x${'56'.repeat(20)}`;
const txHash = hashSnapshot('transaction'), blockHash = hashSnapshot('block');
function fixture() {
  const batch = { batch_id: 1, mode: 'live', status: 'ANCHORED', from_seq: 1, to_seq: 1, count: 1, version_id: version.version_id,
    merkle_root: hashSnapshot('root'), chain_id: 1439, contract_address: address, anchorer: signer, from_block: 100,
    tx_hash: txHash, block_hash: blockHash };
  const iface = new Interface(AGENT_LOG_ABI), events = [];
  const encoded = iface.encodeEventLog(iface.getEvent('DecisionBatchAnchored'), [1, batch.merkle_root, 1, 1, 1, version.version_id, signer]);
  const state = { sent: 0, network: '0x59f', code: '0x6000', latest: 102,
    registered: { registeredAt: 1n, policyHash: version.policy_hash, codeCommit: version.code_commit, modelId: version.model_id },
    chainBatch: { merkleRoot: batch.merkle_root, fromSeq: 1n, toSeq: 1n, count: 1n, versionId: version.version_id },
    receipt: { status: 1, to: address, from: signer, blockNumber: 101, blockHash, logs: [{ address, ...encoded }] },
    block: { hash: blockHash }, transaction: { to: address, from: signer, value: 0n, chainId: 1439n,
      data: iface.encodeFunctionData('anchorBatch', [batch.merkle_root, 1, 1, 1, version.version_id]) },
    lastSeq: 0n, batchCount: 0n, allowed: true, observations: [] };
  const log = { interface: iface, anchorers: async () => state.allowed, versions: async () => state.registered,
    lastSeq: async () => state.lastSeq, batchCount: async () => state.batchCount, batches: async () => state.chainBatch,
    verifyInclusion: async () => true, queryFilter: async () => state.observations, filters: { DecisionBatchAnchored: () => 'filter' },
    anchorBatch: Object.assign(async () => { state.sent++; events.push('send'); return { hash: txHash, wait: async () => { events.push('wait'); } }; },
      { staticCall: async () => { events.push('static'); } }) };
  const ctx = { decisionLog: log, signers: { ANCHORER: signer }, provider: { send: async () => state.network,
    getCode: async () => state.code, getBlockNumber: async () => state.latest, getBlock: async () => state.block,
    getTransaction: async () => state.transaction, getTransactionReceipt: async () => state.receipt } };
  const chainConfig = { chainIdDecimal: 1439, contracts: { AgentDecisionLog: address },
    deployments: { AgentDecisionLog: { deployTx: hashSnapshot('deployment') } }, explorerBase: 'https://explorer.example' };
  const adapter = createAnchorChainAdapter({ chainConfig, getContext: async () => ctx, confirmations: 2,
    runExclusive: async (task) => { events.push('lock'); try { return await task(); } finally { events.push('unlock'); } } });
  return { batch, state, adapter, ctx, chainConfig, events, iface };
}

test('anchor preflight requires the deployed testnet, exact version, explicit signer role and continuous head', async () => {
  const { adapter, batch } = fixture();
  assert.deepEqual(await adapter.prepare(batch, version), { chain_id: 1439, contract_address: address, from_block: 102, anchorer: signer });
  const changes = [(f) => { f.state.network = '0x1'; }, (f) => { f.state.code = '0x'; },
    (f) => { f.state.registered.modelId = 'different'; }, (f) => { f.state.registered.policyHash = hashSnapshot('other'); },
    (f) => { f.state.registered.codeCommit = hashSnapshot('other'); }, (f) => { f.state.registered.registeredAt = 0n; },
    (f) => { f.state.allowed = false; }, (f) => { delete f.ctx.signers.ANCHORER; },
    (f) => { f.state.lastSeq = 2n; }, (f) => { f.state.batchCount = 2n; }, (f) => { delete f.chainConfig.deployments.AgentDecisionLog; }];
  for (const change of changes) { const f = fixture(); change(f); await assert.rejects(f.adapter.prepare(f.batch, version)); assert.equal(f.state.sent, 0); }
});

test('anchor broadcast shares the signer lock, static-preflights and persists hash before waiting', async () => {
  const { batch, adapter, state, events } = fixture();
  await adapter.send(batch, () => events.push('current'), async () => events.push('saved'));
  assert.equal(state.sent, 1);
  assert.deepEqual(events, ['lock', 'static', 'current', 'send', 'saved', 'wait', 'unlock']);
  await assert.rejects(adapter.send(batch, () => { throw new Error('mode changed'); })); assert.equal(state.sent, 1);
});

test('confirmed anchors require exact calldata, sender, receipt event, current canonical block and chain batch', async () => {
  const f = fixture(); const confirmed = await f.adapter.confirm(f.batch);
  assert.equal(confirmed.block_hash, blockHash); assert.match(confirmed.explorer_url, /\/tx\/0x/u);
  for (const mutate of [(s) => { s.receipt.status = 0; }, (s) => { s.receipt.to = other; }, (s) => { s.receipt.from = other; },
    (s) => { s.block.hash = hashSnapshot('reorg'); }, (s) => { s.transaction.data = '0x'; }, (s) => { s.transaction.value = 1n; },
    (s) => { s.transaction.chainId = 1n; }, (s) => { s.transaction.from = other; }, (s) => { s.transaction.to = other; },
    (s) => { s.receipt.logs[0].address = other; }, (s) => { s.receipt.logs = []; }, (s) => { s.chainBatch.count = 2n; },
    (s) => { s.chainBatch.merkleRoot = hashSnapshot('different'); }]) {
    const f = fixture(); mutate(f.state); await assert.rejects(f.adapter.confirm(f.batch)); assert.equal(f.state.sent, 0);
  }
});

test('pending or underconfirmed anchors are never reported as confirmed; changed deployment bindings fail closed', async () => {
  const f = fixture(); f.state.receipt = null; assert.equal(await f.adapter.confirm(f.batch), null);
  const under = fixture(); under.state.latest = 101; assert.equal(await under.adapter.confirm(under.batch), null);
  for (const patch of [{ chain_id: 1 }, { contract_address: other }]) await assert.rejects(f.adapter.confirm({ ...f.batch, ...patch }));
});

test('broadcast recovery uses one exact event in a bounded scan, with no send or inferred hash', async () => {
  const f = fixture();
  const event = { args: { ...f.state.chainBatch, anchorer: signer }, transactionHash: txHash };
  assert.equal(await f.adapter.locate(f.batch), null);
  f.state.observations = [event]; assert.equal(await f.adapter.locate(f.batch), txHash);
  f.state.observations.push(event); assert.equal(await f.adapter.locate(f.batch), null);
  f.state.observations = [{ ...event, args: { ...event.args, anchorer: other } }]; assert.equal(await f.adapter.locate(f.batch), null);
  f.state.latest = 50101; await assert.rejects(f.adapter.locate(f.batch), /bounded/u); assert.equal(f.state.sent, 0);
});

test('chain verification rechecks finality and inclusion instead of trusting a stored ANCHORED label', async () => {
  const f = fixture(); const result = { mode: 'live', batch: f.batch, leaf: hashSnapshot('leaf'), proof: [] };
  assert.equal(await f.adapter.verify(result), true);
  f.ctx.decisionLog.verifyInclusion = async () => false; assert.equal(await f.adapter.verify(result), false);
  f.ctx.decisionLog.verifyInclusion = async () => true;
  assert.equal(await f.adapter.verify({ ...result, mode: 'demo' }), false);
  assert.equal(await f.adapter.verify({ ...result, batch: { ...f.batch, block_hash: hashSnapshot('old-fork') } }), false);
});
