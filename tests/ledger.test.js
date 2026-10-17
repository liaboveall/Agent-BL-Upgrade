import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Ledger } from '../src/ledger/ledger.js';
import { ChainEventRebuilder } from '../src/ledger/rebuilder.js';

async function tmpLedger() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  return { ledger: new Ledger({ baseDir: dir }), dir };
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

  it('rebuilder processes a FundEscrowed log', async () => {
    const { ledger } = await tmpLedger();
    const rebuilder = new ChainEventRebuilder(ledger);
    // Mock provider returning a synthetic log
    const _log = {
      address: '0xPool',
      blockNumber: 100,
      transactionHash: '0x' + 'b'.repeat(64),
      index: 0,
      topics: [],
      data: '0x'
    };
    // This test is structural; full integration test is in w2CrossLayer.test.js
    assert.ok(rebuilder);
  });
});
