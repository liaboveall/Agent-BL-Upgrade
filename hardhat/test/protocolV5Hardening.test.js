import { expect } from 'chai';
import { STATE, ACTION, TARGET, ISSUE_PRICE, send, uniqueHash, deployProtocolV5, newOfferingV5, ethers } from './helpers/protocolV5.js';
import { applyPricing } from './helpers/protocol.js';

const now = async () => BigInt((await ethers.provider.getBlock('latest')).timestamp);
async function advance(timestamp) {
  await ethers.provider.send('evm_setNextBlockTimestamp', [Number(timestamp)]);
  await ethers.provider.send('evm_mine', []);
}
async function subscribe(ctx, poolId, signer, shares, price = ISSUE_PRICE, asset = ctx.usdc) {
  await send(asset.mint(signer.address, shares * price));
  await send(asset.connect(signer).approve(await ctx.pool.getAddress(), shares * price));
  await send(ctx.pool.connect(signer).subscribeWithTerms(poolId, shares, price, await ctx.pool.quoteVersion(poolId), await now() + 600n));
}
async function recover(ctx, poolId, amount, asset = ctx.usdc) {
  if (amount === 0n) return;
  await send(asset.mint(ctx.exporter.address, amount));
  await send(asset.connect(ctx.exporter).approve(await ctx.pool.getAddress(), amount));
  await send(ctx.pool.connect(ctx.exporter).repay(poolId, amount));
  await send(ctx.pool.recordImporterPayment(poolId, uniqueHash('recovery'), amount));
}
async function funded(ctx, tag, options = {}) {
  const created = await newOfferingV5(ctx, tag, { supply: 10n, ...options });
  await subscribe(ctx, created.poolId, ctx.investor, options.supply ?? 10n, options.issuePrice ?? ISSUE_PRICE, options.asset ?? ctx.usdc);
  return created;
}

describe('protocol v5 capital safety and conservation', () => {
  it('reprices v5 without changing funded debt or paid cost', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await funded(ctx, 'v5-oracle');
    const before = await ctx.pool.outstandingDebt(poolId);
    await send(applyPricing(ctx, poolId, 700_000n, ACTION.REPRICE_DOWN));
    expect(await ctx.pool.quoteVersion(poolId)).to.equal(2n);
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Funded);
    expect(await ctx.pool.outstandingDebt(poolId)).to.equal(before);
    expect(await ctx.pool.investorPaid(poolId, await ctx.usdc.getAddress(), ctx.investor.address)).to.equal(10n * ISSUE_PRICE);
  });
  it('rejects unsupported settlement assets and invalid funding terms', async () => {
    const ctx = await deployProtocolV5();
    const asset = await (await ethers.getContractFactory('EighteenDecimalAsset')).deploy();
    await expect(newOfferingV5(ctx, 'wrong-decimals', { asset })).to.be.revertedWithCustomError(ctx.pool, 'AssetDecimalsNot6');
    await expect(newOfferingV5(ctx, 'zero-min', { minRaise: 0n })).to.be.revertedWithCustomError(ctx.pool, 'MinRaiseIsZero');
    await expect(newOfferingV5(ctx, 'over-min', { minRaise: 101n * ISSUE_PRICE })).to.be.revertedWithCustomError(ctx.pool, 'MinRaiseAboveMax');
    await expect(newOfferingV5(ctx, 'past-terms', { deadlineIn: 0 })).to.be.revertedWithCustomError(ctx.pool, 'DeadlineElapsed');
  });

  it('rolls back both money and shares for insufficient balance, allowance, or failed mint', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'atomic');
    await send(ctx.usdc.mint(ctx.investor.address, ISSUE_PRICE));
    await expect(ctx.pool.connect(ctx.investor).subscribe(poolId, 2n)).to.revert(ethers);
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), 2n * ISSUE_PRICE));
    await expect(ctx.pool.connect(ctx.investor).subscribe(poolId, 2n)).to.revert(ethers);
    expect(await ctx.token.balanceOf(poolId, ctx.investor.address)).to.equal(0n);
    const shares = await (await ethers.getContractFactory('FailingShares')).deploy();
    const pool = await (await ethers.getContractFactory('RWAOfferingPoolV5')).deploy(await ctx.registry.getAddress(), await shares.getAddress());
    const other = { ...ctx, pool };
    const offering = await newOfferingV5(other, 'mint-failure');
    await send(ctx.usdc.connect(ctx.investor).approve(await pool.getAddress(), ISSUE_PRICE));
    await expect(pool.connect(ctx.investor).subscribe(offering.poolId, 1n)).to.be.revertedWith('mint failed');
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(ISSUE_PRICE);
    expect(await ctx.usdc.balanceOf(await pool.getAddress())).to.equal(0n);
  });

  it('accepts a no-return ERC20 and rejects a taxed transfer without retaining funds', async () => {
    for (const name of ['NoReturnUSDC', 'TaxUSDC']) {
      const ctx = await deployProtocolV5();
      const asset = await (await ethers.getContractFactory(name)).deploy();
      const { poolId } = await newOfferingV5(ctx, name, { asset, supply: 10n });
      await send(asset.mint(ctx.investor.address, 10n * ISSUE_PRICE));
      await send(asset.connect(ctx.investor).approve(await ctx.pool.getAddress(), 10n * ISSUE_PRICE));
      if (name === 'TaxUSDC') {
        await expect(ctx.pool.connect(ctx.investor).subscribe(poolId, 10n)).to.be.revertedWithCustomError(ctx.pool, 'TransferTaxNotSupported');
        expect(await asset.balanceOf(ctx.investor.address)).to.equal(10n * ISSUE_PRICE);
      } else {
        await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 10n));
        expect(await ctx.token.balanceOf(poolId, ctx.investor.address)).to.equal(10n);
      }
    }
  });

  it('blocks transfer callbacks during subscribe and refund', async () => {
    const ctx = await deployProtocolV5();
    const asset = await (await ethers.getContractFactory('CallbackUSDC')).deploy();
    const { poolId, deadline } = await newOfferingV5(ctx, 'callback', { asset });
    const data = ctx.pool.interface.encodeFunctionData('subscribe', [poolId, 1n]);
    await send(asset.configure(await ctx.pool.getAddress(), data, false));
    await subscribe(ctx, poolId, ctx.investor, 2n, ISSUE_PRICE, asset);
    expect(await asset.callbackSucceeded()).to.equal(false);
    expect((await asset.callbackResult()).slice(0, 10)).to.equal(ethers.id('ReentrancyGuardReentrantCall()').slice(0, 10));
    await advance(deadline + 1n);
    await send(asset.configure(await ctx.pool.getAddress(), ctx.pool.interface.encodeFunctionData('refundInvestor', [poolId, ctx.investor.address]), true));
    await send(ctx.pool.refundInvestor(poolId, ctx.investor.address));
    expect(await asset.callbackSucceeded()).to.equal(false);
    expect(await asset.balanceOf(ctx.investor.address)).to.equal(2n * ISSUE_PRICE);
    expect(await ctx.token.totalSupply(poolId)).to.equal(0n);
  });

  it('binds quote version, price and user deadline, and never oversells', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'terms', { supply: 10n });
    await send(ctx.usdc.mint(ctx.investor.address, 20n * ISSUE_PRICE));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), 20n * ISSUE_PRICE));
    await expect(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 1n, ISSUE_PRICE - 1n, 1n, await now() + 600n)).to.be.revertedWithCustomError(ctx.pool, 'PriceAboveUserLimit');
    await send(ctx.pool.applyPricingAction(poolId, ISSUE_PRICE - 1n, ACTION.REPRICE_DOWN, uniqueHash('price'), uniqueHash('quote')));
    await expect(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 1n, ISSUE_PRICE, 1n, await now() + 600n)).to.be.revertedWithCustomError(ctx.pool, 'QuoteVersionChanged');
    await expect(ctx.pool.connect(ctx.investor).subscribeWithTerms(poolId, 1n, ISSUE_PRICE, 2n, 1n)).to.be.revertedWithCustomError(ctx.pool, 'UserDeadlineElapsed');
    await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 9n));
    await expect(ctx.pool.connect(ctx.investor).subscribe(poolId, 2n)).to.be.revertedWithCustomError(ctx.pool, 'ExceedsSupply');
    expect(await ctx.token.totalSupply(poolId)).to.equal(9n);
  });

  it('finalizes a successful partial raise only after the deadline, preserving the minimum', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, deadline } = await newOfferingV5(ctx, 'partial-success', { supply: 10n });
    await subscribe(ctx, poolId, ctx.investor, 8n);
    await expect(ctx.pool.markInTransit(poolId, uniqueHash('departure'))).to.be.revertedWithCustomError(ctx.pool, 'NotFunded');
    await expect(ctx.pool.finalizeFunding(poolId)).to.be.revertedWithCustomError(ctx.pool, 'DeadlineNotPassed');
    await advance(deadline + 1n);
    await send(ctx.pool.finalizeFunding(poolId));
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Funded);
    await expect(ctx.pool.refundInvestor(poolId, ctx.investor.address)).to.revert(ethers);
    await expect(ctx.pool.connect(ctx.outsider).disburseToExporter(poolId, 1n, ctx.exporter.address, uniqueHash('unauthorized'))).to.revert(ethers);
    await expect(ctx.pool.disburseToExporter(poolId, 9n * ISSUE_PRICE, ctx.exporter.address, uniqueHash('too-much'))).to.be.revertedWithCustomError(ctx.pool, 'AmountAboveAvailable');
    await send(ctx.pool.disburseToExporter(poolId, 8n * ISSUE_PRICE, ctx.exporter.address, uniqueHash('valid')));
  });

  it('refunds actual paid amounts after repricing even when every share sold below the minimum', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, deadline } = await newOfferingV5(ctx, 'below-min', { supply: 10n, minRaise: 10n * ISSUE_PRICE });
    await subscribe(ctx, poolId, ctx.investor, 5n);
    await send(ctx.pool.applyPricingAction(poolId, ISSUE_PRICE / 2n, ACTION.REPRICE_DOWN, uniqueHash('price'), uniqueHash('quote')));
    await subscribe(ctx, poolId, ctx.outsider, 5n, ISSUE_PRICE / 2n);
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Subscribed);
    await advance(deadline + 1n);
    await send(ctx.pool.refundInvestor(poolId, ctx.investor.address));
    expect(await ctx.registry.pledgedTo((await ctx.pool.offerings(poolId)).eblId)).to.equal(await ctx.pool.getAddress());
    await expect(ctx.pool.refundInvestor(poolId, ctx.investor.address)).to.be.revertedWithCustomError(ctx.pool, 'NothingToRefund');
    await send(ctx.pool['refundAllOnFailure(uint256,uint256,uint256)'](poolId, 0n, 100n));
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(5n * ISSUE_PRICE);
    expect(await ctx.usdc.balanceOf(ctx.outsider.address)).to.equal(5n * ISSUE_PRICE / 2n);
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Cancelled);
    expect(await ctx.token.totalSupply(poolId)).to.equal(0n);
  });

  it('does not accept a proof as funds and cannot borrow another pool escrow', async () => {
    const ctx = await deployProtocolV5();
    const first = await funded(ctx, 'isolation-1');
    const second = await funded(ctx, 'isolation-2');
    await send(ctx.pool.disburseToExporter(first.poolId, 10n * ISSUE_PRICE, ctx.exporter.address, uniqueHash('disburse')));
    await expect(ctx.pool.recordImporterPayment(first.poolId, uniqueHash('unfunded-proof'), 10n * TARGET)).to.be.revertedWithCustomError(ctx.pool, 'RecoveryNotReceived');
    expect(await ctx.pool.escrowed(second.poolId, await ctx.usdc.getAddress())).to.equal(10n * ISSUE_PRICE);
    expect(await ctx.pool.escrowed(first.poolId, await ctx.usdc.getAddress())).to.equal(0n);
  });

  for (const recovery of [0n, 1n, 10n * TARGET]) {
    it(`settles ${recovery} recovery with fees, dust, no double claim and no fee changes after claims`, async () => {
      const ctx = await deployProtocolV5();
      const { poolId, maturity } = await newOfferingV5(ctx, `claims-${recovery}`, { supply: 10n });
      await subscribe(ctx, poolId, ctx.investor, 1n);
      await subscribe(ctx, poolId, ctx.outsider, 9n);
      await send(ctx.pool.disburseToExporter(poolId, 10n * ISSUE_PRICE, ctx.exporter.address, uniqueHash('disburse')));
      await recover(ctx, poolId, recovery);
      if (recovery >= 10n * TARGET) {
        await send(ctx.pool.recordCargoArrival(poolId, uniqueHash('arrival')));
        await send(ctx.pool.settle(poolId, recovery));
        await send(ctx.pool.deductFee(poolId, 1n, ctx.owner.address, uniqueHash('fee')));
      } else {
        await advance(maturity + 1n);
        await send(ctx.pool.markDefault(poolId));
        await send(ctx.pool.settleLoss(poolId, uniqueHash('loss')));
      }
      const before = await ctx.pool.claimable(poolId, ctx.investor.address);
      await send(ctx.pool.connect(ctx.investor).claim(poolId));
      expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(before);
      await expect(ctx.pool.connect(ctx.investor).claim(poolId)).to.be.revertedWithCustomError(ctx.pool, 'NoShares');
      await expect(ctx.pool.deductFee(poolId, 1n, ctx.owner.address, uniqueHash('late-fee'))).to.be.revertedWithCustomError(ctx.pool, 'ClaimsStarted');
      await send(ctx.pool.connect(ctx.outsider).claim(poolId));
      expect(await ctx.token.totalSupply(poolId)).to.equal(0n);
      expect(await ctx.pool.totalClaimed(poolId) + await ctx.pool.feesDeducted(poolId)).to.equal(recovery);
      expect(await ctx.pool.escrowed(poolId, await ctx.usdc.getAddress())).to.equal(0n);
    });
  }

  it('returns undistributed principal to investors when no exporter drawdown occurred', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, maturity } = await funded(ctx, 'undisbursed');
    await advance(maturity + 1n);
    await send(ctx.pool.markDefault(poolId));
    await send(ctx.pool.settleLoss(poolId, uniqueHash('loss')));
    await send(ctx.pool.connect(ctx.investor).claim(poolId));
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(10n * ISSUE_PRICE);
    expect(await ctx.pool.realizedLoss(poolId)).to.equal(10n * (TARGET - ISSUE_PRICE));
  });

  it('blocks every capital transfer while globally stopped', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await funded(ctx, 'stopped');
    await send(ctx.pool.setEmergencyStop(true, uniqueHash('stop')));
    for (const call of [() => ctx.pool.connect(ctx.investor).subscribe(poolId, 1n), () => ctx.pool.disburseToExporter(poolId, 1n, ctx.exporter.address, uniqueHash('disburse')),
      () => ctx.pool.repay(poolId, 1n), () => ctx.pool.refundInvestor(poolId, ctx.investor.address), () => ctx.pool.claim(poolId),
      () => ctx.pool.deductFee(poolId, 1n, ctx.owner.address, uniqueHash('fee'))]) {
      await expect(call()).to.be.revertedWithCustomError(ctx.pool, 'EmergencyStopped');
    }
  });
});

describe('protocol v5 model and pending-raise exits', () => {
  it('cancels liquidation before funding and releases collateral only after the last exact refund', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, eblId } = await newOfferingV5(ctx, 'pending-liquidation', { supply: 10n, minRaise: 5n * ISSUE_PRICE });
    await subscribe(ctx, poolId, ctx.investor, 3n);
    await subscribe(ctx, poolId, ctx.outsider, 3n);
    await send(ctx.pool.applyPricingAction(poolId, 0n, ACTION.TRIGGER_LIQUIDATION, uniqueHash('liquidate'), uniqueHash('quote')));
    await send(ctx.pool.resolveLiquidation(poolId, uniqueHash('cancel-pending')));
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Cancelled);
    expect(await ctx.registry.pledgedTo(eblId)).to.equal(await ctx.pool.getAddress());
    await send(ctx.pool.refundInvestor(poolId, ctx.investor.address));
    expect(await ctx.registry.pledgedTo(eblId)).to.equal(await ctx.pool.getAddress());
    await send(ctx.pool.refundInvestor(poolId, ctx.outsider.address));
    expect(await ctx.registry.pledgedTo(eblId)).to.equal(ethers.ZeroAddress);
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(3n * ISSUE_PRICE);
    expect(await ctx.usdc.balanceOf(ctx.outsider.address)).to.equal(3n * ISSUE_PRICE);
  });

  it('serializes competing transactions at the supply boundary without charging the losing buyer', async () => {
    const ctx = await deployProtocolV5();
    const { poolId } = await newOfferingV5(ctx, 'concurrent-supply', { supply: 10n });
    for (const signer of [ctx.investor, ctx.outsider]) {
      await send(ctx.usdc.mint(signer.address, 6n * ISSUE_PRICE));
      await send(ctx.usdc.connect(signer).approve(await ctx.pool.getAddress(), 6n * ISSUE_PRICE));
    }
    await ethers.provider.send('evm_setAutomine', [false]);
    try {
      const txs = await Promise.all([ctx.investor, ctx.outsider].map((signer) => ctx.pool.connect(signer).subscribe(poolId, 6n, { gasLimit: 3_000_000n })));
      await ethers.provider.send('evm_mine', []);
      const outcomes = await Promise.allSettled(txs.map((tx) => tx.wait()));
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled').length).to.equal(1);
      expect(await ctx.token.totalSupply(poolId)).to.equal(6n);
      expect(await ctx.usdc.balanceOf(await ctx.pool.getAddress())).to.equal(6n * ISSUE_PRICE);
      const balances = await Promise.all([ctx.investor, ctx.outsider].map((signer) => ctx.usdc.balanceOf(signer.address)));
      expect(balances[0] + balances[1]).to.equal(6n * ISSUE_PRICE);
    } finally { await ethers.provider.send('evm_setAutomine', [true]); }
  });

  it('preserves cash, shares and fixed sold debt across seeded multi-investor models and assets', async () => {
    for (let seed = 1; seed <= 4; seed++) {
      const ctx = await deployProtocolV5();
      let randomState = seed;
      const random = (max) => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % max; };
      const altAsset = await (await ethers.getContractFactory('MockUSDC')).deploy();
      const assets = [ctx.usdc, seed % 2 ? ctx.usdc : altAsset];
      const pools = [];
      const investors = [ctx.investor, ctx.outsider, ctx.other, ctx.third];
      const check = async () => {
        for (const asset of new Set(assets)) {
          const address = await asset.getAddress();
          const balances = await Promise.all(pools.filter((pool) => pool.asset === asset).map((pool) => ctx.pool.escrowed(pool.poolId, address)));
          expect(await asset.balanceOf(await ctx.pool.getAddress())).to.equal(balances.reduce((sum, value) => sum + value, 0n));
        }
        for (const pool of pools) {
          const shares = await Promise.all(investors.map((investor) => ctx.token.balanceOf(pool.poolId, investor.address)));
          expect(await ctx.token.totalSupply(pool.poolId)).to.equal(shares.reduce((sum, value) => sum + value, 0n));
          expect(await ctx.pool.escrowed(pool.poolId, await pool.asset.getAddress())).to.equal(pool.deposits + pool.recovery - pool.disbursed - pool.claimed - pool.fees);
        }
      };
      for (const [index, asset] of assets.entries()) {
        const offering = await newOfferingV5(ctx, `model-${seed}-${index}`, { supply: 20n, minRaise: 1n, asset });
        const model = { ...offering, asset, deposits: 0n, recovery: 0n, disbursed: 0n, claimed: 0n, fees: 0n };
        pools.push(model);
        let price = ISSUE_PRICE, remaining = 20n;
        while (remaining > 0n) {
          const shares = remaining < 5n ? remaining : BigInt(random(5) + 1);
          const signer = investors[random(investors.length)];
          await subscribe(ctx, model.poolId, signer, shares, price, asset);
          model.deposits += shares * price; remaining -= shares;
          await check();
          expect((await ctx.pool.offerings(model.poolId)).targetRedemptionValue).to.equal(TARGET);
          if (remaining && random(2)) {
            price -= BigInt(random(10_000) + 1);
            await send(ctx.pool.applyPricingAction(model.poolId, price, ACTION.REPRICE_DOWN, uniqueHash('model-price'), uniqueHash('model-quote')));
          }
        }
        await send(ctx.pool.disburseToExporter(model.poolId, model.deposits, ctx.exporter.address, uniqueHash('model-drawdown')));
        model.disbursed = model.deposits;
        model.recovery = [0n, 10n * TARGET, 20n * TARGET][(seed + index) % 3];
        await recover(ctx, model.poolId, model.recovery, asset);
        if (model.recovery >= 20n * TARGET) {
          await send(ctx.pool.recordCargoArrival(model.poolId, uniqueHash('model-arrival')));
          await send(ctx.pool.settle(model.poolId, model.recovery));
        } else {
          const stamp = await now();
          if (stamp <= model.maturity) await advance(model.maturity + 1n);
          await send(ctx.pool.markDefault(model.poolId));
          await send(ctx.pool.settleLoss(model.poolId, uniqueHash('model-loss')));
        }
        if (model.recovery > 0n) {
          model.fees = BigInt(random(1000) + 1);
          await send(ctx.pool.deductFee(model.poolId, model.fees, ctx.owner.address, uniqueHash('model-fee')));
        }
        await check();
        for (const investor of [...investors].sort(() => random(3) - 1)) {
          if (await ctx.token.balanceOf(model.poolId, investor.address) === 0n) continue;
          const claimable = await ctx.pool.claimable(model.poolId, investor.address);
          await send(ctx.pool.connect(investor).claim(model.poolId));
          model.claimed += claimable;
          expect(await ctx.pool.totalClaimed(model.poolId) + model.fees <= model.recovery).to.equal(true);
          await check();
        }
        expect(model.claimed + model.fees).to.equal(model.recovery);
      }
    }
  });
});

describe('protocol v5 transfer failure and payout policy', () => {
  it('rejects false-return transfers and retries failed refunds while other investors remain independent', async () => {
    const ctx = await deployProtocolV5();
    const asset = await (await ethers.getContractFactory('SwitchableUSDC')).deploy();
    const { poolId, deadline } = await newOfferingV5(ctx, 'false-return-refund', { asset });
    await send(asset.setReturnFalse(true));
    await send(asset.mint(ctx.investor.address, 2n * ISSUE_PRICE));
    await send(asset.connect(ctx.investor).approve(await ctx.pool.getAddress(), 2n * ISSUE_PRICE));
    await expect(ctx.pool.connect(ctx.investor).subscribe(poolId, 2n)).to.revert(ethers);
    expect(await ctx.token.balanceOf(poolId, ctx.investor.address)).to.equal(0n);
    expect(await asset.balanceOf(ctx.investor.address)).to.equal(2n * ISSUE_PRICE);
    await send(asset.setReturnFalse(false));
    await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 2n));
    await subscribe(ctx, poolId, ctx.outsider, 2n, ISSUE_PRICE, asset);
    await send(asset.setBlocked(ctx.investor.address, true));
    await advance(deadline + 1n);
    await expect(ctx.pool.refundInvestor(poolId, ctx.investor.address)).to.be.revertedWith('recipient blocked');
    expect(await ctx.pool.investorPaid(poolId, await asset.getAddress(), ctx.investor.address)).to.equal(2n * ISSUE_PRICE);
    await send(ctx.pool.refundInvestor(poolId, ctx.outsider.address));
    await send(asset.setBlocked(ctx.investor.address, false));
    await send(ctx.pool.refundInvestor(poolId, ctx.investor.address));
    expect(await asset.balanceOf(ctx.investor.address)).to.equal(2n * ISSUE_PRICE);
    expect(await ctx.token.totalSupply(poolId)).to.equal(0n);
  });

  it('rolls back a failed claim, pays other investors, distributes surplus, and refuses late recovery', async () => {
    const ctx = await deployProtocolV5();
    const asset = await (await ethers.getContractFactory('SwitchableUSDC')).deploy();
    const { poolId } = await newOfferingV5(ctx, 'claim-failure', { asset, supply: 10n });
    await subscribe(ctx, poolId, ctx.investor, 5n, ISSUE_PRICE, asset);
    await subscribe(ctx, poolId, ctx.outsider, 5n, ISSUE_PRICE, asset);
    await send(ctx.pool.disburseToExporter(poolId, 10n * ISSUE_PRICE, ctx.exporter.address, uniqueHash('drawdown')));
    await recover(ctx, poolId, 12n * TARGET, asset);
    await send(ctx.pool.recordCargoArrival(poolId, uniqueHash('arrival')));
    await send(ctx.pool.settle(poolId, 12n * TARGET));
    await send(asset.setBlocked(ctx.investor.address, true));
    await expect(ctx.pool.connect(ctx.investor).claim(poolId)).to.be.revertedWith('recipient blocked');
    expect(await ctx.token.balanceOf(poolId, ctx.investor.address)).to.equal(5n);
    expect(await ctx.pool.totalClaimed(poolId)).to.equal(0n);
    await send(ctx.pool.connect(ctx.outsider).claim(poolId));
    expect(await asset.balanceOf(ctx.outsider.address)).to.equal(6n * TARGET);
    await send(asset.setBlocked(ctx.investor.address, false));
    await send(ctx.pool.connect(ctx.investor).claim(poolId));
    expect(await asset.balanceOf(ctx.investor.address)).to.equal(6n * TARGET);
    expect(await ctx.pool.totalClaimed(poolId)).to.equal(12n * TARGET);
    await expect(ctx.pool.repay(poolId, 1n)).to.be.revertedWithCustomError(ctx.pool, 'NotRepayable');
  });

  it('returns the retained principal after a partial drawdown alongside actual recovery', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, maturity } = await funded(ctx, 'partial-drawdown');
    await send(ctx.pool.disburseToExporter(poolId, 3n * ISSUE_PRICE, ctx.exporter.address, uniqueHash('drawdown')));
    await recover(ctx, poolId, TARGET);
    await advance(maturity + 1n);
    await send(ctx.pool.markDefault(poolId));
    await send(ctx.pool.settleLoss(poolId, uniqueHash('loss')));
    await send(ctx.pool.connect(ctx.investor).claim(poolId));
    expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(7n * ISSUE_PRICE + TARGET);
    expect(await ctx.pool.escrowed(poolId, await ctx.usdc.getAddress())).to.equal(0n);
  });

  for (const action of [ACTION.PAUSE_OFFERING, ACTION.FREEZE_POOL]) {
    it(`retains a failed raise's exact refund right while risk action ${action} is active`, async () => {
      const ctx = await deployProtocolV5();
      const { poolId, deadline } = await newOfferingV5(ctx, `risk-refund-${action}`);
      await subscribe(ctx, poolId, ctx.investor, 2n);
      await send(ctx.pool.applyPricingAction(poolId, 0n, action, uniqueHash('risk'), uniqueHash('quote')));
      await advance(deadline + 1n);
      await send(ctx.pool.refundInvestor(poolId, ctx.investor.address));
      expect(await ctx.usdc.balanceOf(ctx.investor.address)).to.equal(2n * ISSUE_PRICE);
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Cancelled);
    });
  }
});
