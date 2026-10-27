import fs from 'node:fs/promises';
import path from 'node:path';
import { Contract, id, ZeroHash } from 'ethers';
import { RightsService } from '../../src/rights/service.js';
import { loadRightsChain } from '../../src/rights/chain.js';
import { ISSUANCE_TYPES, VALUATION_TYPES, assetIdentity, rightsDomain, titleDomain } from '../../src/rights/typedData.js';
import { writeJsonAtomic } from '../../src/lib/jsonStore.js';
import { releaseSourceSnapshot } from './release-source.mjs';

const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const safe = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));
// All assets and materials are explicitly fictional research fixtures. This is
// operator automation with real testnet wallets, not independent human acceptance.
export async function runCandidateFunding({ directory, candidate, state, save, txSend, provider, signers, rightsKey, poolCount = 25, advance }) {
  ensure(state.active, 'Activate the isolated candidate first');
  const chain = await loadRightsChain(path.join(directory, 'rights-instance.json'));
  const env = { AGENTBL_RIGHTS_KEY: rightsKey, AGENTBL_RUNTIME_DIR: path.join(directory, 'application') };
  const service = new RightsService({ directory: path.join(env.AGENTBL_RUNTIME_DIR, 'rights'), env, chain });
  state.funding ??= { schema: 'agentbl-n5-public-funding-v1', chain_id: state.chain_id, subjects: {}, scenarios: {}, real_business: false, human_verified: false };
  const work = state.funding, sessions = {};
  const source = await releaseSourceSnapshot();
  work.execution_sources ??= [];
  if (!work.execution_sources.some((entry) => entry.base_head === source.base_head && entry.source_sha256 === source.source_sha256)) {
    work.execution_sources.push({ base_head: source.base_head, source_sha256: source.source_sha256, observed_at: new Date().toISOString() }); await save();
  }
  const contract = (name) => new Contract(state.contracts[name], candidate.artifacts[name].abi, provider);
  // Version 2 candidates predate the version field in their disclosures and signing domain.
  const version = candidate.control_version ?? 2;
  const controller = contract('RightsController'), registry = contract('CommittedEBLRegistry'), pool = contract('RWAOfferingPoolV5'), token = contract('ControlledRWAToken'), usdc = contract('MockAuthorizationUSDC');
  const call = (label, target, method, args, actor = 'governorA') => txSend(`funding:${label}`, signers[actor], { to: target.target, data: target.interface.encodeFunctionData(method, args) });
  const now = async () => (await provider.getBlock('latest')).timestamp;
  const balanceDelta = async (sent, actor, amount) => {
    const block = sent.receipt.blockNumber;
    const [before, after] = await Promise.all([usdc.balanceOf(signers[actor].address, { blockTag: block - 1 }), usdc.balanceOf(signers[actor].address, { blockTag: block })]);
    ensure(after - before === BigInt(amount), 'Independent token balance delta differs from the expected transfer');
    return { wallet: signers[actor].address, before_atomic: String(before), after_atomic: String(after), delta_atomic: String(after - before), block_number: block, block_hash: sent.receipt.blockHash, tx_hash: sent.tx_hash };
  };
  const boundary = async (timestamp) => {
    if (advance && await now() < Number(timestamp)) await advance(BigInt(timestamp));
    return await now() >= Number(timestamp);
  };
  try {
    for (const [actor, roles] of [['issuer', ['issuer']], ['reviewer', ['reviewer']], ['governorC', ['reviewer', 'investor']]]) {
      if (!work.subjects[actor]) { work.subjects[actor] = await service.createSubject({ organization: 'N5_FICTIONAL_RESEARCH', wallet: signers[actor].address, roles }); await save(); }
      const challenge = await service.createChallenge(work.subjects[actor].subject_id);
      sessions[actor] = (await service.openSession({ challenge_id: challenge.challenge_id, signature: await signers[actor].signTypedData(challenge.domain, challenge.types, challenge.message) })).token;
    }
    const create = async (tag) => {
      let p = work.scenarios[tag];
      if (!p) {
        const time = await now(), eblId = String(await registry.nextEblId());
        const material = await service.createMaterial(sessions.issuer, { material: { fictional: true, cargo: 'Copper cathodes', origin: 'Singapore', destination: 'Shanghai', case: tag, instance: candidate.instance_id },
          public_summary: { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 1, terms_hash: id(`provisional:${tag}`), risk_flags: ['simulated_title', 'test_asset', 'capital_at_risk'] } });
        const issuance = { assetKey: assetIdentity('AGENTBL N5 SYNTHETIC ISSUER', `${registry.target}:${tag}`), documentHash: material.document_hash,
          issuerOrg: id('AGENTBL_N5_SYNTHETIC_ISSUER'), holder: signers.holder.address, revision: 1, previousHash: ZeroHash, nonce: String(BigInt(id(`issuance:${tag}`))), validUntil: String(time + 604800) };
        const input = { revision: 1, instance: { chain_id: state.chain_id, controller: controller.target, pool: pool.target, ...(version >= 3 ? { control_version: version } : {}) },
          terms: { eblId, assetKey: issuance.assetKey, documentHash: material.document_hash, settlementAsset: usdc.target, exporter: signers.holder.address,
            feeRecipient: signers.governorA.address, supply: '10', issuePrice: '800000', target: '1000000', minRaise: '8000000',
            subscribeUntil: String(time + (tag === 'refund' ? 300 : tag === 'loss' ? 600 : 7200)),
            disburseUntil: String(time + (tag === 'loss' ? 900 : 10800)), maturity: String(time + (tag === 'loss' ? 1200 : 14400)), maxFee: '0', nonce: String(BigInt(id(`terms:${tag}`))) },
          parties: Object.fromEntries(['issuer', 'holder', 'operator', 'valuer', 'compliance', 'disposer', 'reviewer', 'governance'].map((role) => [role, role === 'governance' ? state.contracts.RightsGovernance : signers[role].address])),
          sources: ['invoice', 'cost', 'collateral', 'risk'].map((field) => ({ field, status: 'fixture', reference: 'Fictional N5 research data; no verified real cargo or rights' })) };
        const pack = await service.createFinancingDisclosure(sessions.issuer, material.material_id, input);
        p = safe({ material, issuance, pack, balances_before: { investor: String(await usdc.balanceOf(signers.investor.address)), governorC: String(await usdc.balanceOf(signers.governorC.address)) } });
        work.scenarios[tag] = p; await save();
      }
      const registered = await call(`${tag}:register`, registry, 'registerTitle', [p.issuance, await signers.issuer.signTypedData(titleDomain(state.chain_id, registry.target), ISSUANCE_TYPES, p.issuance)], 'issuer');
      ensure(registered.status === 'CONFIRMED', 'Title registration unconfirmed');
      await call(`${tag}:pledge`, registry, 'pledge', [p.pack.terms.eblId, pool.target, p.pack.terms_hash, p.pack.terms.subscribeUntil, '0x'], 'holder');
      if (!p.published) {
        await service.bindTerms(sessions.issuer, p.material.material_id, p.pack.terms_hash);
        for (const actor of ['reviewer', 'governorC']) await service.reviewMaterial(sessions[actor], p.material.material_id, { document_hash: p.material.document_hash, terms_hash: p.pack.terms_hash });
        await service.publishMaterial(sessions.issuer, p.material.material_id); p.published = true; await save();
      }
      p.valuation ??= { termsHash: p.pack.terms_hash, assetKey: p.pack.terms.assetKey, settlementAsset: usdc.target, netValue: '20000000', coverageBps: 15000,
        valuedAt: String(await now()), validUntil: p.pack.terms.disburseUntil, nonce: String(BigInt(id(`valuation:${tag}`))) }; await save();
      const created = await call(`${tag}:create`, controller, 'createControlledOffering', [p.pack.terms, p.valuation, signers.valuer.address,
        await signers.valuer.signTypedData(rightsDomain(state.chain_id, controller.target, version), VALUATION_TYPES, p.valuation)], 'issuer');
      const event = created.receipt.logs.map((log) => { try { return controller.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'TermsCommitted');
      ensure(event, 'Offering receipt missing'); p.pool_id = String(event.args.poolId); await save();
      ensure((await service.financingDisclosure(p.pack.disclosure_hash)).terms_hash === await controller.termsHash(p.pool_id), 'Readable terms differ from chain');
      return p;
    };
    const subscribe = async (tag, p, actor, shares) => {
      await call(`${tag}:${actor}:eligibility`, controller, 'setEligibility', [signers[actor].address, id(`N5:${actor}`), id('SYNTHETIC_NOT_KYC'), p.pack.terms.disburseUntil], 'compliance');
      await call(`${tag}:screening`, controller, 'refreshScreening', [p.pack.terms.disburseUntil, id('SYNTHETIC_SCREENING_NOT_COMPLIANCE')], 'compliance');
      await call(`${tag}:${actor}:accept`, controller, 'acknowledgeTerms', [p.pool_id, p.pack.terms_hash, 1, p.pack.terms.subscribeUntil], actor);
      const cost = BigInt(shares) * 800000n;
      await call(`${tag}:${actor}:mint`, usdc, 'mint', [signers[actor].address, cost]);
      await call(`${tag}:${actor}:approve`, usdc, 'approve', [pool.target, cost], actor);
      await call(`${tag}:${actor}:subscribe`, pool, 'subscribeWithTerms', [p.pool_id, shares, 800000n, 1, p.pack.terms.subscribeUntil], actor);
    };
    const loss = await create('loss');
    for (const actor of ['investor', 'governorC']) await subscribe('loss', loss, actor, '5');
    await call('loss:disburse', controller, 'disburse', [loss.pool_id, 8000000, id('N5_FICTIONAL_DRAWDOWN')], 'operator');
    await call('loss:approve-recovery', usdc, 'approve', [pool.target, 4000001], 'holder');
    await call('loss:initial-recovery', pool, 'repay', [loss.pool_id, 4000001], 'holder');
    const refund = await create('refund'); await subscribe('refund', refund, 'investor', '3');
    const normal = await create('normal');
    for (const actor of ['investor', 'governorC']) await subscribe('normal', normal, actor, '5');
    await call('normal:disburse', controller, 'disburse', [normal.pool_id, 8000000, id('N5_FICTIONAL_DRAWDOWN')], 'operator');
    await call('normal:mint-compensation', usdc, 'mint', [signers.holder.address, 2000000]);
    await call('normal:approve-repayment', usdc, 'approve', [pool.target, 10000000], 'holder');
    const repayment = await call('normal:repayment', pool, 'repay', [normal.pool_id, 10000000], 'holder');
    await call('normal:record-payment', controller, 'executeLifecycle', [pool.interface.encodeFunctionData('recordImporterPayment', [normal.pool_id, repayment.tx_hash, 10000000])], 'attestor');
    await call('normal:record-arrival', controller, 'executeLifecycle', [pool.interface.encodeFunctionData('recordCargoArrival', [normal.pool_id, id('N5_SYNTHETIC_ARRIVAL')])], 'attestor');
    await call('normal:settle', controller, 'executeLifecycle', [pool.interface.encodeFunctionData('settle', [normal.pool_id, 10000000])], 'operator');
    for (const actor of ['investor', 'governorC']) {
      const sent = await call(`normal:${actor}:claim`, pool, 'claim', [normal.pool_id], actor);
      normal.wallet_claims ??= {}; normal.wallet_claims[actor] = await balanceDelta(sent, actor, 5000000);
      ensure(await pool.investorClaimed(normal.pool_id, usdc.target, signers[actor].address) === 5000000n, 'Normal allocation differs');
    }
    ensure(await pool.escrowed(normal.pool_id, usdc.target) === 0n, 'Normal escrow not zero'); normal.passed = true; await save();
    for (let index = 4; index <= poolCount; index++) await create(`capacity-${index}`);
    if (await boundary(BigInt(refund.pack.terms.subscribeUntil) + 1n)) {
      const returned = await call('refund:return-principal', pool, 'refundInvestor', [refund.pool_id, signers.investor.address]);
      refund.wallet_refund = await balanceDelta(returned, 'investor', 2400000);
      ensure(await pool.escrowed(refund.pool_id, usdc.target) === 0n && await token.balanceOf(refund.pool_id, signers.investor.address) === 0n, 'Refund left obligations');
      refund.passed = true;
    } else refund.wait_until = new Date((Number(refund.pack.terms.subscribeUntil) + 1) * 1000).toISOString();
    if (await boundary(loss.pack.terms.maturity)) {
      await call('loss:default', controller, 'executeLifecycle', [pool.interface.encodeFunctionData('markDefault', [loss.pool_id])], 'operator');
      await call('loss:notify', controller, 'notifyResolution', [loss.pool_id, id('N5_SYNTHETIC_DEFAULT'), id('N5_CYCLIC_CASH_ALLOCATION'), 4000001], 'disposer');
      await call('loss:review', controller, 'reviewResolution', [loss.pool_id, id('N5_RESEARCH_REVIEW')], 'reviewer');
      const resolution = await controller.resolutions(loss.pool_id);
      loss.notice_until = new Date(Number(resolution.noticeUntil) * 1000).toISOString();
      if (await boundary(resolution.noticeUntil)) {
        await call('loss:finalize', controller, 'finalizeResolution', [loss.pool_id], 'governorC');
        loss.wallet_claims ??= {};
        for (const actor of ['investor', 'governorC']) {
          const claimed = await call(`loss:${actor}:initial-claim`, pool, 'claim', [loss.pool_id], actor);
          loss.wallet_claims[actor] = { initial: await balanceDelta(claimed, actor, actor === 'investor' ? 2000001 : 2000000) };
        }
        await call('loss:approve-late', usdc, 'approve', [pool.target, 9], 'holder');
        await call('loss:late-repayment', pool, 'repay', [loss.pool_id, 9], 'holder');
        for (const actor of ['investor', 'governorC']) {
          ensure(await token.balanceOf(loss.pool_id, signers[actor].address) === 0n, 'Late claim should survive zero shares');
          const claimed = await call(`loss:${actor}:late-claim`, pool, 'claim', [loss.pool_id], actor);
          loss.wallet_claims[actor].late = await balanceDelta(claimed, actor, actor === 'investor' ? 4 : 5);
          ensure(await pool.investorClaimed(loss.pool_id, usdc.target, signers[actor].address) === 2000005n, 'Late allocation differs');
        }
        ensure(await pool.escrowed(loss.pool_id, usdc.target) === 0n, 'Loss escrow not zero'); loss.passed = true;
      }
    } else loss.maturity_wait_until = new Date(Number(loss.pack.terms.maturity) * 1000).toISOString();
    work.passed = normal.passed && refund.passed === true && loss.passed === true;
    work.observed_at = new Date().toISOString(); if (work.passed) work.completed_at = work.observed_at; await save();
    await fs.mkdir(path.join(directory, 'public-evidence'), { recursive: true });
    await writeJsonAtomic(path.join(directory, 'public-evidence/funding.json'), safe(work));
    return work;
  } finally { await chain.provider.destroy(); }
}
