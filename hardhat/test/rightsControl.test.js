import { expect } from 'chai';
import { deployRights, ethers, send, uniqueHash, STATE, ACTION, ISSUANCE_TYPES, VALUATION_TYPES, titleDomain, rightsDomain } from './helpers/rights.js';

describe('W3 committed rights and controlled capital instance', () => {
  it('deploys within standard code/initcode limits and permanently binds ownership, gate and minter', async () => {
    const c = await deployRights();
    expect(await c.pool.owner()).to.equal(await c.controller.getAddress());
    expect(await c.pool.oracle()).to.equal(await c.controller.getAddress());
    expect(await c.pool.accessMode()).to.equal(1n);
    expect(await c.token.pool()).to.equal(await c.pool.getAddress());
    await expect(c.token.bindPool(c.outsider.address)).to.be.revertedWith('pool binding locked');
    await expect(c.token.connect(c.outsider).mint(1n, c.outsider.address, 1n)).to.be.revertedWith('invalid mint');
    await expect(c.pool.setAccessMode(0)).to.be.revertedWith('not owner');
    await expect(c.pool.setAgentExecutor(c.outsider.address, true)).to.be.revertedWith('not owner');
    await expect(c.controller.connect(c.outsider).setRole(await c.controller.OPERATOR(), c.outsider.address, true)).to.be.revertedWith('not governance');
    for (const contract of [c.controller, c.pool, c.registry, c.token, c.governance]) expect((await ethers.provider.getCode(await contract.getAddress())).length / 2 - 1).to.be.at.most(24576);
    expect((c.controller.deploymentTransaction().data.length - 2) / 2).to.be.at.most(49152);
  });
  it('requires distinct governance approvals, visible delay, exact payload and one execution', async () => {
    const c = await deployRights(), data = c.controller.interface.encodeFunctionData('setIntakeStopped', [true, uniqueHash()]);
    const receipt = await send(c.governance.propose(await c.controller.getAddress(), data, uniqueHash()));
    const opId = receipt.logs.map((log) => { try { return c.governance.interface.parseLog(log); } catch { return null; } }).find((event) => event?.name === 'Proposed').args.id;
    await expect(c.governance.approve(opId)).to.be.revertedWith('already approved');
    await expect(c.governance.execute(opId, data)).to.be.revertedWith('not approved');
    await send(c.governance.connect(c.memberB).approve(opId));
    await expect(c.governance.execute(opId, data)).to.be.revertedWith('outside execution window');
    await c.advance((await c.governance.operations(opId)).eta);
    await expect(c.governance.execute(opId, data + '00')).to.be.revertedWith('payload changed');
    await send(c.governance.execute(opId, data));
    await expect(c.governance.execute(opId, data)).to.be.revertedWith('not approved');
  });
  it('invalidates queued operations on member rotation and revokes old execution roles', async () => {
    const c = await deployRights(), queued = await c.queue(c.controller, 'setIntakeStopped', [true, uniqueHash()]);
    await c.govern(c.governance, 'setMember', [c.outsider.address, true]);
    await expect(c.governance.execute(queued.id, queued.data)).to.be.revertedWith('not approved');
    await c.govern(c.governance, 'setMember', [c.memberC.address, false]);
    await expect(c.governance.connect(c.memberC).propose(await c.controller.getAddress(), queued.data, uniqueHash())).to.be.revertedWith('invalid proposal');
    await c.govern(c.controller, 'setRole', [await c.controller.OPERATOR(), c.operator.address, false]);
    await expect(c.controller.connect(c.operator).disburse(1, 1, uniqueHash())).to.be.revertedWith('role required');
  });
  it('rejects issuance replay, altered holders, expired credentials and cross-chain or registry signatures', async () => {
    const c = await deployRights(), p = await c.register();
    await expect(c.registry.registerTitle(p.issuance, p.signature)).to.be.revertedWith('invalid issuer signature');
    const fresh = { ...p.issuance, nonce: 999n, assetKey: uniqueHash() };
    const sig = await c.issuer.signTypedData(c.title, ISSUANCE_TYPES, fresh);
    await expect(c.registry.registerTitle({ ...fresh, holder: c.outsider.address }, sig)).to.be.revertedWith('invalid issuer signature');
    await expect(c.registry.registerTitle(fresh, await c.issuer.signTypedData({ ...c.title, chainId: 1 }, ISSUANCE_TYPES, fresh))).to.be.revertedWith('invalid issuer signature');
    await expect(c.registry.registerTitle(fresh, await c.issuer.signTypedData(titleDomain(c.title.chainId, await c.controller.getAddress()), ISSUANCE_TYPES, fresh))).to.be.revertedWith('invalid issuer signature');
    await expect(c.registry.registerTitle({ ...fresh, validUntil: 1 }, sig)).to.be.revertedWith('invalid issuance');
  });
  it('preserves one identity through amendments, surrender and across enrolled registries / legacy aliases', async () => {
    const c = await deployRights(), p = await c.register();
    const amended = { ...p.issuance, documentHash: uniqueHash(), revision: 2, previousHash: p.issuance.documentHash, nonce: 91n };
    const issuerSig = await c.issuer.signTypedData(c.title, ISSUANCE_TYPES, amended), holderSig = await c.holder.signTypedData(c.title, ISSUANCE_TYPES, amended);
    await expect(c.registry.amendTitle(p.eblId, amended, issuerSig, '0x')).to.be.revertedWith('holder consent missing');
    await send(c.registry.amendTitle(p.eblId, amended, issuerSig, holderSig));
    expect((await c.registry.titles(p.eblId)).revision).to.equal(2n);
    await send(c.registry.connect(c.holder).surrender(p.eblId, uniqueHash()));
    await expect(c.register({ assetKey: p.issuance.assetKey })).to.be.revertedWith('asset already reserved');
    const other = await c.deploy('CommittedEBLRegistry', [await c.governance.getAddress(), await c.hub.getAddress()]);
    await c.govern(c.hub, 'setRegistry', [await other.getAddress(), true]); await c.govern(other, 'setIssuer', [c.organization, c.issuer.address]);
    const duplicate = { ...p.issuance, validUntil: (await c.now()) + 1000n, nonce: 92n };
    await expect(other.registerTitle(duplicate, await c.issuer.signTypedData(titleDomain(c.title.chainId, await other.getAddress()), ISSUANCE_TYPES, duplicate))).to.be.revertedWith('asset already reserved');
    const legacy = uniqueHash(); await c.govern(c.hub, 'reserveLegacy', [legacy, uniqueHash()]);
    await expect(c.register({ assetKey: legacy })).to.be.revertedWith('asset already reserved');
  });
  it('requires the independent holder to approve the exact pool and terms, with a revocable unopened pledge', async () => {
    const c = await deployRights(), p = await c.prepare();
    await expect(c.registry.connect(c.issuer).pledge(p.eblId, await c.pool.getAddress(), p.hash, p.pledge.validUntil, '0x')).to.be.revertedWith('holder consent missing');
    await expect(c.registry.pledge(p.eblId, await c.pool.getAddress(), uniqueHash(), p.pledge.validUntil, p.pledgeSignature)).to.be.revertedWith('holder consent missing');
    await send(c.registry.pledge(p.eblId, await c.pool.getAddress(), p.hash, p.pledge.validUntil, p.pledgeSignature));
    await expect(c.registry.connect(c.holder).endorse(p.eblId, c.outsider.address, uniqueHash())).to.be.revertedWith('title locked');
    await send(c.registry.connect(c.holder).withdrawUnopenedPledge(p.eblId));
    await expect(c.registry.pledge(p.eblId, await c.pool.getAddress(), p.hash, p.pledge.validUntil, p.pledgeSignature)).to.be.revertedWith('holder consent missing');
  });
  it('binds JS/Solidity terms and valuation hashes; rejects stale, cross-domain and undercovered finance', async () => {
    const c = await deployRights(), p = await c.prepare();
    expect(await c.controller.hashTerms(p.terms)).to.equal(p.hash);
    await send(c.registry.pledge(p.eblId, await c.pool.getAddress(), p.hash, p.pledge.validUntil, p.pledgeSignature));
    const attempt = async (patch, domain = c.domain) => {
      const v = { ...p.valuation, ...patch };
      return c.controller.connect(c.issuer).createControlledOffering(p.terms, v, c.valuer.address, await c.valuer.signTypedData(domain, VALUATION_TYPES, v));
    };
    await expect(attempt({ netValue: 1n })).to.be.revertedWith('under collateralized');
    await expect(attempt({ valuedAt: (await c.now()) + 999n })).to.be.revertedWith('valuation expired or future');
    await expect(attempt({ validUntil: 1n })).to.be.revertedWith('valuation expired or future');
    await expect(attempt({ settlementAsset: c.outsider.address })).to.be.revertedWith('valuation domain mismatch');
    await expect(attempt({}, rightsDomain(c.domain.chainId, await c.registry.getAddress()))).to.be.revertedWith('invalid valuation signature');
    await expect(attempt({ netValue: ethers.MaxUint256 })).to.be.revertedWith('valuation bounds');
    await expect(attempt({ coverageBps: 9999 })).to.be.revertedWith('valuation bounds');
    await send(attempt({}));
  });
  it('fails closed for missing/expired/revoked qualification, screening and changed quote acceptance', async () => {
    const c = await deployRights(), p = await c.create({ minRaise: 7_000_000n });
    await send(c.usdc.mint(c.investor.address, 10_000_000n)); await send(c.usdc.connect(c.investor).approve(await c.pool.getAddress(), ethers.MaxUint256));
    await expect(c.pool.connect(c.investor).subscribe(p.poolId, 1)).to.be.revertedWithCustomError(c.pool, 'NotEligible');
    await c.eligible(p);
    await send(c.controller.connect(c.operator).applyPricingAction(p.poolId, 700000, ACTION.REPRICE_DOWN, uniqueHash(), uniqueHash()));
    await expect(c.pool.connect(c.investor).subscribe(p.poolId, 1)).to.be.revertedWithCustomError(c.pool, 'NotEligible');
    await send(c.controller.connect(c.investor).acknowledgeTerms(p.poolId, p.hash, 2, p.terms.subscribeUntil));
    await send(c.pool.connect(c.investor).subscribeWithTerms(p.poolId, 1, 700000, 2, p.terms.subscribeUntil));
    await send(c.pool.connect(c.investor).subscribe(p.poolId, 1));
    await send(c.controller.connect(c.compliance).setEligibility(c.investor.address, uniqueHash(), uniqueHash(), 0));
    await expect(c.pool.connect(c.investor).subscribe(p.poolId, 1)).to.be.revertedWithCustomError(c.pool, 'NotEligible');
    await c.eligible(p); await c.advance((await c.now()) + 80001n);
    await expect(c.pool.connect(c.investor).subscribe(p.poolId, 1)).to.be.revertedWithCustomError(c.pool, 'NotEligible');
  });
  it('keeps refund rights after revoked eligibility, guardian intake stop and issuer suspension', async () => {
    const c = await deployRights(), p = await c.create(); await c.eligible(p);
    await send(c.pool.connect(c.investor).subscribe(p.poolId, 2));
    await send(c.controller.connect(c.guardian).setIntakeStopped(true, uniqueHash()));
    await expect(c.controller.connect(c.guardian).setIntakeStopped(false, uniqueHash())).to.be.revertedWith('not authorized');
    await c.govern(c.registry, 'revokeIssuer', [c.organization, c.issuer.address, uniqueHash()]);
    await c.advance(p.terms.subscribeUntil + 1n);
    await send(c.pool.connect(c.investor).refundInvestor(p.poolId, c.investor.address));
    expect(await c.token.balanceOf(p.poolId, c.investor.address)).to.equal(0n);
    expect(await c.registry.pledgedTo(p.eblId)).to.equal(ethers.ZeroAddress);
  });
  it('completes test capital disbursement, repayment and claims with fixed recipients and zero fees', async () => {
    const c = await deployRights(), p = await c.create(); await c.eligible(p);
    await send(c.pool.connect(c.investor).subscribe(p.poolId, 10));
    await expect(c.controller.connect(c.operator).executeLifecycle(c.pool.interface.encodeFunctionData('disburseToExporter', [p.poolId, 8_000_000n, c.outsider.address, uniqueHash()]))).to.be.revertedWith('call not authorized');
    await send(c.controller.connect(c.operator).disburse(p.poolId, 8_000_000n, uniqueHash()));
    expect(await c.usdc.balanceOf(c.holder.address)).to.equal(8_000_000n);
    await send(c.usdc.mint(c.holder.address, 2_000_000n)); await send(c.usdc.connect(c.holder).approve(await c.pool.getAddress(), 10_000_000n));
    await send(c.pool.connect(c.holder).repay(p.poolId, 10_000_000n));
    await c.lifecycle(c.attestor, 'recordImporterPayment', [p.poolId, uniqueHash(), 10_000_000n]);
    await c.lifecycle(c.attestor, 'recordCargoArrival', [p.poolId, uniqueHash()]);
    await c.lifecycle(c.operator, 'settle', [p.poolId, 10_000_000n]);
    const badFee = await c.queue(c.controller, 'deductFee', [p.poolId, 1_000_001n, uniqueHash()]); await c.advance(badFee.eta);
    await expect(c.governance.execute(badFee.id, badFee.data)).to.be.revertedWith('fee cap exceeded');
    await send(c.controller.connect(c.guardian).setIntakeStopped(true, uniqueHash()));
    await c.govern(c.controller, 'setRole', [await c.controller.COMPLIANCE(), c.compliance.address, false]);
    await send(c.pool.connect(c.investor).claim(p.poolId));
    expect(await c.pool.totalClaimed(p.poolId)).to.equal(10_000_000n);
    expect(await c.pool.stateOf(p.poolId)).to.equal(STATE.Repaid);
  });
  it('requires notification, independent disposal review and disputed recovery reconciliation before loss release', async () => {
    const c = await deployRights(), p = await c.create(); await c.eligible(p);
    await send(c.pool.connect(c.investor).subscribe(p.poolId, 10));
    await send(c.controller.connect(c.operator).disburse(p.poolId, 8_000_000n, uniqueHash()));
    await c.advance(p.terms.maturity + 1n); await c.lifecycle(c.operator, 'markDefault', [p.poolId]);
    await send(c.usdc.connect(c.holder).approve(await c.pool.getAddress(), 4_000_000n)); await send(c.pool.connect(c.holder).repay(p.poolId, 4_000_000n));
    await c.lifecycle(c.attestor, 'recordImporterPayment', [p.poolId, uniqueHash(), 4_000_000n]);
    await expect(c.controller.connect(c.operator).finalizeResolution(p.poolId)).to.be.revertedWith('resolution not approved');
    await send(c.controller.connect(c.disposer).notifyResolution(p.poolId, uniqueHash(), uniqueHash(), 4_000_000n));
    await send(c.controller.connect(c.investor).disputeResolution(p.poolId, uniqueHash()));
    await expect(c.controller.connect(c.reviewer).reviewResolution(p.poolId, uniqueHash())).to.be.revertedWith('review unavailable');
    await c.govern(c.controller, 'resolveDispute', [p.poolId, uniqueHash()]);
    await send(c.controller.connect(c.reviewer).reviewResolution(p.poolId, uniqueHash()));
    await expect(c.controller.connect(c.operator).finalizeResolution(p.poolId)).to.be.revertedWith('resolution not approved');
    await c.advance((await c.controller.resolutions(p.poolId)).noticeUntil);
    await send(c.controller.connect(c.operator).finalizeResolution(p.poolId));
    expect(await c.pool.realizedLoss(p.poolId)).to.equal(6_000_000n);
    expect((await c.registry.titles(p.eblId)).riskLocked).to.equal(true);
    const premature = await c.queue(c.controller, 'clearRiskLock', [p.eblId, uniqueHash()]); await c.advance(premature.eta);
    await expect(c.governance.execute(premature.id, premature.data)).to.be.revertedWith('distribution incomplete');
    await send(c.pool.connect(c.investor).claim(p.poolId));
    await c.govern(c.controller, 'clearRiskLock', [p.eblId, uniqueHash()]);
    expect((await c.registry.titles(p.eblId)).riskLocked).to.equal(false);
    expect(await c.hub.reservedBy(p.issuance.assetKey)).to.equal(await c.registry.getAddress());
  });
  it('preserves governed cancellation and expiry of queued operations', async () => {
    const c = await deployRights(), op = await c.queue(c.controller, 'setIntakeStopped', [true, uniqueHash()]);
    await send(c.governance.connect(c.memberC).cancel(op.id)); await c.advance(op.eta);
    await expect(c.governance.execute(op.id, op.data)).to.be.revertedWith('not approved');
    const expired = await c.queue(c.controller, 'setIntakeStopped', [true, uniqueHash()]);
    await c.advance(expired.eta + 7n * 86400n + 1n);
    await expect(c.governance.execute(expired.id, expired.data)).to.be.revertedWith('outside execution window');
  });
  it('checks ERC-1271 issuer signatures at execution and honors their revocation', async () => {
    const c = await deployRights(), contractSigner = await c.deploy('RightsTestSigner', [c.issuer.address]);
    await c.govern(c.registry, 'setIssuer', [c.organization, await contractSigner.getAddress()]);
    const p = await c.register();
    expect((await c.registry.titles(p.eblId)).issuer).to.equal(await contractSigner.getAddress());
    await send(contractSigner.connect(c.issuer).setEnabled(false));
    await expect(c.register()).to.be.revertedWith('invalid issuer signature');
  });
  it('rejects unsupported assets, overlarge supply and policy/fee commitments before creating an offering', async () => {
    const c = await deployRights();
    for (const [patch, reason] of [
      [{ settlementAsset: c.outsider.address }, 'invalid asset or recipient'],
      [{ supply: 10n ** 19n }, 'economic bounds'],
      [{ target: 10n ** 25n }, 'economic bounds'],
      [{ policyHash: ethers.ZeroHash }, 'policy missing'],
      [{ maxFee: 10_000_001n }, 'fee or maturity bounds']
    ]) {
      const p = await c.prepare(patch);
      await send(c.registry.pledge(p.eblId, await c.pool.getAddress(), p.hash, p.pledge.validUntil, p.pledgeSignature));
      await expect(c.controller.connect(c.issuer).createControlledOffering(p.terms, p.valuation, c.valuer.address, p.valuationSignature)).to.be.revertedWith(reason);
    }
  });
  it('stops new subscriptions for expired valuation and revoked valuer without blocking paid recovery', async () => {
    const c = await deployRights(), p = await c.create({ subscribeUntil: (await c.now()) + 260000n });
    await c.eligible(p); await send(c.pool.connect(c.investor).subscribe(p.poolId, 1));
    await c.advance(p.valuation.validUntil + 1n); await c.eligible(p);
    await expect(c.pool.connect(c.investor).subscribe(p.poolId, 1)).to.be.revertedWithCustomError(c.pool, 'NotEligible');
    const other = await c.create(); await c.eligible(other);
    await c.govern(c.controller, 'setRole', [await c.controller.VALUER(), c.valuer.address, false]);
    await expect(c.pool.connect(c.investor).subscribe(other.poolId, 1)).to.be.revertedWithCustomError(c.pool, 'NotEligible');
  });
  it('keeps a reviewed resolution live when late recovery changes and refuses self review', async () => {
    const c = await deployRights(), p = await c.create(); await c.eligible(p);
    await send(c.pool.connect(c.investor).subscribe(p.poolId, 10));
    await send(c.controller.connect(c.operator).disburse(p.poolId, 8_000_000n, uniqueHash()));
    await c.govern(c.controller, 'applyPricingAction', [p.poolId, 0, ACTION.TRIGGER_LIQUIDATION, uniqueHash(), uniqueHash()]);
    await send(c.controller.connect(c.disposer).notifyResolution(p.poolId, uniqueHash(), uniqueHash(), 0));
    await c.govern(c.controller, 'setRole', [await c.controller.REVIEWER(), c.disposer.address, true]);
    await expect(c.controller.connect(c.disposer).reviewResolution(p.poolId, uniqueHash())).to.be.revertedWith('review unavailable');
    await send(c.controller.connect(c.reviewer).reviewResolution(p.poolId, uniqueHash()));
    await send(c.usdc.connect(c.holder).approve(await c.pool.getAddress(), 1_000_000n)); await send(c.pool.connect(c.holder).repay(p.poolId, 1_000_000n));
    await c.advance((await c.controller.resolutions(p.poolId)).noticeUntil);
    await send(c.controller.connect(c.operator).finalizeResolution(p.poolId));
    expect(await c.pool.claimable(p.poolId, c.investor.address)).to.equal(1_000_000n);
    expect(await c.registry.pledgedTo(p.eblId)).to.equal(ethers.ZeroAddress);
  });
  it('completes zero and full liquidation recoveries without duplicate claims', async () => {
    const c = await deployRights();
    for (const recovery of [0n, 10_000_000n]) {
      const p = await c.create(); await c.eligible(p); await send(c.pool.connect(c.investor).subscribe(p.poolId, 10));
      await send(c.controller.connect(c.operator).disburse(p.poolId, 8_000_000n, uniqueHash()));
      await c.govern(c.controller, 'applyPricingAction', [p.poolId, 0, ACTION.TRIGGER_LIQUIDATION, uniqueHash(), uniqueHash()]);
      if (recovery) {
        await send(c.usdc.mint(c.holder.address, recovery)); await send(c.usdc.connect(c.holder).approve(await c.pool.getAddress(), recovery));
        await send(c.pool.connect(c.holder).repay(p.poolId, recovery));
        await c.lifecycle(c.attestor, 'recordLiquidationRecovery', [p.poolId, uniqueHash(), recovery]);
      }
      await send(c.controller.connect(c.disposer).notifyResolution(p.poolId, uniqueHash(), uniqueHash(), recovery));
      await send(c.controller.connect(c.reviewer).reviewResolution(p.poolId, uniqueHash())); await c.advance((await c.controller.resolutions(p.poolId)).noticeUntil);
      await send(c.controller.connect(c.operator).finalizeResolution(p.poolId));
      expect(await c.pool.stateOf(p.poolId)).to.equal(recovery ? STATE.Repaid : STATE.LossSettled);
      await send(c.pool.connect(c.investor).claim(p.poolId));
      expect(await c.token.totalSupply(p.poolId)).to.equal(0n); expect(await c.pool.totalClaimed(p.poolId)).to.equal(recovery);
      await expect(c.pool.connect(c.investor).claim(p.poolId)).to.be.revertedWithCustomError(c.pool, 'NoShares');
    }
  });
  it('supports per-title source invalidation while retaining the reservation and acquired refund rights', async () => {
    const c = await deployRights(), p = await c.create(); await c.eligible(p);
    await send(c.pool.connect(c.investor).subscribe(p.poolId, 1));
    await expect(c.registry.connect(c.outsider).invalidateTitle(p.eblId, uniqueHash())).to.be.revertedWith('not issuer or already invalidated');
    await send(c.registry.connect(c.issuer).invalidateTitle(p.eblId, uniqueHash()));
    expect(await c.registry.isActive(p.eblId)).to.equal(false);
    await expect(c.pool.connect(c.investor).subscribe(p.poolId, 1)).to.be.revertedWithCustomError(c.pool, 'NotEligible');
    await c.advance(p.terms.subscribeUntil + 1n);
    await send(c.pool.refundInvestor(p.poolId, c.investor.address));
    expect(await c.token.totalSupply(p.poolId)).to.equal(0n);
    expect(await c.hub.reservedBy(p.issuance.assetKey)).to.equal(await c.registry.getAddress());
  });
  it('revokes screening-source trust even when another compliance subject keeps a current credential', async () => {
    const c = await deployRights(), p = await c.create(); await c.eligible(p);
    await c.govern(c.controller, 'setRole', [await c.controller.COMPLIANCE(), c.outsider.address, true]);
    await send(c.controller.connect(c.outsider).setEligibility(c.investor.address, uniqueHash(), uniqueHash(), (await c.now()) + 200000n));
    await c.govern(c.controller, 'setRole', [await c.controller.COMPLIANCE(), c.compliance.address, false]);
    await expect(c.pool.connect(c.investor).subscribe(p.poolId, 1)).to.be.revertedWithCustomError(c.pool, 'NotEligible');
    await send(c.controller.connect(c.outsider).refreshScreening((await c.now()) + 10000n, uniqueHash()));
    await send(c.pool.connect(c.investor).subscribe(p.poolId, 1));
  });
});
