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
