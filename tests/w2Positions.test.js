import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPositionView } from '../src/ledger/positionView.js';

describe('position view', () => {
  it('merges demo and live positions', () => {
    const view = buildPositionView({
      wallet: '0xA',
      demoInvestments: [{ walletAddress: '0xa', poolId: 'demo-1', tokenCount: 10, amountUsd: 8 }],
      ledgerPositions: [{ investor: '0xa', protocol_instance: { chain_id: 1439, pool_address: '0xP', protocol_version: 5 }, chain_pool_id: 1, asset: '0xU', shares: '5', cost_atomic: '4', claimed_atomic: '0', status: 'active' }]
    });
    assert.equal(view.length, 2);
    assert.equal(view[0].mode, 'demo');
    assert.equal(view[1].mode, 'live');
  });

  it('falls back to ledger shares when no chain balance is supplied', () => {
    const view = buildPositionView({
      wallet: '0xB',
      ledgerPositions: [{ investor: '0xb', protocol_instance: { chain_id: 1, pool_address: '0xP', protocol_version: 5 }, chain_pool_id: 2, asset: '0xU', shares: '7', cost_atomic: '6', claimed_atomic: '1', status: 'active' }]
    });
    assert.equal(view.length, 1);
    assert.equal(view[0].shares, '7');
    assert.equal(view[0].status, 'reconciling');
    assert.equal(view[0].claimable_atomic, null);
  });

  it('prefers chain balance when supplied', () => {
    const chainBalances = new Map();
    chainBalances.set('1:0xP:2', 9n);
    const view = buildPositionView({
      wallet: '0xC',
      ledgerPositions: [{ investor: '0xc', protocol_instance: { chain_id: 1, pool_address: '0xP', protocol_version: 5 }, chain_pool_id: 2, asset: '0xU', shares: '7', cost_atomic: '6', claimed_atomic: '0', status: 'active' }],
      chainBalances
    });
    assert.equal(view[0].shares, '9');
    assert.equal(view[0].status, 'reconciling');
  });
});

describe('confirmed position boundaries', () => {
  const pi = { chain_id: 1439, pool_address: `0x${'1'.repeat(40)}`, protocol_version: 5 };
  const pos = { position_id: 'paid', investor: '0xabc', protocol_instance: pi, chain_pool_id: 1,
    asset: `0x${'2'.repeat(40)}`, shares: '5', cost_atomic: '4000000', claimed_atomic: '0', status: 'active' };
  it('exposes only the requested wallet and uses exact atomic claim amounts', () => {
    const chainPositions = new Map([[`${pi.chain_id}:${pi.pool_address}:5:1`, { shares: '5', claimable_atomic: '4999999', state: 'Repaid', canonical: true, block_number: 12 }]]);
    const [view] = buildPositionView({ wallet: '0xAbC', ledgerPositions: [pos, { ...pos, investor: '0xdef' }], chainPositions });
    assert.equal(view.claimable_atomic, '4999999'); assert.equal(view.reconciled, true); assert.equal(view.confirmed_block, 12);
  });
  it('does not invent paid cost or claimable proceeds for unknown chain balances', () => {
    const chainPositions = new Map([[`${pi.chain_id}:${pi.pool_address}:5:2`, { protocol_instance: pi, chain_pool_id: 2, shares: '9' }]]);
    const [view] = buildPositionView({ wallet: '0xabc', chainPositions });
    assert.equal(view.cost_atomic, null); assert.equal(view.claimable_atomic, null); assert.equal(view.status, 'reconciling');
  });
  it('does not infer current claimable money from a stale ledger snapshot or a balance mismatch', () => {
    for (const snapshot of [undefined, { shares: '6', claimable_atomic: '9', canonical: true }, { shares: '5', claimable_atomic: '9', canonical: false }]) {
      const chainPositions = snapshot ? new Map([[`${pi.chain_id}:${pi.pool_address}:5:1`, snapshot]]) : new Map();
      const [view] = buildPositionView({ wallet: '0xabc', ledgerPositions: [pos], chainPositions });
      assert.equal(view.claimable_atomic, null); assert.equal(view.status, 'reconciling');
    }
  });
});
