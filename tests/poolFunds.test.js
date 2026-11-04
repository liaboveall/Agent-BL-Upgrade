// The pool detail's "where the money is" (web/src/lib/pool-funds.js) must use the contract's own formulas
// (RWAOfferingPoolV5.targetDistribution and outstandingDebt under cumulative claims); tests/rightsRecovery.integration.js
// compares it with the deployed contract after a partial draw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fundsBreakdown } from '../web/src/lib/pool-funds.js';

const row = (values) => ({ state: 'InTransit', subscribed: '10', redemption_per_share_atomic: '1000000', recovered_atomic: '0', ...values });

test('the target scales with what was drawn: P + ceil((G - P) x L / P), undrawn principal earns nothing on top', () => {
  // The assessment's example: P = 8, G = 10, L = 4 gives 9, and 4 of it is still escrowed undrawn principal.
  const half = fundsBreakdown(row({ raised_atomic: '8000000', disbursed_atomic: '4000000', escrow_atomic: '4000000' }));
  assert.deepEqual([half.target, half.undrawn, half.outstanding, half.claimed], [9000000n, 4000000n, 5000000n, 0n]);
  assert.equal(fundsBreakdown(row({ raised_atomic: '8000000', disbursed_atomic: '8000000', escrow_atomic: '0' })).target, 10000000n);
  assert.equal(fundsBreakdown(row({ raised_atomic: '8000000', disbursed_atomic: '0', escrow_atomic: '8000000' })).target, 8000000n);
  // Rounds up like Math.mulDiv(..., Ceil): 8 + ceil(2 x 1 / 8) atomic units.
  assert.equal(fundsBreakdown(row({ raised_atomic: '8', disbursed_atomic: '1', subscribed: '10', redemption_per_share_atomic: '1' })).target, 9n);
});

test('a loss settlement shows what was recovered and claimed, and the gap that later recoveries can still close', () => {
  // Public testnet pool #1 as read on 2026-11-04: raised and drew 8, recovered and paid out 4.00001.
  const loss = fundsBreakdown(row({ state: 'LossSettled', raised_atomic: '8000000', disbursed_atomic: '8000000', recovered_atomic: '4000010', escrow_atomic: '0' }));
  assert.deepEqual([loss.target, loss.recovered, loss.claimed, loss.escrow, loss.outstanding], [10000000n, 4000010n, 4000010n, 0n, 5999990n]);
  // Fully covered: nothing is owed.
  assert.equal(fundsBreakdown(row({ state: 'Repaid', raised_atomic: '8000000', disbursed_atomic: '8000000', recovered_atomic: '10000000', escrow_atomic: '10000000' })).outstanding, 0n);
});

test('nothing is computed for a pool without principal or a cancelled one, and an unknown escrow stays unknown', () => {
  assert.equal(fundsBreakdown(row({ raised_atomic: '0', disbursed_atomic: '0' })), null);
  assert.equal(fundsBreakdown(row({ state: 'Cancelled', raised_atomic: '2400000', disbursed_atomic: '0' })), null);
  const unread = fundsBreakdown(row({ raised_atomic: '8000000', disbursed_atomic: '0' }));
  assert.deepEqual([unread.escrow, unread.claimed], [null, null]);
});
