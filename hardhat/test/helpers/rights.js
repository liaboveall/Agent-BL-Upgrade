import { ethers, send, uniqueHash, STATE, ACTION } from './protocol.js';
import { ISSUANCE_TYPES, PLEDGE_TYPES, TERMS_TYPES, VALUATION_TYPES, rightsDomain, titleDomain } from '../../../src/rights/typedData.js';

export { ethers, send, uniqueHash, STATE, ACTION, ISSUANCE_TYPES, PLEDGE_TYPES, TERMS_TYPES, VALUATION_TYPES, rightsDomain, titleDomain };
export async function deployRights() {
  const [memberA, memberB, memberC, issuer, holder, valuer, operator, attestor, compliance, disposer, reviewer, guardian, investor, outsider] = await ethers.getSigners();
  const deploy = async (name, args = []) => (await (await ethers.getContractFactory(name)).deploy(...args)).waitForDeployment();
  const governance = await deploy('RightsGovernance', [[memberA.address, memberB.address, memberC.address], 3600]);
  const hub = await deploy('AssetIdentityHub', [await governance.getAddress()]);
  const registry = await deploy('CommittedEBLRegistry', [await governance.getAddress(), await hub.getAddress()]);
  const token = await deploy('ControlledRWAToken');
  const pool = await deploy('RWAOfferingPoolV5', [await registry.getAddress(), await token.getAddress()]);
  await send(token.bindPool(await pool.getAddress()));
  const controller = await deploy('RightsController', [await governance.getAddress(), await registry.getAddress(), await token.getAddress(), await pool.getAddress()]);
  await send(pool.transferOwnership(await controller.getAddress()));
  await send(controller.activate());
  const usdc = await deploy('MockUSDC');
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = rightsDomain(chainId, await controller.getAddress()), title = titleDomain(chainId, await registry.getAddress());
  const advance = async (time) => { await ethers.provider.send('evm_setNextBlockTimestamp', [Number(time)]); await ethers.provider.send('evm_mine', []); };
  const now = async () => BigInt((await ethers.provider.getBlock('latest')).timestamp);
  const queue = async (contract, method, args = []) => {
    const data = contract.interface.encodeFunctionData(method, args), salt = uniqueHash('governance');
    const receipt = await send(governance.connect(memberA).propose(await contract.getAddress(), data, salt));
    const event = receipt.logs.map((log) => { try { return governance.interface.parseLog(log); } catch { return null; } }).find((event) => event?.name === 'Proposed');
    await send(governance.connect(memberB).approve(event.args.id));
    return { id: event.args.id, data, eta: (await governance.operations(event.args.id)).eta };
  };
  const govern = async (contract, method, args = []) => {
    const op = await queue(contract, method, args); await advance(op.eta);
    return send(governance.execute(op.id, op.data));
  };
  await govern(hub, 'setRegistry', [await registry.getAddress(), true]);
  await govern(registry, 'bindController', [await controller.getAddress()]);
  const organization = uniqueHash('issuer-org');
  await govern(registry, 'setIssuer', [organization, issuer.address]);
  for (const [role, signer] of Object.entries({ ISSUER: issuer, VALUER: valuer, OPERATOR: operator, ATTESTOR: attestor, COMPLIANCE: compliance, DISPOSER: disposer, REVIEWER: reviewer, GUARDIAN: guardian })) {
    await govern(controller, 'setRole', [await controller[role](), signer.address, true]);
  }
  await govern(controller, 'setTestAsset', [await usdc.getAddress(), true]);
  await govern(controller, 'setIntakeStopped', [false, uniqueHash('intake')]);
  const register = async (overrides = {}, signatureDomain = title) => {
    const a = { assetKey: uniqueHash('stable-title'), documentHash: uniqueHash('salted-doc'), issuerOrg: organization,
      holder: holder.address, revision: 1, previousHash: ethers.ZeroHash, validUntil: (await now()) + 100_000n, nonce: BigInt(uniqueHash('issue-nonce')), ...overrides };
    const signature = await issuer.signTypedData(signatureDomain, ISSUANCE_TYPES, a);
    await send(registry.registerTitle(a, signature));
    return { issuance: a, signature, eblId: (await registry.nextEblId()) - 1n };
  };
  const prepare = async (overrides = {}, titleRecord) => {
    const record = titleRecord ?? await register();
    const time = await now();
    const terms = { eblId: record.eblId, assetKey: record.issuance.assetKey, documentHash: record.issuance.documentHash,
      settlementAsset: await usdc.getAddress(), exporter: holder.address, feeRecipient: memberC.address, supply: 10n, issuePrice: 800_000n,
      target: 1_000_000n, minRaise: 8_000_000n, maturity: time + 500_000n, subscribeUntil: time + 100_000n,
      disburseUntil: time + 300_000n, maxFee: 0n, policyHash: uniqueHash('policy'), disclosureHash: uniqueHash('disclosure'), nonce: BigInt(uniqueHash('terms-nonce')), ...overrides };
    const hash = ethers.TypedDataEncoder.hash(domain, TERMS_TYPES, terms);
    const pledge = { eblId: record.eblId, pool: await pool.getAddress(), termsHash: hash, nonce: await registry.holderNonce(record.eblId), validUntil: time + 100_000n };
    const pledgeSignature = await holder.signTypedData(title, PLEDGE_TYPES, pledge);
    const valuation = { termsHash: hash, assetKey: terms.assetKey, settlementAsset: terms.settlementAsset, netValue: 20_000_000n,
      coverageBps: 15_000, valuedAt: time, validUntil: time + 200_000n, nonce: BigInt(uniqueHash('valuation-nonce')) };
    const valuationSignature = await valuer.signTypedData(domain, VALUATION_TYPES, valuation);
    return { ...record, terms, hash, pledge, pledgeSignature, valuation, valuationSignature };
  };
  const create = async (overrides = {}) => {
    const p = await prepare(overrides);
    await send(registry.pledge(p.eblId, await pool.getAddress(), p.hash, p.pledge.validUntil, p.pledgeSignature));
    await send(controller.connect(issuer).createControlledOffering(p.terms, p.valuation, valuer.address, p.valuationSignature));
    return { ...p, poolId: await pool.nextPoolId() - 1n };
  };
  const eligible = async (p, wallet = investor) => {
    const time = await now();
    await send(controller.connect(compliance).setEligibility(wallet.address, uniqueHash('subject'), uniqueHash('eligibility'), time + 200_000n));
    await send(controller.connect(compliance).refreshScreening(time + 80_000n, uniqueHash('screening')));
    await send(controller.connect(wallet).acknowledgeTerms(p.poolId, p.hash, await pool.quoteVersion(p.poolId), p.terms.subscribeUntil));
    await send(usdc.mint(wallet.address, 8_000_000n));
    await send(usdc.connect(wallet).approve(await pool.getAddress(), ethers.MaxUint256));
  };
  const lifecycle = (signer, method, args) => send(controller.connect(signer).executeLifecycle(pool.interface.encodeFunctionData(method, args)));
  return { governance, hub, registry, controller, pool, token, usdc, memberA, memberB, memberC, issuer, holder, valuer, operator,
    attestor, compliance, disposer, reviewer, guardian, investor, outsider, organization, domain, title, deploy, now, advance, queue, govern, register, prepare, create, eligible, lifecycle };
}
