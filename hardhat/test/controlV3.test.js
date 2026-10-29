import { expect } from 'chai';
import { deployRights, ethers, send, uniqueHash, STATE, ACTION, ISSUANCE_TYPES } from './helpers/rights.js';
import { deployProtocolV5, newOfferingV5, ISSUE_PRICE } from './helpers/protocolV5.js';
import { FINANCE_POLICY } from '../../src/rights/financePolicy.js';
import { createDisclosure } from '../../src/rights/disclosure.js';

async function funded(c, patch = {}) {
  const p = await c.create(patch); await c.eligible(p);
  await send(c.pool.connect(c.investor).subscribe(p.poolId, 10));
  return p;
}
const liquidation = (p) => [p.poolId, 0, ACTION.TRIGGER_LIQUIDATION, uniqueHash(), uniqueHash()];

// The version 3 remediations, still in force in version 4 (see controlV4.test.js for what version 4 adds).
describe('control version 3 remediation', () => {
  it('lets only delayed governance liquidate before maturity while an operator can still freeze', async () => {
    const c = await deployRights(), p = await funded(c);
    await expect(c.controller.connect(c.operator).applyPricingAction(...liquidation(p))).to.be.revertedWithCustomError(c.controller, 'GovernanceRequired');
    await expect(c.controller.connect(c.outsider).applyPricingAction(...liquidation(p))).to.be.revertedWith('role required');
    await send(c.controller.connect(c.operator).applyPricingAction(p.poolId, 0, ACTION.FREEZE_POOL, uniqueHash(), uniqueHash()));
    expect(await c.pool.stateOf(p.poolId)).to.equal(STATE.Frozen);
    await expect(c.controller.connect(c.operator).applyPricingAction(...liquidation(p))).to.be.revertedWithCustomError(c.controller, 'GovernanceRequired');
    await expect(c.controller.connect(c.operator).executeLifecycle(c.pool.interface.encodeFunctionData('unfreezeOffering', [p.poolId, uniqueHash()])))
      .to.be.revertedWith('call not authorized');
    await c.govern(c.controller, 'applyPricingAction', liquidation(p));
    expect(await c.pool.stateOf(p.poolId)).to.equal(STATE.Liquidation);
  });

  it('lets an operator start liquidation once the pool has matured', async () => {
    const c = await deployRights(), p = await funded(c);
    await send(c.controller.connect(c.operator).disburse(p.poolId, 8_000_000n, uniqueHash()));
    await c.advance(p.terms.maturity - 10n);
    await expect(c.controller.connect(c.operator).applyPricingAction(...liquidation(p))).to.be.revertedWithCustomError(c.controller, 'GovernanceRequired');
    await c.advance(p.terms.maturity);
    await send(c.controller.connect(c.operator).applyPricingAction(...liquidation(p)));
    expect(await c.pool.stateOf(p.poolId)).to.equal(STATE.Liquidation);
  });

  it('keeps titles of a rotated issuer key active and invalidates them only on revocation', async () => {
    const c = await deployRights(), p = await funded(c), rotated = (await ethers.getSigners())[14];
    await c.govern(c.registry, 'setIssuer', [c.organization, rotated.address]);
    expect(await c.registry.isActive(p.eblId)).to.equal(true);
    await send(c.controller.connect(c.operator).disburse(p.poolId, 1_000_000n, uniqueHash()));
    await expect(c.register()).to.be.revertedWith('invalid issuer signature');
    const issuance = { assetKey: uniqueHash(), documentHash: uniqueHash(), issuerOrg: c.organization, holder: c.holder.address,
      revision: 1, previousHash: ethers.ZeroHash, validUntil: (await c.now()) + 10_000n, nonce: 7n };
    await send(c.registry.registerTitle(issuance, await rotated.signTypedData(c.title, ISSUANCE_TYPES, issuance)));
    const second = (await c.registry.nextEblId()) - 1n;
    await c.govern(c.registry, 'revokeIssuer', [c.organization, c.issuer.address, uniqueHash()]);
    expect(await c.registry.isActive(p.eblId)).to.equal(false);
    expect(await c.registry.isActive(second)).to.equal(true);
    expect(await c.registry.issuerForOrg(c.organization)).to.equal(rotated.address);
    await expect(c.controller.connect(c.operator).disburse(p.poolId, 1_000_000n, uniqueHash())).to.be.revertedWith('intake unavailable');
    const restore = await c.queue(c.registry, 'setIssuer', [c.organization, c.issuer.address]); await c.advance(restore.eta);
    await expect(c.governance.execute(restore.id, restore.data)).to.be.revertedWith('issuer revoked');
    await c.govern(c.registry, 'revokeIssuer', [c.organization, rotated.address, uniqueHash()]);
    expect(await c.registry.issuerForOrg(c.organization)).to.equal(ethers.ZeroAddress);
    expect(await c.registry.isActive(second)).to.equal(false);
    await expect(c.registry.revokeIssuer(c.organization, rotated.address, uniqueHash())).to.be.revertedWith('not governance');
  });

  it('retries a failed collateral release idempotently, only for terminal pools and never for a newer offering', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, eblId } = await newOfferingV5(ctx, 'retry', { supply: 10n });
    await expect(ctx.pool.retryCollateralRelease(poolId)).to.be.revertedWithCustomError(ctx.pool, 'BadState');
    await send(ctx.registry.setFailRelease(true));
    await expect(ctx.pool.cancelOffering(poolId, uniqueHash('cancel'))).to.emit(ctx.pool, 'CollateralReleaseFailed').withArgs(poolId, eblId);
    expect(await ctx.registry.pledgedTo(eblId)).to.equal(await ctx.pool.getAddress());
    await expect(ctx.pool.connect(ctx.outsider).retryCollateralRelease(poolId)).to.be.revertedWith('not pledged pool');
    await send(ctx.registry.setFailRelease(false));
    expect(await ctx.pool.connect(ctx.outsider).retryCollateralRelease.staticCall(poolId)).to.equal(true);
    await expect(ctx.pool.connect(ctx.outsider).retryCollateralRelease(poolId)).to.emit(ctx.pool, 'CollateralReleased').withArgs(poolId, eblId);
    expect(await ctx.registry.pledgedTo(eblId)).to.equal(ethers.ZeroAddress);
    expect(await ctx.pool.connect(ctx.outsider).retryCollateralRelease.staticCall(poolId)).to.equal(false);
    await expect(ctx.pool.connect(ctx.outsider).retryCollateralRelease(poolId)).not.to.emit(ctx.pool, 'CollateralReleased');

    const old = await newOfferingV5(ctx, 'retry-reused', { supply: 10n });
    await send(ctx.registry.setFailRelease(true));
    await send(ctx.pool.cancelOffering(old.poolId, uniqueHash('cancel')));
    await send(ctx.registry.setFailRelease(false));
    const start = BigInt((await ethers.provider.getBlock('latest')).timestamp);
    await send(ctx.pool.createOfferingWithTerms(old.eblId, 10n, ISSUE_PRICE, 1_000_000n, start + 1000n, start + 100n, await ctx.usdc.getAddress(), ISSUE_PRICE));
    const newer = (await ctx.pool.nextPoolId()) - 1n;
    expect(await ctx.pool.retryCollateralRelease.staticCall(old.poolId)).to.equal(false);
    await send(ctx.pool.retryCollateralRelease(old.poolId));
    expect(await ctx.registry.pledgedTo(old.eblId)).to.equal(await ctx.pool.getAddress());
    expect(await ctx.pool.poolOfEbl(old.eblId)).to.equal(newer);
  });

  it('waits for every refund of a cancelled pending raise before a release can be retried', async () => {
    const ctx = await deployProtocolV5();
    const { poolId, eblId } = await newOfferingV5(ctx, 'retry-pending', { supply: 10n, minRaise: 5n * ISSUE_PRICE });
    await send(ctx.usdc.mint(ctx.investor.address, 3n * ISSUE_PRICE));
    await send(ctx.usdc.connect(ctx.investor).approve(await ctx.pool.getAddress(), 3n * ISSUE_PRICE));
    await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 3n));
    await send(ctx.pool.applyPricingAction(poolId, 0n, ACTION.TRIGGER_LIQUIDATION, uniqueHash('liquidate'), uniqueHash('quote')));
    await send(ctx.pool.resolveLiquidation(poolId, uniqueHash('cancel-pending')));
    await expect(ctx.pool.retryCollateralRelease(poolId)).to.be.revertedWithCustomError(ctx.pool, 'BadState');
    await send(ctx.registry.setFailRelease(true));
    await expect(ctx.pool.refundInvestor(poolId, ctx.investor.address)).to.emit(ctx.pool, 'CollateralReleaseFailed');
    await send(ctx.registry.setFailRelease(false));
    await send(ctx.pool.retryCollateralRelease(poolId));
    expect(await ctx.registry.pledgedTo(eblId)).to.equal(ethers.ZeroAddress);
  });

  it('reports nothing to retry after a controlled pool released its title in line', async () => {
    const c = await deployRights(), p = await funded(c);
    await send(c.controller.connect(c.operator).disburse(p.poolId, 8_000_000n, uniqueHash()));
    await send(c.usdc.mint(c.holder.address, 2_000_000n)); await send(c.usdc.connect(c.holder).approve(await c.pool.getAddress(), 10_000_000n));
    await send(c.pool.connect(c.holder).repay(p.poolId, 10_000_000n));
    await c.lifecycle(c.attestor, 'recordImporterPayment', [p.poolId, uniqueHash(), 10_000_000n]);
    await c.lifecycle(c.attestor, 'recordCargoArrival', [p.poolId, uniqueHash()]);
    await c.lifecycle(c.operator, 'settle', [p.poolId, 10_000_000n]);
    expect(await c.registry.pledgedTo(p.eblId)).to.equal(ethers.ZeroAddress);
    expect(await c.pool.connect(c.outsider).retryCollateralRelease.staticCall(p.poolId)).to.equal(false);
  });

  it('discloses the per-investor subscription segment limit the contract enforces, bound into the signed terms', async () => {
    const c = await deployRights(), p = await c.create({ supply: 100n, minRaise: 100n, issuePrice: 1n, target: 2n });
    const rights = await ethers.getContractAt('RecoveryEntitlements', await c.pool.recoveryRights());
    expect(await rights.MAX_LOTS()).to.equal(BigInt(FINANCE_POLICY.max_subscription_segments_per_investor));
    for (const w of [c.investor, c.outsider]) await c.eligible(p, w);
    for (let i = 0; i < 3; i++) for (const w of [c.investor, c.outsider]) await send(c.pool.connect(w).subscribe(p.poolId, 1));
    await send(c.pool.connect(c.investor).subscribe(p.poolId, 1));
    await send(c.pool.connect(c.investor).subscribe(p.poolId, 1));
    expect(await rights.lotCount(p.poolId, c.investor.address)).to.equal(4n);
    expect(await rights.lotCount(p.poolId, c.outsider.address)).to.equal(3n);

    const { policyHash: _policy, disclosureHash: _disclosure, ...raw } = p.terms;
    const pack = createDisclosure({ revision: 1, instance: { chain_id: 31337, controller: await c.controller.getAddress(), pool: await c.pool.getAddress(), control_version: 4 },
      terms: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)])),
      parties: Object.fromEntries(['issuer', 'holder', 'operator', 'valuer', 'compliance', 'disposer', 'reviewer'].map((role) => [role, c[role].address]).concat([['governance', await c.governance.getAddress()]])),
      sources: ['invoice', 'cost', 'collateral', 'risk'].map((field) => ({ field, status: 'fixture', reference: 'fictional research data' })) });
    expect(pack.document.policy.max_subscription_segments_per_investor).to.equal(32);
    expect(await c.controller.hashTerms(pack.terms)).to.equal(pack.terms_hash);
  });
});
