import { expect } from 'chai';
import { deployRights, ethers, send, uniqueHash, STATE, ACTION, PLEDGE_TYPES, VALUATION_TYPES } from './helpers/rights.js';

const pay = async (c, poolId, amount) => {
  await send(c.usdc.mint(c.holder.address, amount));
  await send(c.usdc.connect(c.holder).approve(await c.pool.getAddress(), amount));
  await send(c.pool.connect(c.holder).repay(poolId, amount));
};
async function drawn(c, patch = {}) {
  const p = await c.create(patch); await c.eligible(p);
  await send(c.pool.connect(c.investor).subscribe(p.poolId, 10));
  await send(c.controller.connect(c.operator).disburse(p.poolId, 8_000_000n, uniqueHash()));
  return p;
}
// A new pledge of the same title on new terms, signed by the holder.
async function repledge(c, p, overrides = {}) {
  const fresh = await c.prepare(overrides, p);
  await send(c.registry.pledge(p.eblId, await c.pool.getAddress(), fresh.hash, fresh.pledge.validUntil, fresh.pledgeSignature));
  return fresh;
}
const issue = (c, fresh) => send(c.controller.connect(c.issuer).createControlledOffering(fresh.terms, fresh.valuation, c.valuer.address, fresh.valuationSignature));

describe('control version 4', () => {
  it('signs offering terms and valuations under the version 4 domain only', async () => {
    const c = await deployRights();
    expect(await c.controller.controlVersion()).to.equal(4n);
    expect((await c.controller.eip712Domain()).version).to.equal('4');
    const p = await c.prepare();
    await send(c.registry.pledge(p.eblId, await c.pool.getAddress(), p.hash, p.pledge.validUntil, p.pledgeSignature));
    const v3Signature = await c.valuer.signTypedData({ ...c.domain, version: '3' }, VALUATION_TYPES, p.valuation);
    await expect(c.controller.connect(c.issuer).createControlledOffering(p.terms, p.valuation, c.valuer.address, v3Signature)).to.be.revertedWith('invalid valuation signature');
  });

  describe('F02: a release is bound to the pledge its offering was created on', () => {
    it('an earlier terminal pool cannot release a newer pledge before or after the newer pool exists', async () => {
      const c = await deployRights(), old = await c.create();
      await c.lifecycle(c.operator, 'cancelOffering', [old.poolId, uniqueHash('cancel')]);
      expect(await c.registry.pledgedTo(old.eblId)).to.equal(ethers.ZeroAddress);
      const fresh = await repledge(c, old);
      expect(await c.registry.pledgeId(old.eblId)).not.to.equal(await c.controller.pledgeOf(old.poolId));
      // The report's counterexample: an outsider retries the old pool between the new pledge and the new pool.
      await expect(c.pool.connect(c.outsider).retryCollateralRelease(old.poolId)).to.be.revertedWith('offering missing');
      expect(await c.registry.pledgedTo(old.eblId)).to.equal(await c.pool.getAddress());
      expect(await c.registry.pledgeTerms(old.eblId)).to.equal(fresh.hash);
      await issue(c, fresh);
      const newer = (await c.pool.nextPoolId()) - 1n;
      expect(await c.controller.pledgeOf(newer)).to.equal(await c.registry.pledgeId(old.eblId));
      expect(await c.pool.connect(c.outsider).retryCollateralRelease.staticCall(old.poolId)).to.equal(false);
      // The newer pool ends, then a third pledge is made: neither earlier pool can touch it.
      await c.lifecycle(c.operator, 'cancelOffering', [newer, uniqueHash('cancel-newer')]);
      const third = await repledge(c, old);
      for (const id of [old.poolId, newer]) await expect(c.pool.connect(c.outsider).retryCollateralRelease(id)).to.be.revertedWith('offering missing');
      await issue(c, third);
      expect(await c.pool.poolOfEbl(old.eblId)).to.equal(newer + 1n);
    });

    it('lets the holder withdraw a new pledge on the very same terms an earlier pool used', async () => {
      const c = await deployRights(), p = await c.prepare();
      await send(c.registry.pledge(p.eblId, await c.pool.getAddress(), p.hash, p.pledge.validUntil, p.pledgeSignature));
      await issue(c, p);
      const poolId = (await c.pool.nextPoolId()) - 1n;
      await expect(c.registry.connect(c.holder).withdrawUnopenedPledge(p.eblId)).to.be.revertedWith('offering exists');
      // One pledge backs one offering: a second valuation on the same pledge is refused by the controller itself.
      const again = { ...p.valuation, nonce: BigInt(uniqueHash('second-valuation')) };
      await expect(c.controller.connect(c.issuer).createControlledOffering(p.terms, again, c.valuer.address, await c.valuer.signTypedData(c.domain, VALUATION_TYPES, again)))
        .to.be.revertedWith('holder terms not approved');
      await c.lifecycle(c.operator, 'cancelOffering', [poolId, uniqueHash('cancel')]);
      const pledge = { ...p.pledge, nonce: await c.registry.holderNonce(p.eblId) };
      await send(c.registry.pledge(p.eblId, await c.pool.getAddress(), p.hash, pledge.validUntil, await c.holder.signTypedData(c.title, PLEDGE_TYPES, pledge)));
      // Version 3 compared terms hashes, so this pledge could neither be withdrawn nor, after a retry, kept.
      await send(c.registry.connect(c.holder).withdrawUnopenedPledge(p.eblId));
      expect(await c.registry.pledgedTo(p.eblId)).to.equal(ethers.ZeroAddress);
    });
  });

  describe('F03: the price is the one the holder pledged and the valuer signed', () => {
    it('refuses every repricing action, and the pool and the committed terms keep one price', async () => {
      const c = await deployRights(), p = await c.create({ minRaise: 7_000_000n });
      for (const action of [ACTION.OPEN_OFFERING, ACTION.OPEN_WITH_WARNING, ACTION.REPRICE_DOWN]) {
        await expect(c.controller.connect(c.operator).applyPricingAction(p.poolId, 700_000n, action, uniqueHash(), uniqueHash()))
          .to.be.revertedWithCustomError(c.controller, 'InvalidOperation');
        const op = await c.queue(c.controller, 'applyPricingAction', [p.poolId, 700_000n, action, uniqueHash(), uniqueHash()]); await c.advance(op.eta);
        await expect(c.governance.execute(op.id, op.data)).to.be.revertedWithCustomError(c.controller, 'InvalidOperation');
      }
      // A pause passes a price the controller ignores; nothing else about the offering moves.
      await send(c.controller.connect(c.operator).applyPricingAction(p.poolId, 1n, ACTION.PAUSE_OFFERING, uniqueHash(), uniqueHash()));
      await send(c.controller.connect(c.operator).applyPricingAction(p.poolId, 1n, ACTION.RESUME_OFFERING, uniqueHash(), uniqueHash()));
      expect(await c.pool.issuePriceOf(p.poolId)).to.equal((await c.controller.terms(p.poolId)).issuePrice);
      expect(await c.pool.quoteVersion(p.poolId)).to.equal(1n);
      // A direct subscription, bypassing the application, pays exactly the signed price.
      await c.eligible(p);
      await send(c.pool.connect(c.investor).subscribe(p.poolId, 10n));
      expect(await c.pool.investorPaid(p.poolId, await c.usdc.getAddress(), c.investor.address)).to.equal(10n * p.terms.issuePrice);
    });

    it('takes a new price only as a new offering on newly pledged and valued terms', async () => {
      const c = await deployRights(), old = await c.create();
      await c.lifecycle(c.operator, 'cancelOffering', [old.poolId, uniqueHash('cancel')]);
      const fresh = await repledge(c, old, { issuePrice: 700_000n, minRaise: 7_000_000n });
      await issue(c, fresh);
      const poolId = (await c.pool.nextPoolId()) - 1n;
      expect(await c.pool.issuePriceOf(poolId)).to.equal(700_000n);
      expect(await c.controller.termsHash(poolId)).to.equal(fresh.hash);
      // Acceptances of the earlier offering do not carry over.
      await expect(c.controller.connect(c.investor).acknowledgeTerms(poolId, old.hash, 1, fresh.terms.subscribeUntil)).to.be.revertedWith('terms changed');
    });
  });

  describe('F05: only a real shortfall at maturity is a default', () => {
    it('closes a matured, fully repaid pool as repaid when an outsider starts the exit', async () => {
      const c = await deployRights(), p = await drawn(c);
      await pay(c, p.poolId, 10_000_000n);
      await expect(c.controller.connect(c.outsider).startExit(p.poolId)).to.be.revertedWithCustomError(c.pool, 'BadState');
      await c.advance(p.terms.maturity);
      expect(await c.pool.outstandingDebt(p.poolId)).to.equal(0n);
      await expect(c.controller.connect(c.operator).executeLifecycle(c.pool.interface.encodeFunctionData('markDefault', [p.poolId])))
        .to.be.revertedWithCustomError(c.pool, 'NotOverdue');
      await send(c.controller.connect(c.outsider).startExit(p.poolId));
      expect(await c.pool.stateOf(p.poolId)).to.equal(STATE.Repaid);
      expect((await c.controller.resolutions(p.poolId)).proposer).to.equal(ethers.ZeroAddress);
      expect(await c.registry.pledgedTo(p.eblId)).to.equal(ethers.ZeroAddress);
      await send(c.pool.connect(c.investor).claim(p.poolId));
      expect(await c.pool.totalClaimed(p.poolId)).to.equal(10_000_000n);
    });

    it('still defaults a matured pool one atom short, through the cash-only resolution', async () => {
      const c = await deployRights(), p = await drawn(c);
      await pay(c, p.poolId, 9_999_999n);
      await c.advance(p.terms.maturity);
      expect(await c.pool.outstandingDebt(p.poolId)).to.equal(1n);
      await send(c.controller.connect(c.outsider).startExit(p.poolId));
      expect(await c.pool.stateOf(p.poolId)).to.equal(STATE.Defaulted);
      expect((await c.controller.resolutions(p.poolId)).proposer).to.equal(await c.controller.getAddress());
    });

    it('does not close a frozen pool with nothing owed; delayed governance unfreezes it first', async () => {
      const c = await deployRights(), p = await drawn(c);
      await pay(c, p.poolId, 10_000_000n);
      await send(c.controller.connect(c.operator).applyPricingAction(p.poolId, 0, ACTION.FREEZE_POOL, uniqueHash(), uniqueHash()));
      await c.advance(p.terms.maturity);
      await expect(c.controller.connect(c.outsider).startExit(p.poolId)).to.be.revertedWithCustomError(c.pool, 'BadState');
      await c.govern(c.controller, 'executeLifecycle', [c.pool.interface.encodeFunctionData('unfreezeOffering', [p.poolId, uniqueHash()])]);
      await send(c.controller.connect(c.outsider).startExit(p.poolId));
      expect(await c.pool.stateOf(p.poolId)).to.equal(STATE.Repaid);
    });
  });

  describe('F06: an offering nobody subscribed can be exited without an operator', () => {
    it('cancels after the subscription window, releases the title and lets the holder pledge again', async () => {
      const c = await deployRights(), p = await c.create();
      await expect(c.controller.connect(c.holder).startExit(p.poolId)).to.be.revertedWith('offering still open');
      // The deadline is inclusive: a transaction in the deadline's own second may still subscribe.
      await c.advance(p.terms.subscribeUntil - 1n);
      await expect(c.controller.connect(c.holder).startExit(p.poolId)).to.be.revertedWith('offering still open');
      await c.advance(p.terms.subscribeUntil + 1n);
      await expect(c.controller.connect(c.outsider).startExit(p.poolId)).to.emit(c.pool, 'OfferingCancelled');
      expect(await c.pool.stateOf(p.poolId)).to.equal(STATE.Cancelled);
      expect(await c.registry.pledgedTo(p.eblId)).to.equal(ethers.ZeroAddress);
      await expect(c.controller.connect(c.holder).startExit(p.poolId)).to.be.revertedWithCustomError(c.pool, 'IllegalTransition');
      await issue(c, await repledge(c, p));
    });

    it('keeps a frozen unsubscribed offering for governance, and leaves a refunded raise to its refunds', async () => {
      const c = await deployRights(), p = await c.create();
      await send(c.controller.connect(c.operator).applyPricingAction(p.poolId, 0, ACTION.FREEZE_POOL, uniqueHash(), uniqueHash()));
      await c.advance(p.terms.maturity + 1n);
      await expect(c.controller.connect(c.holder).startExit(p.poolId)).to.be.revertedWith('offering still open');
      expect(await c.registry.pledgedTo(p.eblId)).to.equal(await c.pool.getAddress());

      const q = await c.create(); await c.eligible(q);
      await send(c.pool.connect(c.investor).subscribe(q.poolId, 2));
      await c.advance(q.terms.subscribeUntil + 1n);
      // A failed raise is not an unsubscribed one: the startExit path does not cancel over a paid position.
      await expect(c.controller.connect(c.holder).startExit(q.poolId)).to.be.revertedWithCustomError(c.pool, 'BadState');
      await send(c.pool.connect(c.outsider).refundInvestor(q.poolId, c.investor.address));
      expect(await c.pool.stateOf(q.poolId)).to.equal(STATE.Cancelled);
      expect(await c.registry.pledgedTo(q.eblId)).to.equal(ethers.ZeroAddress);
    });
  });

  describe('F07: cancelling an approved operation takes two members, like approving it', () => {
    it('ignores one member alone, cancels on a second member, and lets an approver withdraw an unapproved proposal', async () => {
      const c = await deployRights();
      const op = await c.queue(c.controller, 'setRole', [await c.controller.OPERATOR(), c.outsider.address, true]);
      await expect(c.governance.connect(c.memberC).cancel(op.id)).to.emit(c.governance, 'CancelVoted').and.not.to.emit(c.governance, 'Cancelled');
      await expect(c.governance.connect(c.memberC).cancel(op.id)).to.be.revertedWith('cannot cancel');
      await expect(c.governance.connect(c.outsider).cancel(op.id)).to.be.revertedWith('cannot cancel');
      await c.advance(op.eta);
      await send(c.governance.execute(op.id, op.data));
      expect(await c.controller.roles(await c.controller.OPERATOR(), c.outsider.address)).to.equal(true);

      const second = await c.queue(c.controller, 'setRole', [await c.controller.OPERATOR(), c.outsider.address, false]);
      await send(c.governance.connect(c.memberC).cancel(second.id));
      await expect(c.governance.connect(c.memberB).cancel(second.id)).to.emit(c.governance, 'Cancelled').withArgs(second.id);
      await c.advance(second.eta);
      await expect(c.governance.execute(second.id, second.data)).to.be.revertedWith('not approved');

      const data = c.controller.interface.encodeFunctionData('setIntakeStopped', [true, uniqueHash()]);
      const receipt = await send(c.governance.connect(c.memberA).propose(await c.controller.getAddress(), data, uniqueHash()));
      const id = receipt.logs.map((log) => { try { return c.governance.interface.parseLog(log); } catch { return null; } }).find((e) => e?.name === 'Proposed').args.id;
      await expect(c.governance.connect(c.memberA).cancel(id)).to.emit(c.governance, 'Cancelled').withArgs(id);
      await expect(c.governance.connect(c.memberB).approve(id)).to.be.revertedWith('invalid operation');
    });

    it('lets two members remove a third who votes against it', async () => {
      const c = await deployRights(), [fourth] = (await ethers.getSigners()).slice(14);
      await c.govern(c.governance, 'setMember', [fourth.address, true]);
      const removal = await c.queue(c.governance, 'setMember', [c.memberC.address, false]);
      await send(c.governance.connect(c.memberC).cancel(removal.id));
      await c.advance(removal.eta);
      await send(c.governance.execute(removal.id, removal.data));
      expect(await c.governance.member(c.memberC.address)).to.equal(false);
      expect(await c.governance.memberCount()).to.equal(3n);
    });
  });
});
