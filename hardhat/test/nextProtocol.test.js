import { expect } from 'chai';
import { deployRights, ethers, send, uniqueHash, STATE, ACTION, TERMS_TYPES, VALUATION_TYPES } from './helpers/rights.js';

const pay = async (c, id, payer, amount) => {
  await send(c.usdc.mint(payer.address, amount));
  await send(c.usdc.connect(payer).approve(await c.pool.getAddress(), amount));
  await send(c.pool.connect(payer).repay(id, amount));
};
async function funded(c, patch = {}, amounts = [5n, 5n]) {
  const p = await c.create(patch);
  for (const [i, shares] of amounts.entries()) {
    const wallet = [c.investor, c.outsider][i];
    await c.eligible(p, wallet);
    await send(c.pool.connect(wallet).subscribe(p.poolId, shares));
  }
  return p;
}
const draw = (c, p, amount = 8_000_000n) => send(c.controller.connect(c.operator).disburse(p.poolId, amount, uniqueHash()));
// Before maturity only delayed governance may start liquidation.
async function liquidate(c, p) {
  await c.govern(c.controller, 'applyPricingAction', [p.poolId, 0, ACTION.TRIGGER_LIQUIDATION, uniqueHash(), uniqueHash()]);
  const cash = await c.pool.recoveredAtomic(p.poolId) + p.terms.supply * p.terms.issuePrice - await c.pool.disbursedAtomic(p.poolId);
  await send(c.controller.connect(c.disposer).notifyResolution(p.poolId, uniqueHash(), uniqueHash(), cash));
}
async function assertCash(c, p) {
  const o = await c.pool.offerings(p.poolId);
  expect(await c.pool.escrowed(p.poolId, p.terms.settlementAsset)).to.equal(o.raisedAtomic + await c.pool.recoveredAtomic(p.poolId)
    - await c.pool.disbursedAtomic(p.poolId) - await c.pool.totalClaimed(p.poolId) - await c.pool.feesDeducted(p.poolId));
}

describe('N0/N1 bounded exits, permanent recovery rights and zero fees', () => {
  it('CA-01: enforces draw cutoff before/equal/after, independently of a default transaction', async () => {
    const c = await deployRights(), time = await c.now();
    const p = await funded(c, { subscribeUntil: time + 1000n, disburseUntil: time + 2000n, maturity: time + 5000n });
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(p.terms.disburseUntil - 1n)]);
    await draw(c, p, 1_000_000n);
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(p.terms.disburseUntil)]);
    await expect(draw(c, p, 1n)).to.be.revertedWithCustomError(c.pool, 'DeadlineElapsed');
    await c.advance(p.terms.maturity + 1n);
    await expect(draw(c, p, 1n)).to.be.revertedWithCustomError(c.pool, 'DeadlineElapsed');
    expect(await c.pool.disbursedAtomic(p.poolId)).to.equal(1_000_000n);
    await assertCash(c, p);
  });
  it('CA-01: refuses initial draw after valuation expiry and revoked valuer/test-asset/source', async () => {
    const c = await deployRights();
    for (const revoke of ['expiry', 'valuer', 'asset', 'issuer']) {
      const p = await funded(c);
      if (revoke === 'expiry') await c.advance(p.valuation.validUntil);
      if (revoke === 'valuer') await c.govern(c.controller, 'setRole', [await c.controller.VALUER(), c.valuer.address, false]);
      if (revoke === 'asset') await c.govern(c.controller, 'setTestAsset', [await c.usdc.getAddress(), false]);
      if (revoke === 'issuer') await c.govern(c.registry, 'revokeIssuer', [c.organization, c.issuer.address, uniqueHash()]);
      await send(c.controller.connect(c.compliance).refreshScreening((await c.now()) + 80000n, uniqueHash()));
      await expect(draw(c, p)).to.be.revertedWith(revoke === 'issuer' ? 'intake unavailable' : 'draw sources unavailable');
      if (revoke === 'valuer') await c.govern(c.controller, 'setRole', [await c.controller.VALUER(), c.valuer.address, true]);
      if (revoke === 'asset') await c.govern(c.controller, 'setTestAsset', [await c.usdc.getAddress(), true]);
    }
  });
  it('exits a funded but undrawn pool at the exact cutoff despite revoked roles and frozen intake', async () => {
    const c = await deployRights(), p = await funded(c);
    await send(c.controller.connect(c.guardian).setIntakeStopped(true, uniqueHash()));
    await c.govern(c.controller, 'setRole', [await c.controller.OPERATOR(), c.operator.address, false]);
    await c.advance(p.terms.disburseUntil);
    await send(c.controller.connect(c.outsider).startExit(p.poolId));
    expect(await c.pool.targetDistribution(p.poolId)).to.equal(8_000_000n);
    for (const w of [c.outsider, c.investor]) await send(c.pool.connect(w).claim(p.poolId));
    expect(await c.pool.totalClaimed(p.poolId)).to.equal(8_000_000n);
    expect(await c.registry.pledgedTo(p.eblId)).to.equal(ethers.ZeroAddress);
    await assertCash(c, p);
  });
  it('prices only drawn principal, returns idle escrow, and exits without operator/reviewer/attestor', async () => {
    const c = await deployRights(), p = await funded(c);
    await draw(c, p, 3_000_000n); await pay(c, p.poolId, c.holder, 1_000_000n);
    expect(await c.pool.targetDistribution(p.poolId)).to.equal(8_750_000n);
    expect(await c.pool.outstandingDebt(p.poolId)).to.equal(2_750_000n);
    await c.advance(p.terms.maturity);
    await send(c.controller.connect(c.outsider).startExit(p.poolId));
    const r = await c.controller.resolutions(p.poolId);
    await c.advance(r.hardDeadline);
    await send(c.controller.connect(c.investor).finalizeResolution(p.poolId));
    expect(await c.pool.realizedLoss(p.poolId)).to.equal(2_750_000n);
    for (const w of [c.investor, c.outsider]) await send(c.pool.connect(w).claim(p.poolId));
    expect(await c.pool.totalClaimed(p.poolId)).to.equal(6_000_000n);
    await assertCash(c, p);
  });
  it('CA-02: repeated one-atom receipts cannot reset notice; burned shares keep all late distributions', async () => {
    const c = await deployRights(), p = await funded(c); await draw(c, p);
    await pay(c, p.poolId, c.holder, 4_000_000n); await liquidate(c, p);
    await send(c.controller.connect(c.reviewer).reviewResolution(p.poolId, uniqueHash()));
    const r = await c.controller.resolutions(p.poolId);
    for (let i = 0; i < 4; i++) await pay(c, p.poolId, c.memberA, 1n);
    await expect(c.controller.connect(c.disposer).notifyResolution(p.poolId, uniqueHash(), uniqueHash(), 4_000_004n)).to.be.revertedWith('resolution locked');
    expect((await c.controller.resolutions(p.poolId)).noticeUntil).to.equal(r.noticeUntil);
    await c.advance(r.noticeUntil);
    await send(c.controller.connect(c.memberA).finalizeResolution(p.poolId));
    for (const w of [c.outsider, c.investor]) await send(c.pool.connect(w).claim(p.poolId));
    expect(await c.token.totalSupply(p.poolId)).to.equal(0n);
    expect(await c.pool.totalClaimed(p.poolId)).to.equal(4_000_004n);
    for (const value of [1n, 1n, 6_000_007n]) {
      await pay(c, p.poolId, c.holder, value);
      for (const w of [c.investor, c.outsider]) if (await c.pool.claimable(p.poolId, w.address)) await send(c.pool.connect(w).claim(p.poolId));
      await assertCash(c, p);
    }
    expect(await c.pool.totalClaimed(p.poolId)).to.equal(10_000_013n);
    expect(await c.pool.escrowed(p.poolId, p.terms.settlementAsset)).to.equal(0n);
    expect(await c.pool.realizedLoss(p.poolId)).to.equal(0n);
  });
  it('CA-03: rejects same fact, pseudo-new hashes and rotating participants after one dispute', async () => {
    const c = await deployRights(), p = await funded(c); await draw(c, p); await liquidate(c, p);
    const fact = uniqueHash();
    await send(c.controller.connect(c.investor).disputeResolution(p.poolId, fact));
    await c.govern(c.controller, 'resolveDispute', [p.poolId, uniqueHash()]);
    for (const [w, hash] of [[c.investor, fact], [c.investor, uniqueHash()], [c.outsider, uniqueHash()], [c.holder, uniqueHash()]]) {
      await expect(c.controller.connect(w).disputeResolution(p.poolId, hash)).to.be.revertedWith('dispute window closed');
    }
    const r = await c.controller.resolutions(p.poolId);
    await c.advance(r.hardDeadline);
    await send(c.controller.connect(c.memberA).finalizeResolution(p.poolId));
    expect(await c.pool.stateOf(p.poolId)).to.equal(STATE.LossSettled);
  });
  it('CA-03: governance/reviewer absence cannot exceed the fixed three-day deadline', async () => {
    const c = await deployRights(), p = await funded(c); await draw(c, p); await liquidate(c, p);
    await send(c.controller.connect(c.investor).disputeResolution(p.poolId, uniqueHash()));
    const r = await c.controller.resolutions(p.poolId);
    await c.advance(r.hardDeadline - 2n);
    await expect(c.controller.connect(c.memberA).finalizeResolution(p.poolId)).to.be.revertedWith('resolution not approved');
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(r.hardDeadline)]);
    await send(c.controller.connect(c.memberA).finalizeResolution(p.poolId));
    for (const w of [c.investor, c.outsider]) await send(c.pool.connect(w).claim(p.poolId));
    expect(await c.token.totalSupply(p.poolId)).to.equal(0n);
  });
  it('CA-04: rejects nonzero signed fees and any governed deduction before/after claims', async () => {
    const c = await deployRights(), bad = await c.prepare({ maxFee: 1n });
    await send(c.registry.pledge(bad.eblId, await c.pool.getAddress(), bad.hash, bad.pledge.validUntil, bad.pledgeSignature));
    await expect(c.controller.connect(c.issuer).createControlledOffering(bad.terms, bad.valuation, c.valuer.address, bad.valuationSignature)).to.be.revertedWith('fee or maturity bounds');
    const p = await funded(c); await draw(c, p); await pay(c, p.poolId, c.holder, 10_000_001n); await liquidate(c, p);
    await send(c.controller.connect(c.reviewer).reviewResolution(p.poolId, uniqueHash())); await c.advance((await c.controller.resolutions(p.poolId)).noticeUntil);
    await send(c.controller.finalizeResolution(p.poolId));
    for (const w of [c.outsider, c.investor]) {
      const fee = await c.queue(c.controller, 'deductFee', [p.poolId, 1n, uniqueHash()]); await c.advance(fee.eta);
      await expect(c.governance.execute(fee.id, fee.data)).to.be.revertedWith('fee cap exceeded');
      await send(c.pool.connect(w).claim(p.poolId));
    }
    expect(await c.pool.totalClaimed(p.poolId)).to.equal(10_000_001n); await assertCash(c, p);
  });
  it('rejects v1/cross-instance valuation signatures and commits the exact draw deadline', async () => {
    const c = await deployRights(), p = await c.prepare();
    expect(await c.controller.hashTerms(p.terms)).to.equal(ethers.TypedDataEncoder.hash(c.domain, TERMS_TYPES, p.terms));
    expect(await c.controller.hashTerms({ ...p.terms, disburseUntil: p.terms.disburseUntil - 1n })).not.to.equal(p.hash);
    await send(c.registry.pledge(p.eblId, await c.pool.getAddress(), p.hash, p.pledge.validUntil, p.pledgeSignature));
    const oldSignature = await c.valuer.signTypedData({ ...c.domain, version: '1' }, VALUATION_TYPES, p.valuation);
    await expect(c.controller.connect(c.issuer).createControlledOffering(p.terms, p.valuation, c.valuer.address, oldSignature)).to.be.revertedWith('invalid valuation signature');
  });
  it('preserves separated subscription lots and bounds per-investor claim work without retaining a rejected payment', async () => {
    const c = await deployRights(), p = await c.create();
    for (const w of [c.investor, c.outsider]) await c.eligible(p, w);
    for (const [w, amount] of [[c.investor, 2], [c.outsider, 3], [c.investor, 5]]) await send(c.pool.connect(w).subscribe(p.poolId, amount));
    await draw(c, p); await liquidate(c, p); await c.advance((await c.controller.resolutions(p.poolId)).hardDeadline);
    await send(c.controller.finalizeResolution(p.poolId)); await pay(c, p.poolId, c.holder, 13n);
    expect(await c.pool.claimable(p.poolId, c.investor.address)).to.equal(9n);
    expect(await c.pool.claimable(p.poolId, c.outsider.address)).to.equal(4n);
    const large = await c.create({ supply: 100n, minRaise: 100n, issuePrice: 1n, target: 2n });
    for (const w of [c.investor, c.outsider]) await c.eligible(large, w);
    for (let i = 0; i < 32; i++) for (const w of [c.investor, c.outsider]) await send(c.pool.connect(w).subscribe(large.poolId, 1));
    const before = await c.usdc.balanceOf(c.investor.address);
    const rights = await ethers.getContractAt('RecoveryEntitlements', await c.pool.recoveryRights());
    await expect(c.pool.connect(c.investor).subscribe(large.poolId, 1)).to.be.revertedWithCustomError(rights, 'LotLimit');
    expect(await c.usdc.balanceOf(c.investor.address)).to.equal(before);
    expect((await c.pool.offerings(large.poolId)).subscribed).to.equal(64n);
    await assertCash(c, large);
  });
  for (const seed of [17, 20261018, 0xabcdef]) it(`conserves every atomic unit under adversarial claim scheduling, seed=${seed}`, async () => {
    const c = await deployRights(), p = await funded(c, {}, [3n, 7n]); await draw(c, p); await liquidate(c, p);
    await c.advance((await c.controller.resolutions(p.poolId)).hardDeadline); await send(c.controller.finalizeResolution(p.poolId));
    let random = seed >>> 0, cash = 0n;
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    const received = [0n, 0n];
    for (let step = 0; step < 24; step++) {
      const value = BigInt(next() % 53 + 1); cash += value; await pay(c, p.poolId, c.memberA, value);
      const expected = [0n, 0n];
      // Independent, deliberately simple atomic-unit allocation model.
      for (let atom = 0n; atom < cash; atom++) expected[atom % 10n < 3n ? 0 : 1]++;
      const order = next() % 2 ? [0, 1] : [1, 0];
      for (const i of order) {
        const w = [c.investor, c.outsider][i];
        expect(await c.pool.claimable(p.poolId, w.address), `seed=${seed}, step=${step}, cash=${cash}`).to.equal(expected[i] - received[i]);
        if (expected[i] > received[i] || await c.token.balanceOf(p.poolId, w.address)) await send(c.pool.connect(w).claim(p.poolId));
        received[i] = expected[i]; await assertCash(c, p);
      }
      expect(await c.pool.totalClaimed(p.poolId)).to.equal(cash);
    }
  });
});
