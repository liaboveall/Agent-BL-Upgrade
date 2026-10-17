// Regression tests for the protocol-hardening review: each case pins the *fixed*
// behaviour of a defect that was reproduced against the original contracts.
import { expect } from 'chai';
import { anyValue } from '@nomicfoundation/hardhat-ethers-chai-matchers/withArgs';
import {
  ACTION, ISSUE_PRICE, STATE, TARGET,
  applyPricing, deployProtocol, ethers, newOffering, send, settleOffering, uniqueHash
} from './helpers/protocol.js';

describe('RWAOfferingPool hardening', () => {
  describe('collateral: one eBL backs one live offering', () => {
    it('refuses a second offering on an eBL that already backs a live one', async () => {
      const ctx = await deployProtocol();
      const { eblId, poolId } = await newOffering(ctx, 'dup');
      expect(await ctx.pool.poolOfEbl(eblId)).to.equal(poolId);
      await expect(ctx.pool.createOffering(eblId, 100n, ISSUE_PRICE, TARGET)).to.be.revertedWith('ebl already offered');
      expect(await ctx.pool.nextPoolId()).to.equal(poolId + 1n);
    });

    it('frees the eBL when an unsubscribed offering is cancelled, so it can be offered again', async () => {
      const ctx = await deployProtocol();
      const { eblId, poolId } = await newOffering(ctx, 'cancel');
      const reason = ethers.id('exporter withdrew');
      await expect(ctx.pool.cancelOffering(poolId, reason))
        .to.emit(ctx.pool, 'OfferingCancelled').withArgs(poolId, reason)
        .and.to.emit(ctx.pool, 'CollateralReleased').withArgs(poolId, eblId);
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Cancelled);
      expect(await ctx.pool.poolOfEbl(eblId)).to.equal(0n);
      expect(await ctx.registry.pledgedTo(eblId)).to.equal(ethers.ZeroAddress);

      // The eBL is a normal asset again: re-pledge it and open a fresh offering.
      await send(ctx.registry.pledge(eblId, await ctx.pool.getAddress()));
      await send(ctx.pool.createOffering(eblId, 100n, ISSUE_PRICE, TARGET));
      expect(await ctx.pool.poolOfEbl(eblId)).to.equal(poolId + 1n);
    });

    it('releases the pledge when an offering is repaid, so the eBL can move again', async () => {
      const ctx = await deployProtocol();
      const { eblId, poolId } = await newOffering(ctx, 'repaid', { supply: 10n });
      await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 10n));
      await send(ctx.pool.connect(ctx.agent).markInTransit(poolId, ethers.id('departure')));
      await send(ctx.pool.connect(ctx.agent).recordImporterPayment(poolId, ethers.id('p'), 10_000_000n));
      await send(ctx.pool.connect(ctx.agent).recordCargoArrival(poolId, ethers.id('a')));
      await expect(ctx.pool.connect(ctx.agent).settle(poolId, 10_000_000n))
        .to.emit(ctx.pool, 'OfferingSettled')
        .and.to.emit(ctx.pool, 'CollateralReleased').withArgs(poolId, eblId)
        .and.to.emit(ctx.registry, 'EBLPledgeReleased');
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Repaid);
      expect(await ctx.registry.pledgedTo(eblId)).to.equal(ethers.ZeroAddress);
      expect(await ctx.pool.poolOfEbl(eblId)).to.equal(0n);
      await send(ctx.registry.transfer(eblId, ctx.other.address));
      expect(await ctx.registry.holderOf(eblId)).to.equal(ctx.other.address);
    });

    it('prevents owner bypass of the pledge before settlement', async () => {
      const ctx = await deployProtocol();
      const { eblId, poolId } = await newOffering(ctx, 'released', { supply: 10n });
      await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 2n));
      await expect(ctx.registry.releasePledge(eblId)).to.be.revertedWith('not authorized');
      await expect(settleOffering(ctx, poolId, 2_000_000n))
        .to.emit(ctx.pool, 'CollateralReleased').withArgs(poolId, eblId);
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Repaid);
      expect(await ctx.pool.poolOfEbl(eblId)).to.equal(0n);
    });

    it('stops selling shares once the eBL is no longer pledged to the pool', async () => {
      const ctx = await deployProtocol();
      const { eblId, poolId } = await newOffering(ctx, 'unpledged');
      await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 1n));
      await expect(ctx.registry.releasePledge(eblId)).to.be.revertedWith('not authorized');
      expect(await ctx.registry.pledgedTo(eblId)).to.equal(await ctx.pool.getAddress());
      expect(await ctx.token.totalSupply(poolId)).to.equal(1n);
    });
  });

  describe('pricing bounds', () => {
    it('never lets the oracle price an offering above its target redemption value', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'ceiling');
      await expect(applyPricing(ctx, poolId, TARGET + 1n, ACTION.OPEN_OFFERING)).to.be.revertedWith('price>target');
      await expect(applyPricing(ctx, poolId, 5_000_000n, ACTION.OPEN_WITH_WARNING)).to.be.revertedWith('price>target');
      await send(applyPricing(ctx, poolId, TARGET, ACTION.OPEN_OFFERING)); // exactly the target is fine
      expect(await ctx.pool.issuePriceOf(poolId)).to.equal(TARGET);
    });

    it('REPRICE_DOWN has to lower the price', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'down');
      await expect(applyPricing(ctx, poolId, ISSUE_PRICE + 1n, ACTION.REPRICE_DOWN)).to.be.revertedWith('reprice not down');
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Open);

      // A no-op price update cannot change the lifecycle.
      const sameTx = await applyPricing(ctx, poolId, ISSUE_PRICE, ACTION.REPRICE_DOWN);
      await expect(sameTx).to.not.emit(ctx.pool, 'OfferingStateChanged');
      await expect(sameTx).to.not.emit(ctx.pool, 'OfferingRepriced');
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Open);

      await expect(applyPricing(ctx, poolId, 700_000n, ACTION.REPRICE_DOWN))
        .to.emit(ctx.pool, 'OfferingRepriced').withArgs(poolId, ISSUE_PRICE, 700_000n, anyValue, anyValue);
      expect(await ctx.pool.issuePriceOf(poolId)).to.equal(700_000n);
    });

    it('allows a recovery: an OPEN action may raise a repriced offering again, up to the target', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'recover');
      await send(applyPricing(ctx, poolId, 700_000n, ACTION.REPRICE_DOWN));
      await send(applyPricing(ctx, poolId, 900_000n, ACTION.OPEN_OFFERING));
      expect(await ctx.pool.issuePriceOf(poolId)).to.equal(900_000n);
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Open);
    });

    it('rejects an out-of-range risk level at the oracle and a zero pool', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'risk');
      await expect(applyPricing(ctx, poolId, ISSUE_PRICE, ACTION.OPEN_OFFERING, 4)).to.be.revertedWith('riskLevel>3');
      await send(applyPricing(ctx, poolId, ISSUE_PRICE, ACTION.OPEN_OFFERING, 3));
      const Oracle = await ethers.getContractFactory('RiskPricingOracle');
      await expect(Oracle.deploy(ethers.ZeroAddress)).to.be.revertedWith('pool=0');
    });
  });

  describe('settlement', () => {
    it('refuses proofs and settlement for an offering nobody subscribed to', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'empty');
      const agent = ctx.pool.connect(ctx.agent);
      await expect(agent.recordImporterPayment(poolId, ethers.id('p'), 100n)).to.be.revertedWith('no subscribers');
      await expect(agent.recordCargoArrival(poolId, ethers.id('a'))).to.be.revertedWith('no subscribers');
      await expect(agent.settle(poolId, 100n)).to.be.revertedWith('no subscribers');
      await expect(ctx.pool.correctImporterPayment(poolId, ethers.id('p'), 100n)).to.be.revertedWith('no subscribers');
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Open);
    });

    it('lets only the owner correct a mistaken importer payment, and keeps the audit trail', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'typo', { supply: 10n });
      await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 10n));
      const agent = ctx.pool.connect(ctx.agent);
      const wrong = ethers.id('WRONG');
      const right = ethers.id('right');
      await send(agent.recordImporterPayment(poolId, wrong, 1n)); // typo'd amount
      await expect(agent.recordImporterPayment(poolId, right, 10_000_000n)).to.be.revertedWith('payment already recorded');
      await send(agent.recordCargoArrival(poolId, ethers.id('arrival')));
      await expect(agent.settle(poolId, 10_000_000n)).to.be.revertedWith('repayment mismatch');

      // An autonomous executor must not rewrite its own proofs.
      await expect(agent.correctImporterPayment(poolId, right, 10_000_000n)).to.be.revertedWith('not owner');
      await expect(ctx.pool.connect(ctx.outsider).correctImporterPayment(poolId, right, 10_000_000n)).to.be.revertedWith('not owner');

      await expect(ctx.pool.correctImporterPayment(poolId, right, 10_000_000n))
        .to.emit(ctx.pool, 'ImporterPaymentCorrected').withArgs(poolId, wrong, right, 1n, 10_000_000n)
        .and.to.emit(ctx.pool, 'SettlementProofRecorded').withArgs(poolId, right, ethers.id('arrival'));
      const [paymentProof] = await ctx.pool.settlementProofs(poolId);
      expect(paymentProof).to.equal(right);

      await send(agent.settle(poolId, 10_000_000n));
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Repaid);
      await expect(ctx.pool.correctImporterPayment(poolId, wrong, 1n)).to.be.revertedWith('bad settlement state');
    });

    it('validates a correction', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'correct-args');
      await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 1n));
      await expect(ctx.pool.correctImporterPayment(poolId, ethers.id('p'), 5n)).to.be.revertedWith('payment not recorded');
      await send(ctx.pool.connect(ctx.agent).recordImporterPayment(poolId, ethers.id('p'), 5n));
      await expect(ctx.pool.correctImporterPayment(poolId, ethers.ZeroHash, 5n)).to.be.revertedWith('paymentProof=0');
      await expect(ctx.pool.correctImporterPayment(poolId, ethers.id('q'), 0n)).to.be.revertedWith('repayment=0');
      await send(ctx.pool.setEmergencyStop(true, ethers.id('incident')));
      await expect(ctx.pool.correctImporterPayment(poolId, ethers.id('q'), 6n)).to.be.revertedWith('emergency stopped');
    });

    it('records the departure proof and the oracle / token wiring in the event log', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'events', { supply: 5n });
      await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 5n));
      const departure = ethers.id('bill of lading signed on board');
      await expect(ctx.pool.connect(ctx.agent).markInTransit(poolId, departure))
        .to.emit(ctx.pool, 'DepartureRecorded').withArgs(poolId, departure);
      await expect(ctx.pool.setOracle(ctx.other.address)).to.emit(ctx.pool, 'OracleSet').withArgs(ctx.other.address);
      await expect(ctx.token.setPool(ctx.other.address)).to.emit(ctx.token, 'PoolSet').withArgs(ctx.other.address);
    });
  });

  describe('cancelOffering', () => {
    it('is owner-only and needs an existing offering', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'owner-only');
      await expect(ctx.pool.connect(ctx.agent).cancelOffering(poolId, ethers.id('x'))).to.be.revertedWith('not owner');
      await expect(ctx.pool.cancelOffering(99n, ethers.id('x'))).to.be.revertedWith('pool missing');
    });

    it('cannot cancel an offering that already has subscribers', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'has-subscribers');
      await send(ctx.pool.connect(ctx.investor).subscribe(poolId, 1n));
      await expect(ctx.pool.cancelOffering(poolId, ethers.id('x'))).to.be.revertedWith('has subscribers');
    });

    it('works from Open, Repriced and Paused, also during a global emergency stop', async () => {
      const ctx = await deployProtocol();
      const open = await newOffering(ctx, 'c-open');
      await send(ctx.pool.cancelOffering(open.poolId, ethers.id('open')));
      expect(await ctx.pool.stateOf(open.poolId)).to.equal(STATE.Cancelled);

      const repriced = await newOffering(ctx, 'c-repriced');
      await send(applyPricing(ctx, repriced.poolId, 700_000n, ACTION.REPRICE_DOWN));
      expect(await ctx.pool.stateOf(repriced.poolId)).to.equal(STATE.Open);
      await send(ctx.pool.cancelOffering(repriced.poolId, ethers.id('repriced')));
      expect(await ctx.pool.stateOf(repriced.poolId)).to.equal(STATE.Cancelled);

      const paused = await newOffering(ctx, 'c-paused');
      await send(ctx.pool.connect(ctx.agent).pauseOffering(paused.poolId, ethers.id('pause')));
      await send(ctx.pool.setEmergencyStop(true, ethers.id('incident')));
      await send(ctx.pool.cancelOffering(paused.poolId, ethers.id('paused')));
      expect(await ctx.pool.stateOf(paused.poolId)).to.equal(STATE.Cancelled);
    });

    it('rejects a second cancel and any state that is not cancellable', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'twice');
      await send(ctx.pool.cancelOffering(poolId, ethers.id('first')));
      await expect(ctx.pool.cancelOffering(poolId, ethers.id('again'))).to.be.revertedWith('illegal transition');

      // A frozen offering without investors can still exit through cancellation (A02).
      const frozen = await newOffering(ctx, 'frozen');
      await send(applyPricing(ctx, frozen.poolId, ISSUE_PRICE, ACTION.FREEZE_POOL));
      await send(ctx.pool.cancelOffering(frozen.poolId, ethers.id('x')));
      expect(await ctx.pool.stateOf(frozen.poolId)).to.equal(STATE.Cancelled);

      // Once investors exist, cancellation is not an exit; debt/frozen rules apply instead.
      const funded = await newOffering(ctx, 'frozen-funded');
      await send(ctx.pool.connect(ctx.investor).subscribe(funded.poolId, 1n));
      await send(applyPricing(ctx, funded.poolId, ISSUE_PRICE, ACTION.FREEZE_POOL));
      await expect(ctx.pool.cancelOffering(funded.poolId, ethers.id('y'))).to.be.revertedWith('has subscribers');
    });
  });

  describe('documented limitation', () => {
    it('subscribe records an amount owed but holds no funds (no payment leg yet)', async () => {
      const ctx = await deployProtocol();
      const { poolId } = await newOffering(ctx, 'no-payment-leg', { supply: 1_000n });
      expect(ctx.pool.interface.getFunction('subscribe').payable).to.equal(false);
      let acceptedValue = true;
      try {
        await ctx.pool.connect(ctx.outsider).subscribe(poolId, 1_000n, { value: 1n });
      } catch {
        acceptedValue = false;
      }
      expect(acceptedValue, 'subscribe must refuse ether').to.equal(false);
      await expect(ctx.pool.connect(ctx.outsider).subscribe(poolId, 1_000n))
        .to.emit(ctx.pool, 'Subscribed').withArgs(poolId, ctx.outsider.address, 1_000n, 1_000n * ISSUE_PRICE);
      expect(await ethers.provider.getBalance(await ctx.pool.getAddress())).to.equal(0n);
      expect(await ctx.pool.stateOf(poolId)).to.equal(STATE.Funded);
    });
  });
});

describe('EBLRegistry hardening', () => {
  it('registers a legacy document only once, whoever holds it', async () => {
    const ctx = await deployProtocol();
    const metadataHash = ethers.id('one-physical-bill-of-lading');
    await send(ctx.registry.mintEBL(metadataHash, ctx.investor.address));
    await expect(ctx.registry.mintEBL(metadataHash, ctx.investor.address)).to.be.revertedWith('cargo already registered');
    await expect(ctx.registry.mintEBL(metadataHash, ctx.outsider.address)).to.be.revertedWith('cargo already registered');
    await send(ctx.registry.mintEBL(ethers.id('another-bill-of-lading'), ctx.investor.address));
    expect(await ctx.registry.nextEblId()).to.equal(3n);
  });

  it('only the owner can register eBLs, and a V2 cargo hash can never be registered twice', async () => {
    const ctx = await deployProtocol();
    const metadata = {
      vessel: 'MV Test', voyage: 'T-1', portOfLoading: 'SG', portOfDischarge: 'SH', cargo: 'Copper', quantity: 1n,
      quantityUnit: 'MT', hsCode: '740311', declaredValueUsdE6: 1n, incoterms: 'CIF', mletr: true, eucp: true, dcsa: true
    };
    const cargoHash = ethers.id('cargo-once');
    await expect(ctx.registry.connect(ctx.outsider).mintEBLV2(cargoHash, ethers.id('m'), ctx.outsider.address, metadata))
      .to.be.revertedWith('not owner');
    await expect(ctx.registry.connect(ctx.outsider).mintEBL(ethers.id('m'), ctx.outsider.address)).to.be.revertedWith('not owner');
    await send(ctx.registry.mintEBLV2(cargoHash, ethers.id('m1'), ctx.investor.address, metadata));
    await expect(ctx.registry.mintEBLV2(cargoHash, ethers.id('m2'), ctx.outsider.address, metadata))
      .to.be.revertedWith('cargo already registered');
    expect(await ctx.registry.eblIdForCargo(cargoHash)).to.equal(1n);
  });

  it('only the holder can transfer or endorse, never while pledged, and never to a bad recipient', async () => {
    const ctx = await deployProtocol();
    await send(ctx.registry.mintEBL(ethers.id('transfer-rules'), ctx.investor.address));
    const registry = (signer) => ctx.registry.connect(signer);

    // A non-holder (even the registry owner) cannot move or endorse someone else's eBL.
    await expect(registry(ctx.outsider).transfer(1n, ctx.outsider.address)).to.be.revertedWith('not holder');
    await expect(registry(ctx.owner).transfer(1n, ctx.owner.address)).to.be.revertedWith('not holder');
    await expect(registry(ctx.outsider).endorse(1n, ctx.outsider.address, ethers.id('forged'))).to.be.revertedWith('not holder');

    // The holder still has to name a real, different recipient and a real endorsement.
    await expect(registry(ctx.investor).transfer(1n, ethers.ZeroAddress)).to.be.revertedWith('to=0');
    await expect(registry(ctx.investor).transfer(1n, ctx.investor.address)).to.be.revertedWith('same holder');
    await expect(registry(ctx.investor).endorse(1n, ctx.other.address, ethers.ZeroHash)).to.be.revertedWith('endorsementHash=0');
    await expect(registry(ctx.investor).transfer(99n, ctx.other.address)).to.be.revertedWith('ebl missing');

    // Pledging is restricted to the holder / owner, can only happen once, and locks transfers.
    await expect(registry(ctx.outsider).pledge(1n, await ctx.pool.getAddress())).to.be.revertedWith('not authorized');
    await send(registry(ctx.investor).pledge(1n, await ctx.pool.getAddress()));
    await expect(registry(ctx.investor).pledge(1n, await ctx.pool.getAddress())).to.be.revertedWith('already pledged');
    await expect(registry(ctx.investor).transfer(1n, ctx.other.address)).to.be.revertedWith('ebl pledged');
    await expect(registry(ctx.investor).endorse(1n, ctx.other.address, ethers.id('e'))).to.be.revertedWith('ebl pledged');
    await expect(registry(ctx.outsider).releasePledge(1n)).to.be.revertedWith('not authorized');

    // Once released, the holder moves it and the history records who endorsed what.
    await expect(ctx.registry.releasePledge(1n)).to.be.revertedWith('not authorized');
    // An offering with no investors can cancel and let the pledgee release the eBL.
    await send(ctx.pool.createOffering(1n, 1n, ISSUE_PRICE, TARGET));
    await send(ctx.pool.cancelOffering(1n, ethers.id('withdraw-unfunded')));
    const endorsement = ethers.id('endorsement-1');
    await expect(registry(ctx.investor).endorse(1n, ctx.other.address, endorsement))
      .to.emit(ctx.registry, 'EBLEndorsed').withArgs(1n, ctx.investor.address, ctx.other.address, endorsement);
    expect(await ctx.registry.holderOf(1n)).to.equal(ctx.other.address);
  });
});

describe('PaymentOracle ownership', () => {
  async function deployOracle() {
    const [owner, next, outsider] = await ethers.getSigners();
    const oracle = await (await ethers.getContractFactory('PaymentOracle')).deploy();
    await oracle.waitForDeployment();
    return { oracle, owner, next, outsider };
  }

  const attest = (oracle, id) => oracle.attestPayment(
    ethers.id(`receipt:${id}`), ethers.id(`report:${id}`), ethers.id(`case:${id}`), ethers.id(`tx:${id}`),
    ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, 1n
  );

  it('hands the contract over in two steps and moves the attestor role with it', async () => {
    const { oracle, owner, next, outsider } = await deployOracle();
    await expect(oracle.connect(outsider).transferOwnership(next.address)).to.be.revertedWithCustomError(oracle, 'NotOwner');
    await expect(oracle.transferOwnership(ethers.ZeroAddress)).to.be.revertedWithCustomError(oracle, 'ZeroAddress');

    await expect(oracle.transferOwnership(next.address))
      .to.emit(oracle, 'OwnershipTransferStarted').withArgs(owner.address, next.address);
    // Nothing changes until the nominee accepts.
    expect(await oracle.owner()).to.equal(owner.address);
    expect(await oracle.pendingOwner()).to.equal(next.address);
    await expect(oracle.connect(outsider).acceptOwnership()).to.be.revertedWithCustomError(oracle, 'NotPendingOwner');

    await expect(oracle.connect(next).acceptOwnership())
      .to.emit(oracle, 'OwnershipTransferred').withArgs(owner.address, next.address)
      .and.to.emit(oracle, 'AttestorUpdated').withArgs(owner.address, false)
      .and.to.emit(oracle, 'AttestorUpdated').withArgs(next.address, true);
    expect(await oracle.owner()).to.equal(next.address);
    expect(await oracle.pendingOwner()).to.equal(ethers.ZeroAddress);
    expect(await oracle.isAttestor(owner.address)).to.equal(false);
    expect(await oracle.isAttestor(next.address)).to.equal(true);

    // The previous owner can no longer write to the audit trail; the new owner can.
    await expect(attest(oracle, 'old')).to.be.revertedWithCustomError(oracle, 'UnauthorizedAttestor');
    await send(attest(oracle.connect(next), 'new'));
    expect(await oracle.attestationCount()).to.equal(1n);
    await expect(oracle.transferOwnership(owner.address)).to.be.revertedWithCustomError(oracle, 'NotOwner');
  });

  it('keeps an explicitly authorised attestor across an ownership transfer', async () => {
    const { oracle, next, outsider } = await deployOracle();
    await send(oracle.setAttestor(outsider.address, true));
    await send(oracle.transferOwnership(next.address));
    await send(oracle.connect(next).acceptOwnership());
    expect(await oracle.isAttestor(outsider.address)).to.equal(true);
  });
});

describe('two-step ownership of the protocol contracts', () => {
  const contracts = ['registry', 'token', 'pool', 'oracle', 'gate'];

  for (const key of contracts) {
    it(`${key}: a transfer completes only when the nominee accepts`, async () => {
      const ctx = await deployProtocol();
      const contract = ctx[key];
      await expect(contract.connect(ctx.outsider).transferOwnership(ctx.other.address)).to.be.revertedWith('not owner');
      await expect(contract.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith('owner=0');
      await expect(contract.transferOwnership(ctx.other.address))
        .to.emit(contract, 'OwnershipTransferStarted').withArgs(ctx.owner.address, ctx.other.address);
      expect(await contract.owner()).to.equal(ctx.owner.address);
      expect(await contract.pendingOwner()).to.equal(ctx.other.address);
      await expect(contract.connect(ctx.outsider).acceptOwnership()).to.be.revertedWith('not pending owner');

      await expect(contract.connect(ctx.other).acceptOwnership())
        .to.emit(contract, 'OwnershipTransferred').withArgs(ctx.owner.address, ctx.other.address);
      expect(await contract.owner()).to.equal(ctx.other.address);
      expect(await contract.pendingOwner()).to.equal(ethers.ZeroAddress);
      await expect(contract.transferOwnership(ctx.owner.address)).to.be.revertedWith('not owner'); // lost control
      await send(contract.connect(ctx.other).transferOwnership(ctx.owner.address)); // new owner is in charge
    });
  }

  it('a nomination can be replaced before it is accepted', async () => {
    const ctx = await deployProtocol();
    await send(ctx.pool.transferOwnership(ctx.other.address));
    await send(ctx.pool.transferOwnership(ctx.third.address));
    await expect(ctx.pool.connect(ctx.other).acceptOwnership()).to.be.revertedWith('not pending owner');
    await send(ctx.pool.connect(ctx.third).acceptOwnership());
    expect(await ctx.pool.owner()).to.equal(ctx.third.address);
  });

  it('the new pool owner takes over the administrative powers', async () => {
    const ctx = await deployProtocol();
    const { poolId } = await newOffering(ctx, 'handover');
    await send(ctx.pool.transferOwnership(ctx.other.address));
    await send(ctx.pool.connect(ctx.other).acceptOwnership());
    await expect(ctx.pool.setOracle(ctx.owner.address)).to.be.revertedWith('not owner');
    await expect(ctx.pool.connect(ctx.other).cancelOffering(poolId, uniqueHash('handover')))
      .to.emit(ctx.pool, 'OfferingCancelled');
  });

  it('the oracle updater role moves with ownership, like the deployer role it started as', async () => {
    const ctx = await deployProtocol();
    expect(await ctx.oracle.isUpdater(ctx.owner.address)).to.equal(true);
    await send(ctx.oracle.setUpdater(ctx.agent.address, true)); // an explicitly authorised bot stays
    await send(ctx.oracle.transferOwnership(ctx.other.address));
    await send(ctx.oracle.connect(ctx.other).acceptOwnership());
    expect(await ctx.oracle.isUpdater(ctx.owner.address)).to.equal(false);
    expect(await ctx.oracle.isUpdater(ctx.other.address)).to.equal(true);
    expect(await ctx.oracle.isUpdater(ctx.agent.address)).to.equal(true);
  });
});

describe('AgentBLRWA hardening', () => {
  const evidence = ethers.id('evidence');
  const quote = ethers.id('quote');

  async function deployWithOffering() {
    const [creator, attacker] = await ethers.getSigners();
    const rwa = await (await ethers.getContractFactory('AgentBLRWA')).deploy();
    await rwa.waitForDeployment();
    await send(rwa.connect(creator).tokenize('EBL-1', 800_000n, 1_000n, 500n, 1_000_000n, 350, 1, quote, evidence));
    return { rwa, creator, attacker };
  }

  it('only the wallet that tokenized an offering can reprice it', async () => {
    const { rwa, creator, attacker } = await deployWithOffering();
    await expect(rwa.connect(attacker).reprice(1, 1n, 4, 9_999, 3, ethers.id('forged'), 'forged by attacker'))
      .to.be.revertedWith('not creator');
    const untouched = await rwa.offerings(1);
    expect(untouched.issuePriceE6).to.equal(800_000n);
    expect(untouched.riskLevel).to.equal(1n);
    expect(untouched.evidenceHash).to.equal(evidence);

    await expect(rwa.connect(creator).reprice(1, 790_000n, 2, 1_410, 3, ethers.id('hormuz'), 'Hormuz'))
      .to.emit(rwa, 'Repriced');
    expect((await rwa.offerings(1)).issuePriceE6).to.equal(790_000n);
  });

  it('rejects out-of-range actions, risk levels and scores when repricing', async () => {
    const { rwa, creator } = await deployWithOffering();
    const reprice = (action, score, level) => rwa.connect(creator).reprice(1, 700_000n, action, score, level, evidence, 'x');
    await expect(reprice(6, 100, 1)).to.be.revertedWith('bad action');
    await expect(reprice(255, 100, 1)).to.be.revertedWith('bad action');
    await expect(reprice(2, 100, 4)).to.be.revertedWith('riskLevel>3');
    await expect(reprice(2, 10_001, 1)).to.be.revertedWith('riskScore>100%');
    await send(reprice(5, 10_000, 3)); // the inclusive upper bounds are accepted
  });

  it('rejects out-of-range risk inputs when tokenizing', async () => {
    const [creator] = await ethers.getSigners();
    const rwa = await (await ethers.getContractFactory('AgentBLRWA')).deploy();
    await rwa.waitForDeployment();
    await expect(rwa.connect(creator).tokenize('EBL-X', 800_000n, 1_000n, 500n, 1n, 350, 4, quote, evidence))
      .to.be.revertedWith('riskLevel>3');
    await expect(rwa.connect(creator).tokenize('EBL-X', 800_000n, 1_000n, 500n, 1n, 10_001, 1, quote, evidence))
      .to.be.revertedWith('riskScore>100%');
  });
});
