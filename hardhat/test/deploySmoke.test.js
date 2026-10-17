// scripts/deploy-protocol.js ends with a live-chain smoke sequence and then asserts its
// final state. This replays the same sequence in-process so a contract change that would
// break the real deployment smoke (which costs gas and time to discover) fails here first.
import { expect } from 'chai';
import { ACTION, STATE, deployProtocol, newOffering, applyPricing, ethers, send } from './helpers/protocol.js';

describe('deploy-protocol.js smoke sequence', () => {
  it('testnet smoke keeps the repriced offering price when PAUSE commits a lower risk quote', async () => {
    const ctx = await deployProtocol();
    const { poolId } = await newOffering(ctx, 'phase5-state-only-actions');
    await send(applyPricing(ctx, poolId, 791_000n, ACTION.REPRICE_DOWN));
    await send(applyPricing(ctx, poolId, 783_600n, ACTION.PAUSE_OFFERING));
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Paused);
    expect(await ctx.pool.issuePriceOf(poolId)).to.equal(791_000n);
    await send(applyPricing(ctx, poolId, 791_000n, ACTION.RESUME_OFFERING));
    expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Open);
    expect(await ctx.pool.issuePriceOf(poolId)).to.equal(791_000n);
  });

  it('create -> subscribe -> reprice -> pause -> resume -> settle ends Repaid at the repriced issue price', async () => {
    const ctx = await deployProtocol();
    const { owner, registry, token, pool } = ctx;
    const metadata = {
      vessel: 'MV Pacific Dawn',
      voyage: 'PD-2026-0618',
      portOfLoading: 'Singapore',
      portOfDischarge: 'Shanghai',
      cargo: 'Copper Cathodes Grade A',
      quantity: 5_000n,
      quantityUnit: 'MT',
      hsCode: '740311',
      declaredValueUsdE6: 42_000_000_000_000n,
      incoterms: 'CIF',
      mletr: true,
      eucp: true,
      dcsa: true
    };
    await send(registry.mintEBLV2(ethers.id('CASE-EBL-2026-CU-SG-SHA:copper-cathodes:5000MT'), ethers.id('CASE-EBL-2026-CU-SG-SHA:wave-b:v2'), owner.address, metadata));
    const eblId = (await registry.nextEblId()) - 1n;
    await send(registry.pledge(eblId, await pool.getAddress()));
    await send(pool.createOffering(eblId, 1_000_000n, 900_000n, 1_000_000n));
    const poolId = (await pool.nextPoolId()) - 1n;
    await send(pool.subscribe(poolId, 10_000n));

    const decide = (price, riskLevel, action, label) =>
      send(applyPricing(ctx, poolId, price, action, riskLevel,
        { evidenceHash: ethers.id(`wave-b:${label}:evidence`), quoteHash: ethers.id(`wave-b:${label}:quote`) }));
    await decide(850_000n, 2, ACTION.REPRICE_DOWN, 'reprice');
    await decide(850_000n, 3, ACTION.PAUSE_OFFERING, 'pause');
    expect(await pool.stateOf(poolId)).to.equal(STATE.Paused);
    await decide(850_000n, 1, ACTION.RESUME_OFFERING, 'resume');
    expect(await pool.stateOf(poolId)).to.equal(STATE.Subscribed);

    const repaymentAmount = 10_000n * 1_000_000n;
    await send(pool.recordImporterPayment(poolId, ethers.id('wave-b:importer-payment'), repaymentAmount));
    await send(pool.recordCargoArrival(poolId, ethers.id('wave-b:cargo-arrival')));
    await send(pool.settle(poolId, repaymentAmount));

    expect(await pool.stateOf(poolId)).to.equal(STATE.Repaid);
    expect(await pool.issuePriceOf(poolId)).to.equal(850_000n);
    expect(await token.balanceOf(poolId, owner.address)).to.equal(10_000n);
    // The collateral is handed back at the end of the lifecycle.
    expect(await registry.pledgedTo(eblId)).to.equal(ethers.ZeroAddress);
  });
});
