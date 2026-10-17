import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Interface } from 'ethers';
import { Ledger } from '../src/ledger/ledger.js';
import { ChainEventRebuilder } from '../src/ledger/rebuilder.js';
import { PROTOCOL_V5_ABI } from '../src/chain/protocolV5Abi.js';

async function tmpLedger() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  return { ledger: new Ledger({ baseDir: dir }), dir };
}

const ZERO_BYTES32 = '0x' + '0'.repeat(64);

function makeProvider({ logsByBlock = {}, callResults = {} } = {}) {
  let callCount = 0;
  return {
    callCount: () => callCount,
    async getLogs(filter) {
      const from = Number(filter.fromBlock);
      const to = Number(filter.toBlock);
      const out = [];
      for (const [blockStr, logs] of Object.entries(logsByBlock)) {
        const bn = Number(blockStr);
        if (bn >= from && bn <= to) out.push(...logs);
      }
      return out;
    },
    async call({ to, data }) {
      callCount += 1;
      const key = `${to.toLowerCase()}:${data}`;
      if (key in callResults) return callResults[key];
      throw new Error(`unexpected provider.call ${key}`);
    }
  };
}

function encodeLog(iface, eventName, args, overrides = {}) {
  const fragment = iface.getEvent(eventName);
  const encoded = iface.encodeEventLog(fragment, Object.values(args));
  return {
    address: overrides.address ?? '0x' + '1'.repeat(40),
    blockNumber: overrides.blockNumber ?? 100,
    transactionHash: overrides.transactionHash ?? '0x' + 'a'.repeat(64),
    index: overrides.index ?? 0,
    topics: encoded.topics,
    data: encoded.data
  };
}

function offeringsCallData(iface, poolId) {
  return iface.encodeFunctionData('offerings', [poolId]);
}

function offeringsResult(iface, settlementAsset) {
  return iface.encodeFunctionResult('offerings', [
    0n, 0n, 0n, 0n, 0n, 0n, ZERO_BYTES32, ZERO_BYTES32, settlementAsset, 0n, 0n, 0, true
  ]);
}

describe('Ledger', () => {
  it('records and confirms an intent', async () => {
    const { ledger } = await tmpLedger();
    const pi = { chain_id: 1439, pool_address: '0xPool', protocol_version: 5 };
    const intent = await ledger.recordIntent({ protocol_instance: pi, chain_pool_id: 1, operation: 'SUBSCRIBE', investor: '0xA', asset: '0xUSDC', amount_atomic: 100n, shares: 10n });
    assert.equal(intent.status, 'draft');
    await ledger.confirmIntent(intent.intent_id, '0x' + 'a'.repeat(64), 123);
    const intents = await ledger.writer.readIntents((i) => i.intent_id === intent.intent_id);
    assert.equal(intents[intents.length - 1].status, 'confirmed');
  });

  it('rebuilds positions from deposit and claim events', async () => {
    const { ledger } = await tmpLedger();
    const pi = { chain_id: 1439, pool_address: '0xPool', protocol_version: 5 };
    await ledger.rebuildFromEvents([
      { protocol_instance: pi, chain_pool_id: 1, investor: '0xA', asset: '0xUSDC', kind: 'INVESTOR_DEPOSIT', amount_atomic: '80', shares: '100' },
      { protocol_instance: pi, chain_pool_id: 1, investor: '0xA', asset: '0xUSDC', kind: 'CLAIM', amount_atomic: '95', shares: '100' }
    ]);
    const positions = await ledger.listPositions(pi);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].shares, '0');
    assert.equal(positions[0].claimed_atomic, '95');
    assert.equal(positions[0].status, 'fully_claimed');
  });

  it('refunds a position', async () => {
    const { ledger } = await tmpLedger();
    const pi = { chain_id: 1439, pool_address: '0xPool', protocol_version: 5 };
    await ledger.rebuildFromEvents([
      { protocol_instance: pi, chain_pool_id: 1, investor: '0xA', asset: '0xUSDC', kind: 'INVESTOR_DEPOSIT', amount_atomic: '80', shares: '100' },
      { protocol_instance: pi, chain_pool_id: 1, investor: '0xA', asset: '0xUSDC', kind: 'REFUND', amount_atomic: '80', shares: '0' }
    ]);
    const positions = await ledger.listPositions(pi);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].status, 'refunded');
    assert.equal(positions[0].shares, '0');
    assert.equal(positions[0].cost_atomic, '0');
  });
});

describe('ChainEventRebuilder', () => {
  const iface = new Interface(PROTOCOL_V5_ABI.RWAOfferingPool);
  const poolAddress = '0x' + '1'.repeat(40);
  const settlementAsset = '0x' + '2'.repeat(40);
  const investor = '0x' + '3'.repeat(40);

  function providerWithLogs(logsByBlock) {
    return makeProvider({
      logsByBlock,
      callResults: {
        [`${poolAddress.toLowerCase()}:${offeringsCallData(iface, 1n)}`]: offeringsResult(iface, settlementAsset)
      }
    });
  }

  it('parses FundEscrowed and Claimed logs into entries and positions', async () => {
    const { ledger } = await tmpLedger();
    const rebuilder = new ChainEventRebuilder(ledger);
    const depositTx = '0x' + 'b'.repeat(64);
    const claimTx = '0x' + 'c'.repeat(64);
    const provider = providerWithLogs({
      100: [
        encodeLog(iface, 'FundEscrowed', {
          poolId: 1n,
          asset: settlementAsset,
          investor,
          amountAtomic: 80n,
          shares: 100n
        }, { address: poolAddress, blockNumber: 100, transactionHash: depositTx, index: 0 }),
        encodeLog(iface, 'Claimed', {
          poolId: 1n,
          investor,
          asset: settlementAsset,
          amountAtomic: 95n,
          sharesBurned: 100n
        }, { address: poolAddress, blockNumber: 100, transactionHash: claimTx, index: 1 })
      ]
    });

    const { positions, cursor } = await rebuilder.rebuild({
      provider, poolAddress, chainId: 1439, protocolVersion: 5, fromBlock: 100, toBlock: 100
    });

    assert.equal(positions.length, 1);
    assert.equal(positions[0].investor, investor.toLowerCase());
    assert.equal(positions[0].asset, settlementAsset.toLowerCase());
    assert.equal(positions[0].shares, '0');
    assert.equal(positions[0].claimed_atomic, '95');
    assert.equal(positions[0].status, 'fully_claimed');
    assert.equal(cursor.last_block, 100);

    const entries = await ledger.writer.readCashEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].kind, 'INVESTOR_DEPOSIT');
    assert.equal(entries[0].source.tx_hash, depositTx.toLowerCase());
    assert.equal(entries[0].source.log_index, 0);
    assert.equal(entries[1].kind, 'CLAIM');
    assert.equal(entries[1].source.tx_hash, claimTx.toLowerCase());
    assert.equal(entries[1].source.log_index, 1);
  });

  it('skips duplicate entries by tx_hash and log_index', async () => {
    const { ledger } = await tmpLedger();
    const rebuilder = new ChainEventRebuilder(ledger);
    const depositTx = '0x' + 'd'.repeat(64);
    const provider = providerWithLogs({
      100: [
        encodeLog(iface, 'FundEscrowed', {
          poolId: 1n,
          asset: settlementAsset,
          investor,
          amountAtomic: 80n,
          shares: 100n
        }, { address: poolAddress, blockNumber: 100, transactionHash: depositTx, index: 0 })
      ]
    });

    await rebuilder.rebuild({
      provider, poolAddress, chainId: 1439, protocolVersion: 5, fromBlock: 100, toBlock: 100
    });

    const { cursor } = await rebuilder.rebuild({
      provider, poolAddress, chainId: 1439, protocolVersion: 5, fromBlock: 100, toBlock: 101
    });

    const entries = await ledger.writer.readCashEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].amount_atomic, '80');
    assert.equal(cursor.last_block, 101);
  });

  it('records LiquidationRecoveryRecorded and AdditionalPaymentRecorded as RECOVERY entries using settlement asset', async () => {
    const { ledger } = await tmpLedger();
    const rebuilder = new ChainEventRebuilder(ledger);
    const tx1 = '0x' + 'e'.repeat(64);
    const tx2 = '0x' + 'f'.repeat(64);
    const provider = providerWithLogs({
      200: [
        encodeLog(iface, 'LiquidationRecoveryRecorded', {
          poolId: 1n,
          paymentProof: '0x' + 'c1'.repeat(32),
          amount: 50n,
          totalRecovered: 50n
        }, { address: poolAddress, blockNumber: 200, transactionHash: tx1, index: 0 }),
        encodeLog(iface, 'AdditionalPaymentRecorded', {
          poolId: 1n,
          paymentProof: '0x' + 'c2'.repeat(32),
          amount: 30n,
          totalRecovered: 80n
        }, { address: poolAddress, blockNumber: 200, transactionHash: tx2, index: 1 })
      ]
    });

    const { positions } = await rebuilder.rebuild({
      provider, poolAddress, chainId: 1439, protocolVersion: 5, fromBlock: 200, toBlock: 200
    });

    assert.equal(positions.length, 0);
    assert.equal(provider.callCount(), 1);

    const entries = await ledger.writer.readCashEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].kind, 'RECOVERY');
    assert.equal(entries[0].asset, settlementAsset.toLowerCase());
    assert.equal(entries[0].amount_atomic, '50');
    assert.equal(entries[0].evidence_hash, '0x' + 'c1'.repeat(32));
    assert.equal(entries[0].source.log_index, 0);
    assert.equal(entries[1].kind, 'RECOVERY');
    assert.equal(entries[1].asset, settlementAsset.toLowerCase());
    assert.equal(entries[1].amount_atomic, '30');
    assert.equal(entries[1].evidence_hash, '0x' + 'c2'.repeat(32));
    assert.equal(entries[1].source.log_index, 1);
  });

  it('records DisbursedToExporter and FeeDeducted as non-position cash entries', async () => {
    const { ledger } = await tmpLedger();
    const rebuilder = new ChainEventRebuilder(ledger);
    const tx1 = '0x' + 'a1'.repeat(32);
    const tx2 = '0x' + 'a2'.repeat(32);
    const provider = providerWithLogs({
      300: [
        encodeLog(iface, 'DisbursedToExporter', {
          poolId: 1n,
          asset: settlementAsset,
          amountAtomic: 60n,
          evidenceHash: '0x' + 'd1'.repeat(32)
        }, { address: poolAddress, blockNumber: 300, transactionHash: tx1, index: 0 }),
        encodeLog(iface, 'FeeDeducted', {
          poolId: 1n,
          asset: settlementAsset,
          feeAtomic: 5n,
          feeEvidenceHash: '0x' + 'd2'.repeat(32)
        }, { address: poolAddress, blockNumber: 300, transactionHash: tx2, index: 1 })
      ]
    });

    const { positions } = await rebuilder.rebuild({
      provider, poolAddress, chainId: 1439, protocolVersion: 5, fromBlock: 300, toBlock: 300
    });

    assert.equal(positions.length, 0);
    const entries = await ledger.writer.readCashEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].kind, 'DISBURSEMENT');
    assert.equal(entries[0].amount_atomic, '60');
    assert.equal(entries[1].kind, 'FEE');
    assert.equal(entries[1].amount_atomic, '5');
  });
});
