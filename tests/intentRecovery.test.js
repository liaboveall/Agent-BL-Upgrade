// What a saved wallet operation becomes when the wallet refuses to send it, when its transaction fails on chain, and
// when its nonce is reused (application review F2, F3). Synthetic RPC, real ledger, service and wallet adapter.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { Interface } from 'ethers';
import { Ledger } from '../src/ledger/ledger.js';
import { CapitalLedgerService } from '../src/ledger/service.js';
import { PROTOCOL_V5_ABI } from '../src/chain/protocolV5Abi.js';
import { claimPosition } from '../web/src/lib/web3.js';

const pool = `0x${'11'.repeat(20)}`, wallet = `0x${'22'.repeat(20)}`, asset = `0x${'33'.repeat(20)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const iface = new Interface(PROTOCOL_V5_ABI.RWAOfferingPool);
const instance = { chain_id: 31337, pool_address: pool, protocol_version: 5 };
const claim = (poolId = 1) => ({ protocol_instance: instance, chain_pool_id: poolId, operation: 'CLAIM', investor: wallet, asset, amount_atomic: '10', shares: '1', created_block: 1,
  calldata: iface.encodeFunctionData('claim', [poolId]) });
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;

const temporary = [];
after(() => Promise.all(temporary.map((dir) => fs.rm(dir, { recursive: true, force: true }))));
async function harness() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-intents-'));
  temporary.push(baseDir);
  const ledger = new Ledger({ baseDir });
  const chain = { latest: 7, pending: 7, transactions: new Map(), receipts: new Map() };
  const provider = {
    getNetwork: async () => ({ chainId: 31337n }), getBlockNumber: async () => 10,
    call: async () => iface.encodeFunctionResult('protocolVersion', [5]),
    getBlock: async (number) => ({ number, hash: blockHash, timestamp: 1_800_000_000, transactions: [] }),
    getLogs: async () => [],
    getTransaction: async (txHash) => chain.transactions.get(txHash) ?? null,
    getTransactionReceipt: async (txHash) => chain.receipts.get(txHash) ?? null,
    getTransactionCount: async (_address, tag) => tag === 'pending' ? chain.pending : chain.latest
  };
  const capital = new CapitalLedgerService({ ledger, chainConfig: { protocolVersion: 5, chainIdDecimal: 31337, contracts: { RWAOfferingPool: pool }, deployments: { RWAOfferingPool: { blockNumber: 0 } } },
    getContext: async () => ({ provider }), getMode: () => 'live' });
  const mined = (intent, txHash, { status }) => {
    chain.transactions.set(txHash, { hash: txHash, to: pool, from: wallet, data: intent.calldata, value: 0n, chainId: 31337n, nonce: intent.broadcast_nonce, blockNumber: 3 });
    chain.receipts.set(txHash, { status, blockNumber: 3, blockHash, hash: txHash, logs: [] });
  };
  return { ledger, chain, capital, mined };
}

test('a canonical failed receipt ends the operation as reverted and frees the wallet (F3)', async () => {
  const { ledger, chain, capital, mined } = await harness();
  const intent = await capital.checkpointBroadcast((await ledger.recordIntent(claim())).intent_id);
  mined(intent, hash(1), { status: 0 });
  assert.equal((await capital.attach(intent.intent_id, hash(1))).status, 'reverted');
  const again = await capital.recoverIntent(intent.intent_id);
  assert.equal(again.status, 'reverted');
  assert.equal(again.block_hash, blockHash);
  // No cash moved, so nothing blocks the next operation of this wallet.
  const next = await ledger.recordIntent(claim(2));
  assert.equal((await capital.checkpointBroadcast(next.intent_id)).status, 'broadcast_prepared');

  // A receipt that disappears (a reorganisation) re-opens the failure for reconciliation.
  chain.receipts.delete(hash(1));
  assert.equal((await capital.recoverIntent(intent.intent_id)).status, 'reconciliation_required');
});

test('a receipt that is not yet deep or not canonical leaves the operation open', async () => {
  const { ledger, chain, capital, mined } = await harness();
  capital.confirmations = 20;
  const intent = await capital.checkpointBroadcast((await ledger.recordIntent(claim())).intent_id);
  mined(intent, hash(2), { status: 0 });
  assert.equal((await capital.attach(intent.intent_id, hash(2))).status, 'broadcast');
  capital.confirmations = 1;
  chain.receipts.set(hash(2), { ...chain.receipts.get(hash(2)), blockHash: `0x${'ef'.repeat(32)}` });
  assert.equal((await capital.recoverIntent(intent.intent_id)).status, 'broadcast');
  await assert.rejects(ledger.checkpointBroadcast((await ledger.recordIntent(claim(2))).intent_id, { nonce: 8, block: 11 }), { code: 'wallet_reconciliation_required' });
});

test('a wallet that refuses to send releases the checkpoint, and the retry reuses its nonce (F2)', async () => {
  const { ledger, chain, capital } = await harness();
  let prompts = 0;
  const intents = [];
  const refusingPool = { interface: iface, claim: Object.assign(async () => { prompts += 1; throw Object.assign(new Error('Synthetic wallet rejected request'), { code: 4001 }); }, { staticCall: async () => {} }) };
  const session = { address: wallet, signer: {}, provider: { request: async ({ method }) => method === 'eth_chainId' ? '0x7a69' : [wallet] } };
  const options = { getSession: () => session, ethersFn: async () => ({ Contract: class { constructor() { return refusingPool; } } }),
    getConfig: async () => ({ protocolVersion: 5, chainIdDecimal: 31337, contracts: { RWAOfferingPool: pool }, abis: { RWAOfferingPool: PROTOCOL_V5_ABI.RWAOfferingPool } }),
    prepareClaim: async () => { const intent = await ledger.recordIntent(claim()); intents.push(intent); return intent; },
    beforeBroadcast: (intent) => capital.checkpointBroadcast(intent.intent_id) };
  const position = { protocol_instance: instance, chain_pool_id: 1, investor: wallet, asset, reconciled: true };

  await assert.rejects(claimPosition(position, options), { code: 4001 });
  const first = await ledger.getIntent(intents[0].intent_id);
  assert.equal(first.status, 'broadcast_prepared');
  assert.deepEqual((await capital.openIntents(wallet)).map((intent) => intent.intent_id), [first.intent_id], 'another browser can find it');
  await assert.rejects(claimPosition(position, options), { code: 'wallet_reconciliation_required', details: { intent_ids: [first.intent_id] } });

  assert.equal((await capital.releaseIntent(first.intent_id)).status, 'released');
  await assert.rejects(claimPosition(position, options), { code: 4001 });
  const retry = await ledger.getIntent(intents.at(-1).intent_id);
  assert.equal(retry.broadcast_nonce, first.broadcast_nonce, 'the retry takes the released nonce');
  assert.equal(prompts, 2);

  // A transaction in the mempool on the reserved nonce stops the next send until it is mined.
  assert.equal((await capital.releaseIntent(retry.intent_id)).status, 'released');
  chain.pending = 8;
  await assert.rejects(capital.checkpointBroadcast((await ledger.recordIntent(claim())).intent_id), { code: 'wallet_nonce_pending' });
});

test('a release is refused while the node still knows the transaction, and a draft is simply abandoned', async () => {
  const { ledger, chain, capital } = await harness();
  const intent = await capital.checkpointBroadcast((await ledger.recordIntent(claim())).intent_id);
  chain.transactions.set(hash(3), { hash: hash(3), to: pool, from: wallet, data: intent.calldata, value: 0n, chainId: 31337n, nonce: intent.broadcast_nonce, blockNumber: null });
  await capital.attach(intent.intent_id, hash(3));
  await assert.rejects(capital.releaseIntent(intent.intent_id), { code: 'transaction_pending' });
  // Dropped by the node and the nonce still unused: the wallet may release it.
  chain.transactions.delete(hash(3));
  assert.equal((await capital.releaseIntent(intent.intent_id)).status, 'released');
  assert.equal((await capital.releaseIntent((await ledger.recordIntent(claim(2))).intent_id)).status, 'abandoned');
  await assert.rejects(ledger.checkpointBroadcast((await ledger.recordIntent(claim(3))).intent_id, { nonce: intent.broadcast_nonce + 1, block: 12 }), { code: 'wallet_nonce_reserved' });
});

test('a nonce another transaction took ends the operation only once that transaction is deep; a reorganisation re-opens it (A03)', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-intents-'));
  temporary.push(baseDir);
  const ledger = new Ledger({ baseDir });
  // The wallet's nonce 7 is used at block 10 by a plain transfer to itself, not by the saved claim.
  const chain = { latest: 10, reorg: false, reads: 0 };
  const canonical = (number) => chain.reorg && number >= 10 ? `0x${'bb'.repeat(32)}` : `0x${'aa'.repeat(32)}`;
  const other = { hash: hash(1), from: wallet, to: wallet, nonce: 7, data: '0x', value: 0n, chainId: 31337n, blockNumber: 10 };
  const count = (tag) => chain.reorg ? 7 : typeof tag === 'number' && tag < 10 ? 7 : 8;
  const provider = {
    getNetwork: async () => ({ chainId: 31337n }), getBlockNumber: async () => { chain.reads += 1; return chain.latest; },
    call: async () => iface.encodeFunctionResult('protocolVersion', [5]), getLogs: async () => [],
    getBlock: async (number) => { chain.reads += 1; return { number, hash: canonical(number), timestamp: 1_800_000_000, transactions: !chain.reorg && number === 10 ? [other.hash] : [] }; },
    getTransaction: async () => { chain.reads += 1; return chain.reorg ? null : other; },
    getTransactionReceipt: async () => { chain.reads += 1; return chain.reorg ? null : { status: 1, blockNumber: 10, blockHash: canonical(10), hash: other.hash, logs: [] }; },
    getTransactionCount: async (_address, tag) => { chain.reads += 1; return count(tag); }
  };
  const capital = new CapitalLedgerService({ ledger, confirmations: 3, getMode: () => 'live', getContext: async () => ({ provider }),
    chainConfig: { protocolVersion: 5, chainIdDecimal: 31337, contracts: { RWAOfferingPool: pool }, deployments: { RWAOfferingPool: { blockNumber: 0 } } } });
  const original = await ledger.recordIntent({ ...claim(), created_block: 8 });
  await ledger.checkpointBroadcast(original.intent_id, { nonce: 7, block: 9 });

  // One block deep is not enough: the operation keeps blocking this wallet and stays listed.
  const shallow = await capital.recoverIntent(original.intent_id);
  assert.equal(shallow.status, 'broadcast_prepared');
  assert.equal(shallow.confirmation_pending, true);
  assert.deepEqual((await capital.openIntents(wallet)).map((intent) => intent.intent_id), [original.intent_id]);
  await assert.rejects(ledger.checkpointBroadcast((await ledger.recordIntent(claim(2))).intent_id, { nonce: 8, block: 11 }), { code: 'wallet_reconciliation_required' });

  // Three blocks deep, canonical: now it can never be mined, and the block that proves it is kept.
  chain.latest = 12;
  const superseded = await capital.recoverIntent(original.intent_id);
  assert.equal(superseded.status, 'superseded');
  assert.equal(superseded.superseded_block_number, 10);
  assert.equal(superseded.superseded_block_hash, canonical(10));
  assert.equal(superseded.superseded_from, 'broadcast_prepared');
  await capital.sync();

  // The block is reorganised away: the ledger replay returns the operation to what it was before.
  chain.reorg = true;
  await capital.sync();
  const reopened = await ledger.getIntent(original.intent_id);
  assert.equal(reopened.status, 'broadcast_prepared');
  assert.equal(reopened.superseded_by_tx_hash, null);
  assert.deepEqual((await capital.openIntents(wallet)).map((intent) => intent.intent_id), [original.intent_id]);

  // A recovery reads the chain again instead of trusting the earlier verdict.
  const before = chain.reads;
  const recovered = await capital.recoverIntent(original.intent_id);
  assert.ok(chain.reads > before);
  assert.equal(recovered.status, 'broadcast_prepared');
  assert.equal(recovered.reconciliation_required, true);
});

test('a superseded operation whose recorded transaction disappeared is re-opened by recovery alone (A03)', async () => {
  const { ledger, chain, capital } = await harness();
  const intent = await capital.checkpointBroadcast((await ledger.recordIntent(claim())).intent_id);
  await ledger.supersedeIntent(intent.intent_id, { by_tx_hash: hash(9), block_number: 3, block_hash: blockHash });
  // The node no longer knows the superseding transaction and the nonce is unused again.
  chain.latest = intent.broadcast_nonce;
  const recovered = await capital.recoverIntent(intent.intent_id);
  assert.equal(recovered.status, 'broadcast_prepared');
  assert.equal((await ledger.getIntent(intent.intent_id)).reopened_by, 'chain_reorganization');
});
