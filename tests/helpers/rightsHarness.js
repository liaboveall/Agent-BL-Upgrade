import fs from 'node:fs/promises';
import path from 'node:path';
import { ContractFactory, JsonRpcProvider, id } from 'ethers';
import { RightsChainService } from '../../src/rights/chain.js';
import { createDisclosure } from '../../src/rights/disclosure.js';
import { CONTROL_VERSION, ISSUANCE_TYPES, TERMS_TYPES, VALUATION_TYPES, rightsDomain, titleDomain, hashOfferingTerms } from '../../src/rights/typedData.js';

export async function deployRightsRpc(node, t) {
  const provider = new JsonRpcProvider(node.url, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
  const signers = await Promise.all(Array.from({ length: 14 }, (_, index) => provider.getSigner(index)));
  const [memberA, memberB, memberC, issuer, holder, valuer, operator, attestor, compliance, disposer, reviewer, guardian, investor, outsider] = signers;
  let serial = 0;
  const fresh = (text = 'w3') => id(`${text}:${serial++}`), send = async (transaction) => (await transaction).wait();
  const artifact = async (name) => JSON.parse(await fs.readFile(path.resolve('hardhat/artifacts/contracts', `${name}.sol`, `${name}.json`), 'utf8'));
  const deploy = async (name, args = []) => { const a = await artifact(name); return (await new ContractFactory(a.abi, a.bytecode, memberA).deploy(...args)).waitForDeployment(); };
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
  const now = async () => BigInt((await provider.getBlock('latest')).timestamp);
  const advance = async (time) => { await provider.send('evm_setNextBlockTimestamp', [Number(time)]); await provider.send('evm_mine', []); };
  // `through` is the governance that owns the target (an instance's own, or the shared hub's).
  const govern = async (contract, method, args, through = governance) => {
    const data = contract.interface.encodeFunctionData(method, args), receipt = await send(through.connect(memberA).propose(await contract.getAddress(), data, fresh()));
    const event = receipt.logs.map((log) => { try { return through.interface.parseLog(log); } catch { return null; } }).find((event) => event?.name === 'Proposed');
    await send(through.connect(memberB).approve(event.args.id)); await advance((await through.operations(event.args.id)).eta);
    await send(through.connect(memberA).execute(event.args.id, data));
  };
  await govern(hub, 'setRegistry', [await registry.getAddress(), true]);
  await govern(registry, 'bindController', [await controller.getAddress()]);
  const organization = fresh('carrier'); await govern(registry, 'setIssuer', [organization, issuer.address]);
  for (const [role, signer] of Object.entries({ ISSUER: issuer, VALUER: valuer, OPERATOR: operator, ATTESTOR: attestor, COMPLIANCE: compliance, DISPOSER: disposer, REVIEWER: reviewer, GUARDIAN: guardian })) await govern(controller, 'setRole', [await controller[role](), signer.address, true]);
  await govern(controller, 'setTestAsset', [await usdc.getAddress(), true]); await govern(controller, 'setIntakeStopped', [false, fresh()]);
  const chainId = (await provider.getNetwork()).chainId, domain = rightsDomain(chainId, await controller.getAddress()), title = titleDomain(chainId, await registry.getAddress());
  const chain = new RightsChainService({ provider, controller, registry, pool, token, governance, chainId });
  const issuance = async (documentHash = fresh()) => {
    const value = { assetKey: fresh('asset'), documentHash, issuerOrg: organization, holder: holder.address, revision: '1', previousHash: `0x${'00'.repeat(32)}`, validUntil: String((await now()) + 100000n), nonce: String(serial++) };
    return { issuance: value, signature: await issuer.signTypedData(title, ISSUANCE_TYPES, value) };
  };
  const offering = async (eblId, value) => {
    const time = await now(), terms = { eblId: String(eblId), assetKey: value.assetKey, documentHash: value.documentHash,
      settlementAsset: await usdc.getAddress(), exporter: holder.address, feeRecipient: memberC.address, supply: '10', issuePrice: '800000', target: '1000000', minRaise: '8000000',
      maturity: String(time + 200000n), subscribeUntil: String(time + 80000n), disburseUntil: String(time + 90000n), maxFee: '0', policyHash: fresh('disposal-policy'), disclosureHash: fresh('disclosure'), nonce: String(serial++) };
    const { policyHash: _policy, disclosureHash: _disclosure, ...rawTerms } = terms;
    const pack = createDisclosure({ revision: 1, instance: { chain_id: Number(chainId), controller: await controller.getAddress(), pool: await pool.getAddress(), control_version: CONTROL_VERSION }, terms: rawTerms,
      parties: { issuer: issuer.address, holder: holder.address, operator: operator.address, valuer: valuer.address, compliance: compliance.address, disposer: disposer.address, reviewer: reviewer.address, governance: await governance.getAddress() },
      sources: ['invoice', 'cost', 'collateral', 'risk'].map((field) => ({ field, status: 'fixture', reference: 'synthetic research fixture; not real cargo' })) });
    Object.assign(terms, pack.terms);
    const hash = hashOfferingTerms(chainId, await controller.getAddress(), terms);
    const valuation = { termsHash: hash, assetKey: value.assetKey, settlementAsset: terms.settlementAsset, netValue: '20000000', coverageBps: 15000,
      valuedAt: String(time), validUntil: String(time + 100000n), nonce: String(serial++) };
    return { terms, valuation, valuer: valuer.address, signature: await valuer.signTypedData(domain, VALUATION_TYPES, valuation), hash, pack };
  };
  const lifecycle = async (method, args) => send(controller.connect(['recordImporterPayment', 'recordCargoArrival'].includes(method) ? attestor : operator).executeLifecycle(pool.interface.encodeFunctionData(method, args)));
  t.after(() => provider.destroy());
  return { provider, memberA, memberB, memberC, issuer, holder, valuer, operator, attestor, compliance, disposer, reviewer, guardian, investor, outsider,
    governance, registry, hub, controller, pool, token, usdc, chain, chainId, now, advance, govern, fresh, send, issuance, offering, lifecycle, domain, title, TERMS_TYPES };
}
