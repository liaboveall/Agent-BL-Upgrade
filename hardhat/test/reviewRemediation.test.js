import { expect } from 'chai';
import { ACTION, STATE, TARGET, deployProtocol, newOffering, applyPricing, ethers, send, uniqueHash } from './helpers/protocol.js';

describe('2026-10-17 review invariants (local candidate v3)', () => {
  for (const stage of ['Open', 'Subscribed', 'Funded', 'InTransit']) {
    it(`preserves ${stage} through all price updates and pause/resume`, async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, `stage-${stage}`, { supply: 100n });
      if (stage !== 'Open') await send(ctx.pool.connect(ctx.investor).subscribe(poolId, stage === 'Funded' ? 100n : 50n));
      if (stage === 'InTransit') await send(ctx.pool.markInTransit(poolId, uniqueHash('departure')));
      const before = await ctx.pool.stateOf(poolId);
      for (const [action, price] of [[ACTION.REPRICE_DOWN, 700000n], [ACTION.OPEN_OFFERING, 750000n], [ACTION.OPEN_WITH_WARNING, 760000n]]) {
        await send(applyPricing(ctx, poolId, price, action));
        expect(await ctx.pool.stateOf(poolId)).to.equal(before);
      }
      expect(await ctx.pool.quoteVersion(poolId)).to.equal(4n);
      await send(applyPricing(ctx, poolId, 760000n, ACTION.PAUSE_OFFERING));
      await send(applyPricing(ctx, poolId, 760000n, ACTION.RESUME_OFFERING));
      expect(await ctx.pool.stateOf(poolId)).to.equal(before);
      if (stage === 'InTransit') await expect(ctx.pool.connect(ctx.investor).subscribe(poolId, 1n)).to.be.revertedWith('not open');
      else if (stage === 'Funded') {
        await send(ctx.pool.markInTransit(poolId, uniqueHash('departure')));
        expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.InTransit);
      } else await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 1n));
    });
  }

  it('retains collateral for one atomic unit of recovery; additional payments repay the original debt', async () => {
    const ctx = await deployProtocol();
    const { poolId, eblId } = await newOffering(ctx, 'partial', { supply: 100n });
    await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 100n));
    const proof = uniqueHash('payment');
    await send(ctx.pool.recordImporterPayment(poolId, proof, 1n));
    await send(ctx.pool.recordCargoArrival(poolId, uniqueHash('arrival')));
    await expect(ctx.pool.settle(poolId, 1n)).to.be.revertedWith('outstanding debt');
    expect(await ctx.pool.outstandingDebt(poolId)).to.equal(100n * TARGET - 1n);
    expect(await ctx.registry.pledgedTo(eblId)).to.equal(await ctx.pool.getAddress());
    await expect(ctx.registry.releasePledge(eblId)).to.be.revertedWith('not authorized');
    await expect(ctx.pool.recordAdditionalPayment(poolId, proof, TARGET)).to.be.revertedWith('payment proof reused');
    await send(ctx.pool.recordAdditionalPayment(poolId, uniqueHash('recovery'), 100n * TARGET - 1n));
    await send(ctx.pool.settle(poolId, 100n * TARGET));
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Repaid);
    expect(await ctx.registry.pledgedTo(eblId)).to.equal(ethers.ZeroAddress);
  });

  it('locks debt terms once shares are sold and records overdue loss resolution without calling it Repaid', async () => {
    const ctx = await deployProtocol();
    const { poolId, eblId } = await newOffering(ctx, 'loss', { supply: 100n });
    const block = await ethers.provider.getBlock('latest');
    await send(ctx.pool.setMaturity(poolId, block.timestamp + 100));
    await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 100n));
    await expect(ctx.pool.setMaturity(poolId, block.timestamp + 1000)).to.be.revertedWith('terms locked');
    await expect(ctx.pool.markDefault(poolId)).to.be.revertedWith('not overdue');
    await send(ctx.pool.recordImporterPayment(poolId, uniqueHash('partial-payment'), 10n * TARGET));
    await ethers.provider.send('evm_increaseTime', [101]); await ethers.provider.send('evm_mine', []);
    await send(ctx.pool.markDefault(poolId));
    expect(await ctx.registry.pledgedTo(eblId)).to.equal(await ctx.pool.getAddress());
    await expect(ctx.pool.connect(ctx.agent).settleLoss(poolId, uniqueHash('resolution'))).to.be.revertedWith('not owner');
    await send(ctx.pool.settleLoss(poolId, uniqueHash('resolution')));
    expect(await ctx.pool.stateOf(poolId)).to.equal(14n);
    expect(await ctx.pool.realizedLoss(poolId)).to.equal(90n * TARGET);
    expect(await ctx.registry.pledgedTo(eblId)).to.equal(ethers.ZeroAddress);
  });
});
