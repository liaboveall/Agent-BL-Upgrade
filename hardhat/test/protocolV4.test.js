// W1 closure regressions for A01/A02/A05/A06/A07/A08.
//
// These tests describe the required business behaviour, not just the current implementation:
// every state that can be entered has an authorised exit, terms are bound at creation, and a
// pricing/subscription decision cannot outlive the version, order or deadline it was approved for.
import { expect } from 'chai';
import { ACTION, ISSUE_PRICE, STATE, TARGET, applyPricing, deployProtocol, ethers, newOffering, send, uniqueHash } from './helpers/protocol.js';

async function now() {
  return (await ethers.provider.getBlock('latest')).timestamp;
}

async function advance(seconds) {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
}

// Set the timestamp of the next mined block; the transaction under test mines it.
async function setNextTimestamp(timestamp) {
  await ethers.provider.send('evm_setNextBlockTimestamp', [Number(timestamp)]);
}

async function createWithTerms(ctx, tag, { supply = 100n, maturityIn = 1_000, deadlineIn = 100 } = {}) {
  await send(ctx.registry.mintEBL(ethers.id(`metadata:${tag}`), ctx.owner.address));
  const eblId = (await ctx.registry.nextEblId()) - 1n;
  await send(ctx.registry.pledge(eblId, await ctx.pool.getAddress()));
  const start = await now();
  const maturity = start + maturityIn;
  const deadline = start + deadlineIn;
  await send(ctx.pool.createOfferingWithTerms(eblId, supply, ISSUE_PRICE, TARGET, maturity, deadline));
  return { eblId, poolId: (await ctx.pool.nextPoolId()) - 1n, maturity, deadline };
}

async function quote(ctx, poolId, { price = ISSUE_PRICE, risk = 1, action = ACTION.PAUSE_OFFERING,
  version, validUntil, seq, evidence = uniqueHash('evidence'), quoteHash = uniqueHash('quote') } = {}) {
  const expectedVersion = version ?? await ctx.pool.quoteVersion(poolId);
  const valid = validUntil ?? (await now()) + 3_600;
  const sequence = seq ?? (await ctx.oracle.lastDecisionSeq(poolId)) + 1n;
  return ctx.oracle.updatePricing(poolId, price, risk, action, evidence, quoteHash, expectedVersion, valid, sequence);
}

describe('protocol v4 W1 regressions', () => {
  describe('A01: Liquidation always has an authorised exit', () => {
    it('records partial recovery entry by entry and closes as LossSettled without early release', async () => {
      const ctx = await deployProtocol();
      const { poolId, eblId } = await newOffering(ctx, 'liq-partial', { supply: 10n });
      await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 10n));
      await send(applyPricing(ctx, poolId, ISSUE_PRICE, ACTION.TRIGGER_LIQUIDATION, 3));
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Liquidation);

      await send(ctx.pool.connect(ctx.agent).recordLiquidationRecovery(poolId, uniqueHash('recovery-1'), 4n * TARGET));
      await send(ctx.pool.connect(ctx.agent).recordLiquidationRecovery(poolId, uniqueHash('recovery-2'), 1n * TARGET));
      expect(await ctx.pool.outstandingDebt(poolId)).to.equal(5n * TARGET);
      expect(await ctx.registry.pledgedTo(eblId)).to.equal(await ctx.pool.getAddress());

      await send(ctx.pool.resolveLiquidation(poolId, uniqueHash('resolution')));
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.LossSettled);
      expect(await ctx.pool.realizedLoss(poolId)).to.equal(5n * TARGET);
      expect(await ctx.registry.pledgedTo(eblId)).to.equal(ethers.ZeroAddress);
      await expect(ctx.pool.resolveLiquidation(poolId, uniqueHash('again'))).to.be.revertedWith('not liquidating');
    });

    it('closes full recovery as Repaid and a zero-recovery liquidation as LossSettled', async () => {
      const ctx = await deployProtocol();
      const full = await newOffering(ctx, 'liq-full', { supply: 10n });
      await send(ctx.pool.connect(ctx.investor).subscribe(full.poolId, 10n));
      await send(applyPricing(ctx, full.poolId, ISSUE_PRICE, ACTION.TRIGGER_LIQUIDATION, 3));
      await send(ctx.pool.connect(ctx.agent).recordLiquidationRecovery(full.poolId, uniqueHash('full-recovery'), 10n * TARGET));
      await send(ctx.pool.resolveLiquidation(full.poolId, uniqueHash('full-resolution')));
      expect(await ctx.pool.stateOf(full.poolId)).to.equal(STATE.Repaid);

      const zero = await newOffering(ctx, 'liq-zero', { supply: 10n });
      await send(ctx.pool.connect(ctx.investor).subscribe(zero.poolId, 10n));
      await send(applyPricing(ctx, zero.poolId, ISSUE_PRICE, ACTION.TRIGGER_LIQUIDATION, 3));
      await send(ctx.pool.resolveLiquidation(zero.poolId, uniqueHash('zero-resolution')));
      expect(await ctx.pool.stateOf(zero.poolId)).to.equal(STATE.LossSettled);
      expect(await ctx.pool.realizedLoss(zero.poolId)).to.equal(10n * TARGET);
    });

    it('returns an unsubscribed liquidation to Cancelled and releases the pledge', async () => {
      const ctx = await deployProtocol();
      const { poolId, eblId } = await newOffering(ctx, 'liq-empty');
      await send(applyPricing(ctx, poolId, ISSUE_PRICE, ACTION.TRIGGER_LIQUIDATION, 3));
      await send(ctx.pool.resolveLiquidation(poolId, uniqueHash('empty-resolution')));
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Cancelled);
      expect(await ctx.registry.pledgedTo(eblId)).to.equal(ethers.ZeroAddress);
    });
  });

  describe('A02: every Frozen combination has a defined exit', () => {
    it('lets an unsubscribed frozen offering cancel, and a subscribed one settle after full recovery', async () => {
      const ctx = await deployProtocol();
      const empty = await newOffering(ctx, 'frozen-empty');
      await send(applyPricing(ctx, empty.poolId, ISSUE_PRICE, ACTION.FREEZE_POOL));
      await send(ctx.pool.cancelOffering(empty.poolId, uniqueHash('cancel')));
      expect(await ctx.pool.stateOf(empty.poolId)).to.equal(STATE.Cancelled);

      const funded = await newOffering(ctx, 'frozen-paid', { supply: 10n });
      await send(ctx.pool.connect(ctx.investor).subscribe(funded.poolId, 10n));
      await send(ctx.pool.recordImporterPayment(funded.poolId, uniqueHash('payment'), 10n * TARGET));
      await send(ctx.pool.recordCargoArrival(funded.poolId, uniqueHash('arrival')));
      await send(applyPricing(ctx, funded.poolId, ISSUE_PRICE, ACTION.FREEZE_POOL));
      await send(ctx.pool.settle(funded.poolId, 10n * TARGET));
      expect(await ctx.pool.stateOf(funded.poolId)).to.equal(STATE.Repaid);
    });

    it('lets a frozen overdue offering default and an evidenced unfreeze restore the prior state', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'frozen-default', { supply: 10n });
      const created = await now();
      await send(ctx.pool.setMaturity(poolId, created + 20));
      await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 10n));
      await send(applyPricing(ctx, poolId, ISSUE_PRICE, ACTION.FREEZE_POOL));
      await advance(21);
      await send(ctx.pool.markDefault(poolId));
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Defaulted);

      const clear = await newOffering(ctx, 'frozen-clear', { supply: 10n });
      await send(applyPricing(ctx, clear.poolId, ISSUE_PRICE, ACTION.FREEZE_POOL));
      await send(ctx.pool.unfreezeOffering(clear.poolId, uniqueHash('clearance')));
      expect(await ctx.pool.stateOf(clear.poolId)).to.equal(STATE.Open);
      await expect(ctx.pool.unfreezeOffering(clear.poolId, uniqueHash('again'))).to.be.revertedWith('not frozen');
    });
  });

  describe('A05/A06: approved terms and subscription cutoff are on-chain from creation', () => {
    it('binds maturity and deadline atomically and refuses inconsistent terms', async () => {
      const ctx = await deployProtocol();
      const { poolId, maturity, deadline } = await createWithTerms(ctx, 'terms');
      expect(await ctx.pool.maturityAt(poolId)).to.equal(BigInt(maturity));
      expect(await ctx.pool.subscriptionDeadline(poolId)).to.equal(BigInt(deadline));

      const start = await now();
      await send(ctx.registry.mintEBL(ethers.id('metadata:bad-terms'), ctx.owner.address));
      const eblId = (await ctx.registry.nextEblId()) - 1n;
      await send(ctx.registry.pledge(eblId, await ctx.pool.getAddress()));
      await expect(ctx.pool.createOfferingWithTerms(eblId, 10n, ISSUE_PRICE, TARGET, start - 1, start + 10))
        .to.be.revertedWith('maturity elapsed');
      await expect(ctx.pool.createOfferingWithTerms(eblId, 10n, ISSUE_PRICE, TARGET, start + 10, start + 11))
        .to.be.revertedWith('deadline>maturity');
    });

    it('refuses subscriptions after the deadline and keeps the maturity/deadline order when shortened', async () => {
      const ctx = await deployProtocol();
      const { poolId, deadline } = await createWithTerms(ctx, 'deadline', { maturityIn: 100, deadlineIn: 50 });
      await setNextTimestamp(deadline);
      await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 1n));
      await setNextTimestamp((await now()) + 1);
      await expect(ctx.pool.connect(ctx.investor).subscribe(poolId, 1n)).to.be.revertedWith('subscription deadline elapsed');

      const shorter = await newOffering(ctx, 'shorten');
      const block = await ethers.provider.getBlock('latest');
      await send(ctx.pool.setMaturity(shorter.poolId, block.timestamp + 10));
      expect(await ctx.pool.subscriptionDeadline(shorter.poolId)).to.equal(BigInt(block.timestamp + 10));
      await advance(11);
      await expect(ctx.pool.connect(ctx.investor).subscribe(shorter.poolId, 1n)).to.be.revertedWith('subscription deadline elapsed');
    });
  });

  describe('A07: quote freshness, version and order are enforced on-chain', () => {
    it('rejects expired, too-far, stale, replayed and wrong-version quotes', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'quotes');
      const stamp = await now();

      await expect(quote(ctx, poolId, { action: ACTION.OPEN_OFFERING, validUntil: stamp - 1 })).to.be.revertedWith('quote expired');
      await expect(quote(ctx, poolId, { action: ACTION.OPEN_OFFERING, validUntil: stamp + 31 * 86_400 })).to.be.revertedWith('quote validity too long');
      await expect(quote(ctx, poolId, { action: ACTION.OPEN_OFFERING, version: 2 })).to.be.revertedWith('quote version changed');

      const evidence = uniqueHash('fixed-evidence');
      const quoteHash = uniqueHash('fixed-quote');
      await send(quote(ctx, poolId, { action: ACTION.OPEN_OFFERING, seq: 1, evidence, quoteHash }));
      await expect(quote(ctx, poolId, { action: ACTION.OPEN_OFFERING, seq: 1, evidence, quoteHash })).to.be.revertedWith('decision replay');
      await expect(quote(ctx, poolId, { action: ACTION.OPEN_OFFERING, seq: 1 })).to.be.revertedWith('quote out of order');
    });

    it('does not let a quote prepared before a reprice overwrite the new price', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'stale-price');
      const oldVersion = await ctx.pool.quoteVersion(poolId);
      await send(quote(ctx, poolId, { price: 700_000n, action: ACTION.REPRICE_DOWN }));
      expect(await ctx.pool.quoteVersion(poolId)).to.equal(oldVersion + 1n);
      await expect(quote(ctx, poolId, { price: 900_000n, action: ACTION.OPEN_OFFERING, version: oldVersion }))
        .to.be.revertedWith('quote version changed');
    });
  });

  describe('A08: subscription is bound to price, version and deadline', () => {
    it('accepts only the approved price/version/deadline and rejects drift atomically', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'subscribe-terms', { supply: 10n });
      const version = await ctx.pool.quoteVersion(poolId);
      const validUntil = (await now()) + 600;

      await expect(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 1n, 799_999n, version, validUntil))
        .to.be.revertedWith('price above user limit');
      await expect(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 1n, ISSUE_PRICE, version + 1n, validUntil))
        .to.be.revertedWith('quote version changed');
      await expect(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 1n, ISSUE_PRICE, version, (await now()) - 1))
        .to.be.revertedWith('user deadline elapsed');

      await send(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 1n, ISSUE_PRICE, version, validUntil));
      expect(await ctx.token.balanceOf(poolId, ctx.investor.address)).to.equal(1n);

      await send(quote(ctx, poolId, { price: 700_000n, action: ACTION.REPRICE_DOWN }));
      await expect(ctx.pool.connect(ctx.other).subscribeWithTerms(poolId, 1n, 700_000n, version, validUntil))
        .to.be.revertedWith('quote version changed');
      await send(ctx.pool.connect(ctx.other).subscribeWithTerms(poolId, 1n, 700_000n, version + 1n, validUntil));
    });
  });
});
