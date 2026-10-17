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
  });
});
