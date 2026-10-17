import { expect } from 'chai';
import { STATE, TARGET, ISSUE_PRICE, send, uniqueHash, deployProtocolV5, newOfferingV5, ethers } from './helpers/protocolV5.js';

describe('protocol v5 W2 regressions', () => {
  async function now() { return BigInt((await ethers.provider.getBlock('latest')).timestamp); }

  it('escrows funds and mints shares atomically on subscribe', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'sub-ok', { supply: 10n });
    const shares = 5n;
    const cost = shares * ISSUE_PRICE;
    await send(ctx.usdc.mint(ctx.investor.address, cost));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), cost));
    await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, shares, ISSUE_PRICE, 1n, (await now()) + 600n));
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Subscribed);
    expect(await ctx.usdc.balanceOf(await ctx.pool.getAddress())).to.equal(cost);
    expect(await ctx.token.balanceOf(poolId, ctx.investor.address)).to.equal(shares);
  });

  it('reverts if transfer fails, leaving no shares', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'sub-fail', { supply: 10n });
    await expect(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 5n, ISSUE_PRICE, 1n, (await now()) + 600n))
      .to.revert(ethers);
    expect(await ctx.token.balanceOf(poolId, ctx.investor.address)).to.equal(0n);
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(0n);
    expect(await ctx.usdc.balanceOf(await ctx.pool.getAddress())).to.equal(0n);
  });

  it('rejects subscription after deadline', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, deadline } = await newOfferingV5(ctx, 'sub-late', { deadlineIn: 10 });
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(deadline) + 1]);
    await ethers.provider.send('evm_mine', []);
    await expect(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 1n, ISSUE_PRICE, 1n, (await now()) + 600n))
      .to.be.revertedWithCustomError(ctx.pool, 'SubscriptionDeadlineElapsed');
  });

  it('refunds investors when minRaise is not met', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, deadline } = await newOfferingV5(ctx, 'refund', { supply: 10n, minRaise: 10n * ISSUE_PRICE });
    const shares = 5n;
    const cost = shares * ISSUE_PRICE;
    await send(ctx.usdc.mint(ctx.investor.address, cost));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), cost));
    await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, shares, ISSUE_PRICE, 1n, (await now()) + 600n));
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(deadline) + 1]);
    await ethers.provider.send('evm_mine', []);
    const before = await ctx.usdc.balanceOf(ctx.investor.address);
    await send(ctx.pool.refundInvestor(poolId, ctx.investor.address));
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(before + cost);
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Cancelled);
  });

  it('disburses escrow to exporter after funded', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'disburse', { supply: 10n });
    const cost = 10n * ISSUE_PRICE;
    await send(ctx.usdc.mint(ctx.investor.address, cost));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), cost));
    await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 10n, ISSUE_PRICE, 1n, (await now()) + 600n));
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Funded);
    const before = await ctx.usdc.balanceOf(ctx.exporter.address);
    await send(ctx.pool.disburseToExporter(poolId, cost, ctx.exporter.address, uniqueHash('disburse')));
    expect(await ctx.usdc.balanceOf(ctx.exporter.address)).to.equal(before + cost);
  });

  it('emits RepaymentReceived when exporter repays', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'repay-event', { supply: 10n });
    const cost = 10n * ISSUE_PRICE;
    await send(ctx.usdc.mint(ctx.investor.address, cost));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), cost));
    await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 10n, ISSUE_PRICE, 1n, (await now()) + 600n));
    await send(ctx.pool.disburseToExporter(poolId, cost, ctx.exporter.address, uniqueHash('disburse')));
    const recovery = 10n * TARGET;
    await send(ctx.usdc.mint(ctx.exporter.address, recovery));
    await send(ctx.usdc.connect(ctx.exporter).approve(await ctx.pool.getAddress(), recovery));
    await expect(ctx.pool.connect(ctx.exporter).repay(poolId, recovery))
      .to.emit(ctx.pool, 'RepaymentReceived')
      .withArgs(poolId, await ctx.usdc.getAddress(), ctx.exporter.address, recovery);
  });

  it('lets investors claim pro-rata after settlement', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'claim', { supply: 10n });
    const cost = 10n * ISSUE_PRICE;
    await send(ctx.usdc.mint(ctx.investor.address, cost));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), cost));
    await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 10n, ISSUE_PRICE, 1n, (await now()) + 600n));
    await send(ctx.pool.disburseToExporter(poolId, cost, ctx.exporter.address, uniqueHash('disburse')));
    const recovery = 10n * TARGET;
    await send(ctx.usdc.mint(ctx.exporter.address, recovery));
    await send(ctx.usdc.connect(ctx.exporter).approve(await ctx.pool.getAddress(), recovery));
    await send(ctx.pool.connect(ctx.exporter).repay(poolId, recovery));
    await send(ctx.pool.recordImporterPayment(poolId, uniqueHash('payment'), recovery));
    await send(ctx.pool.recordCargoArrival(poolId, uniqueHash('arrival')));
    await send(ctx.pool.settle(poolId, recovery));
    const before = await ctx.usdc.balanceOf(ctx.investor.address);
    await send(ctx.pool.connect(ctx.investor).claim(poolId));
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(before + recovery);
    expect(await ctx.token.balanceOf(poolId, ctx.investor.address)).to.equal(0n);
  });

  it('distributes partial recovery correctly in LossSettled', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, maturity } = await newOfferingV5(ctx, 'loss', { supply: 10n });
    const cost = 10n * ISSUE_PRICE;
    await send(ctx.usdc.mint(ctx.investor.address, cost));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), cost));
    await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 10n, ISSUE_PRICE, 1n, (await now()) + 600n));
    await send(ctx.pool.disburseToExporter(poolId, cost, ctx.exporter.address, uniqueHash('disburse')));
    const recovery = 5n * TARGET;
    await send(ctx.usdc.mint(ctx.exporter.address, recovery));
    await send(ctx.usdc.connect(ctx.exporter).approve(await ctx.pool.getAddress(), recovery));
    await send(ctx.pool.connect(ctx.exporter).repay(poolId, recovery));
    await send(ctx.pool.recordImporterPayment(poolId, uniqueHash('payment'), recovery));
    await send(ctx.pool.recordCargoArrival(poolId, uniqueHash('arrival')));
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(maturity) + 1]);
    await ethers.provider.send('evm_mine', []);
    await send(ctx.pool.markDefault(poolId));
    await send(ctx.pool.settleLoss(poolId, uniqueHash('resolution')));
    const before = await ctx.usdc.balanceOf(ctx.investor.address);
    await send(ctx.pool.connect(ctx.investor).claim(poolId));
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(before + recovery);
  });
});
