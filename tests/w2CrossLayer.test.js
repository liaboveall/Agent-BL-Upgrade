import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runHardhatNode, stopHardhatNode, deployAndRunW2Lifecycle, cleanupTmpLedger } from './helpers/ledgerTestHarness.js';

describe('W2 cross-layer lifecycle', { skip: process.env.CI === 'true' }, () => {
  let node;

  before(async () => {
    node = await runHardhatNode();
  });

  after(() => {
    stopHardhatNode(node);
  });

  it('deploys v5 and records a Live subscription in the ledger', async () => {
    assert.ok(node);
    const ctx = await deployAndRunW2Lifecycle();
    try {
      assert.equal(ctx.positions.length, 1, 'ledger should contain one investor position');
      const position = ctx.positions[0];
      assert.equal(position.investor, ctx.investor.address.toLowerCase());
      assert.equal(position.asset, (await ctx.usdc.getAddress()).toLowerCase());
      assert.equal(position.chain_pool_id, Number(ctx.poolId));
      assert.equal(position.shares, '0', 'all shares should be burned after claim');
      assert.equal(position.cost_atomic, String(ctx.cost));
      assert.equal(position.claimed_atomic, String(ctx.cost));
      assert.equal(position.status, 'fully_claimed');

      assert.equal(ctx.view.length, 1, 'position view should surface the live position');
      assert.equal(ctx.view[0].mode, 'live');
      assert.equal(ctx.view[0].shares, '0');
      assert.equal(ctx.view[0].cost_atomic, String(ctx.cost));
      assert.equal(ctx.view[0].claimed_atomic, String(ctx.cost));
    } finally {
      await cleanupTmpLedger(ctx.ledgerDir);
      await ctx.provider.destroy();
    }
  });
});
