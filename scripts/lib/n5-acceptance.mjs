import fs from 'node:fs/promises';
import path from 'node:path';
import { Contract, ZeroHash, formatEther, formatUnits, getAddress, id, isAddress } from 'ethers';
import { RightsService } from '../../src/rights/service.js';
import { ISSUANCE_TYPES, VALUATION_TYPES, assetIdentity, rightsDomain, titleDomain } from '../../src/rights/typedData.js';
import { chainStateName } from '../../src/agent/runtime/poolRules.js';
import { acquireRuntimeLease } from '../../src/ops/lease.js';
import { writeJsonAtomic } from '../../src/lib/jsonStore.js';
import { releaseSourceSnapshot } from './release-source.mjs';

const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const safe = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));
const DAY = 86400, TAGS = ['normal', 'refund'];
export const ACCEPTANCE_STAGES = Object.freeze(['plan', 'prepare', 'screening', 'repay']);
// The fictional economics of the N5 normal and refund paths: 10 shares at 0.8, a 1.0 target and all 10 required.
export const ACCEPTANCE_TERMS = Object.freeze({ supply: '10', issuePrice: '800000', target: '1000000', minRaise: '8000000' });
const TOP_UP_LIMITS = Object.freeze({ test_usdc_atomic: 100000000n, inj_wei: 50000000000000000n });
const instant = (value, name) => {
  const ms = typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ? Date.parse(value) : Number.NaN;
  ensure(Number.isFinite(ms) && ms % 1000 === 0, `${name} needs an ISO time with an explicit zone`);
  return ms / 1000;
};
const clock = (seconds) => ({ unix: Number(seconds), utc: new Date(Number(seconds) * 1000).toISOString(),
  sgt: new Date((Number(seconds) + 8 * 3600) * 1000).toISOString().replace('.000Z', '+08:00') });
const units = (atomic) => `${formatUnits(atomic, 6)} TEST_USDC (${atomic})`;

/** Structural checks only. Deadlines are checked against chain time when each pool is created. */
export function parseAcceptanceInput(raw, actors) {
  ensure(raw?.schema === 'agentbl-n5-acceptance-input-v1', 'Unsupported acceptance input');
  ensure(/^[a-z0-9][a-z0-9-]{0,31}$/u.test(raw.run ?? ''), 'run must be a short lowercase tag');
  const research = new Set(Object.values(actors).map((address) => address.toLowerCase()));
  ensure(Array.isArray(raw.investors) && raw.investors.length === 2, 'Exactly two acceptor wallets are required');
  const investors = raw.investors.map((entry, index) => {
    const label = ['A', 'B'][index];
    ensure(entry?.label === label && isAddress(entry.wallet) && !/^0x0{40}$/iu.test(entry.wallet), `Investor ${label} needs a valid wallet`);
    ensure(!research.has(entry.wallet.toLowerCase()), `Investor ${label} must be an acceptor wallet, not a research signer`);
    return { label, wallet: getAddress(entry.wallet), organization: `N5_ACCEPTANCE_${raw.run}_${label}` };
  });
  ensure(investors[0].wallet !== investors[1].wallet, 'The two acceptor wallets must differ');
  const pools = Object.fromEntries(TAGS.map((tag) => {
    const value = raw.pools?.[tag] ?? {}, subscribeUntil = instant(value.subscribe_until, `${tag}.subscribe_until`);
    const disburseUntil = value.disburse_until == null ? subscribeUntil + DAY : instant(value.disburse_until, `${tag}.disburse_until`);
    const maturity = value.maturity == null ? disburseUntil + DAY : instant(value.maturity, `${tag}.maturity`);
    ensure(subscribeUntil < disburseUntil && disburseUntil < maturity, `${tag} needs subscribe_until < disburse_until < maturity`);
    return [tag, { subscribeUntil, disburseUntil, maturity }];
  }));
  const topUp = (key, fallback) => {
    const value = BigInt(raw.top_up?.[key] ?? fallback);
    ensure(value > 0n && value <= TOP_UP_LIMITS[key], `top_up.${key} is outside the research bound`);
    return String(value);
  };
  return { run: raw.run, investors, pools, screeningUntil: raw.screening_until == null ? null : instant(raw.screening_until, 'screening_until'),
    topUp: { testUsdcAtomic: topUp('test_usdc_atomic', '10000000'), injWei: topUp('inj_wei', '20000000000000000') } };
}

function contracts(state, candidate, provider) {
  const contract = (name) => new Contract(state.contracts[name], candidate.artifacts[name].abi, provider);
  return { controller: contract('RightsController'), registry: contract('CommittedEBLRegistry'), pool: contract('RWAOfferingPoolV5'), usdc: contract('MockAuthorizationUSDC') };
}
const requireFundedInstance = (state) => ensure(state?.active && state.funding?.passed === true, 'Acceptance needs an active instance whose N5 funding paths passed');

/** Keyless dry run for operator review: lists every transaction a stage would send and its journal status. */
export async function acceptancePlan({ state, candidate, provider, input: raw }) {
  requireFundedInstance(state);
  const input = parseAcceptanceInput(raw, state.actors), work = state.acceptance?.runs?.[input.run] ?? { investors: {}, scenarios: {} };
  const { controller, pool } = contracts(state, candidate, provider);
  const [block, nextPool, screening] = await Promise.all([provider.getBlock('latest'), pool.nextPoolId(), controller.screeningValidUntil()]);
  const sent = (name) => state.transactions.find((tx) => tx.label === `acceptance:${input.run}:${name}`);
  const tx = (name, actor, action, detail = {}) => ({ label: `acceptance:${input.run}:${name}`, signer: { role: actor, address: state.actors[actor] }, action, ...detail,
    status: sent(name)?.status ?? 'NOT_SENT', ...(sent(name)?.tx_hash ? { tx_hash: sent(name).tx_hash } : {}) });
  let expected = Number(nextPool);
  const pools = TAGS.map((tag) => {
    const saved = work.scenarios[tag], timing = saved ? Object.fromEntries(['subscribeUntil', 'disburseUntil', 'maturity'].map((key) => [key, Number(saved.pack.terms[key])])) : input.pools[tag];
    return { tag, pool_id: saved?.pool_id ?? null, ...(saved?.pool_id ? {} : { expected_pool_id: expected++ }), subscribe_until: clock(timing.subscribeUntil),
      disburse_until: clock(timing.disburseUntil), maturity: clock(timing.maturity), shares: ACCEPTANCE_TERMS.supply, issue_price: units(ACCEPTANCE_TERMS.issuePrice),
      redemption_per_share: units(ACCEPTANCE_TERMS.target), min_raise: units(ACCEPTANCE_TERMS.minRaise), fee: '0' };
  });
  const eligibleUntil = Math.max(...pools.map((p) => p.disburse_until.unix)), normal = work.scenarios.normal;
  const repayment = { amount: units(normal?.repayment_atomic ?? String(BigInt(ACCEPTANCE_TERMS.supply) * BigInt(ACCEPTANCE_TERMS.target))) };
  const stages = {
    prepare: [...TAGS.flatMap((tag) => [tx(`${tag}:register`, 'issuer', 'CommittedEBLRegistry.registerTitle (fictional copper title)', { pool: tag }),
      tx(`${tag}:pledge`, 'holder', 'CommittedEBLRegistry.pledge (holder consent to the pool and exact terms)', { pool: tag }),
      tx(`${tag}:create`, 'issuer', 'RightsController.createControlledOffering (two reviews, published terms, valuer signature)', { pool: tag })]),
    ...input.investors.flatMap(({ label, wallet }) => [tx(`investor-${label}:eligibility`, 'compliance', 'RightsController.setEligibility', { wallet, valid_until: clock(eligibleUntil) }),
      tx(`investor-${label}:test-usdc`, 'governorA', 'MockAuthorizationUSDC.mint (test token)', { wallet, amount: units(input.topUp.testUsdcAtomic) }),
      tx(`investor-${label}:inj`, 'governorA', 'INJ transfer for gas', { wallet, amount: `${formatEther(input.topUp.injWei)} INJ` })])],
    screening: input.screeningUntil ? [tx(`screening:${input.screeningUntil}`, 'compliance', 'RightsController.refreshScreening', { valid_until: clock(input.screeningUntil) })] : [],
    repay: [tx('normal:disburse', 'operator', 'RightsController.disburse to the holder', { amount: units(normal?.disbursement_atomic ?? ACCEPTANCE_TERMS.minRaise) }),
      tx('normal:approve-repayment', 'holder', 'TEST_USDC.approve (exact repayment to the pool)', repayment), tx('normal:repayment', 'holder', 'RWAOfferingPoolV5.repay', repayment),
      tx('normal:record-payment', 'attestor', 'recordImporterPayment through executeLifecycle', repayment),
      tx('normal:record-arrival', 'attestor', 'recordCargoArrival through executeLifecycle'), tx('normal:settle', 'operator', 'settle through executeLifecycle', repayment)]
  };
  return { schema: 'agentbl-n5-acceptance-plan-v1', instance_id: state.instance_id, run: input.run, chain_time: clock(block.timestamp), screening_valid_until: clock(screening),
    investors: input.investors.map((investor) => ({ ...investor, subject_id: work.investors[investor.label]?.subject_id ?? null })), pools, stages,
    preconditions: { prepare: 'stop the instance application first; prepare holds application/.runtime-lease while it writes the rights vault',
      screening: 'screening_until within the next 24 hours of chain time', repay: 'normal pool Funded by the acceptor wallets, live screening, before disburse_until' } };
}

// Operator automation for docs/acceptance.md: new reviewed pools and investor access through the research
// signers. Subscriptions, claims and refunds stay with the acceptor's own wallets and are never sent here.
export async function runAcceptance({ directory, candidate, state, save, txSend, provider, signers, rightsKey, input: raw, stage }) {
  requireFundedInstance(state);
  ensure(['prepare', 'screening', 'repay'].includes(stage), 'Unknown acceptance stage');
  const input = parseAcceptanceInput(raw, state.actors);
  const { controller, registry, pool, usdc } = contracts(state, candidate, provider);
  // Version 2 candidates predate the version field in their disclosures and signing domain.
  const version = candidate.control_version ?? 2;
  state.acceptance ??= { schema: 'agentbl-n5-acceptance-v1', chain_id: state.chain_id, runs: {}, real_business: false, human_verified: false };
  const work = state.acceptance.runs[input.run] ??= { run: input.run, investors: {}, scenarios: {}, screenings: [], execution_sources: [] };
  const source = await releaseSourceSnapshot();
  if (!work.execution_sources.some((entry) => entry.base_head === source.base_head && entry.source_sha256 === source.source_sha256 && entry.stage === stage)) {
    work.execution_sources.push({ stage, base_head: source.base_head, source_sha256: source.source_sha256, observed_at: new Date().toISOString() });
  }
  await save();
  const label = (name) => `acceptance:${input.run}:${name}`, sent = (name) => state.transactions.some((tx) => tx.label === label(name));
  const call = (name, target, method, args, actor) => txSend(label(name), signers[actor], { to: target.target, data: target.interface.encodeFunctionData(method, args) });
  const now = async () => (await provider.getBlock('latest')).timestamp;
  if (stage === 'prepare') {
    ensure(/^[a-f0-9]{64}$/u.test(rightsKey ?? ''), 'The rights vault key is required to prepare acceptance pools');
    const application = path.join(directory, 'application');
    // The running application is the vault's only writer; refuse unless its lease can be taken.
    const release = await acquireRuntimeLease(application, 'acceptance-operator');
    try {
      const service = new RightsService({ directory: path.join(application, 'rights'), env: { AGENTBL_RIGHTS_KEY: rightsKey, AGENTBL_RUNTIME_DIR: application } });
      for (const investor of input.investors) {
        const saved = work.investors[investor.label];
        if (saved) { ensure(saved.wallet === investor.wallet, `Investor ${investor.label} is enrolled with another wallet; use a new run`); continue; }
        // The same service call as the administrator route POST /api/rights/subjects.
        const subject = await service.createSubject({ organization: investor.organization, wallet: investor.wallet, roles: ['investor'] });
        work.investors[investor.label] = { ...investor, subject_id: subject.subject_id }; await save();
      }
      const sessions = {};
      for (const actor of ['issuer', 'reviewer', 'governorC']) {
        const subject = state.funding.subjects[actor]; ensure(subject?.subject_id, `Research subject ${actor} is missing`);
        const challenge = await service.createChallenge(subject.subject_id);
        sessions[actor] = (await service.openSession({ challenge_id: challenge.challenge_id, signature: await signers[actor].signTypedData(challenge.domain, challenge.types, challenge.message) })).token;
      }
      for (const tag of TAGS) {
        const timing = input.pools[tag], name = `acceptance-${input.run}-${tag}`;
        let p = work.scenarios[tag];
        if (p) ensure(['subscribeUntil', 'disburseUntil', 'maturity'].every((key) => p.pack.terms[key] === String(timing[key])), `Pool ${tag} was prepared with other deadlines; keep the original input or use a new run`);
        else {
          const time = await now();
          // The valuation signed at creation must stay valid until disbursement, for at most 30 days.
          ensure(time < timing.subscribeUntil && timing.disburseUntil <= time + 30 * DAY && timing.maturity <= time + 366 * DAY, `${tag} deadlines are outside the contract bounds at chain time`);
          const eblId = String(await registry.nextEblId());
          const material = await service.createMaterial(sessions.issuer, { material: { fictional: true, cargo: 'Copper cathodes', origin: 'Singapore', destination: 'Shanghai', case: name, instance: candidate.instance_id, purpose: 'human_wallet_acceptance' },
            public_summary: { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: Math.min(366, Math.ceil((timing.maturity - time) / DAY)), terms_hash: id(`provisional:${name}`), risk_flags: ['simulated_title', 'test_asset', 'capital_at_risk'] } });
          const issuance = { assetKey: assetIdentity('AGENTBL N5 SYNTHETIC ISSUER', `${registry.target}:${name}`), documentHash: material.document_hash,
            issuerOrg: id('AGENTBL_N5_SYNTHETIC_ISSUER'), holder: signers.holder.address, revision: 1, previousHash: ZeroHash, nonce: String(BigInt(id(`issuance:${name}`))), validUntil: String(time + 7 * DAY) };
          const pack = await service.createFinancingDisclosure(sessions.issuer, material.material_id, { revision: 1, instance: { chain_id: state.chain_id, controller: controller.target, pool: pool.target, ...(version >= 3 ? { control_version: version } : {}) },
            terms: { eblId, assetKey: issuance.assetKey, documentHash: material.document_hash, settlementAsset: usdc.target, exporter: signers.holder.address, feeRecipient: signers.governorA.address,
              ...ACCEPTANCE_TERMS, subscribeUntil: String(timing.subscribeUntil), disburseUntil: String(timing.disburseUntil), maturity: String(timing.maturity), maxFee: '0', nonce: String(BigInt(id(`terms:${name}`))) },
            parties: Object.fromEntries(['issuer', 'holder', 'operator', 'valuer', 'compliance', 'disposer', 'reviewer', 'governance'].map((role) => [role, role === 'governance' ? state.contracts.RightsGovernance : signers[role].address])),
            sources: ['invoice', 'cost', 'collateral', 'risk'].map((field) => ({ field, status: 'fixture', reference: 'Fictional N5 acceptance data; no verified real cargo or rights' })) });
          p = safe({ material, issuance, pack }); work.scenarios[tag] = p; await save();
        }
        await call(`${tag}:register`, registry, 'registerTitle', [p.issuance, await signers.issuer.signTypedData(titleDomain(state.chain_id, registry.target), ISSUANCE_TYPES, p.issuance)], 'issuer');
        ensure(String(await registry.eblForAsset(p.issuance.assetKey)) === p.pack.terms.eblId, `The ${tag} title received another eBL number; reconcile before pledging`);
        await call(`${tag}:pledge`, registry, 'pledge', [p.pack.terms.eblId, pool.target, p.pack.terms_hash, p.pack.terms.subscribeUntil, '0x'], 'holder');
        if (!p.published) {
          await service.bindTerms(sessions.issuer, p.material.material_id, p.pack.terms_hash);
          for (const actor of ['reviewer', 'governorC']) await service.reviewMaterial(sessions[actor], p.material.material_id, { document_hash: p.material.document_hash, terms_hash: p.pack.terms_hash });
          await service.publishMaterial(sessions.issuer, p.material.material_id); p.published = true; await save();
        }
        p.valuation ??= { termsHash: p.pack.terms_hash, assetKey: p.pack.terms.assetKey, settlementAsset: usdc.target, netValue: '20000000', coverageBps: 15000,
          valuedAt: String(await now()), validUntil: p.pack.terms.disburseUntil, nonce: String(BigInt(id(`valuation:${name}`))) }; await save();
        const created = await call(`${tag}:create`, controller, 'createControlledOffering', [p.pack.terms, p.valuation, signers.valuer.address,
          await signers.valuer.signTypedData(rightsDomain(state.chain_id, controller.target, version), VALUATION_TYPES, p.valuation)], 'issuer');
        const event = created.receipt.logs.map((log) => { try { return controller.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'TermsCommitted');
        ensure(event, 'Offering receipt missing'); p.pool_id = String(event.args.poolId); await save();
        ensure((await service.financingDisclosure(p.pack.disclosure_hash)).terms_hash === await controller.termsHash(p.pool_id), 'Readable terms differ from chain');
      }
    } finally { await release(); }
    const eligibleUntil = Math.max(...TAGS.map((tag) => Number(work.scenarios[tag].pack.terms.disburseUntil)));
    for (const investor of Object.values(work.investors)) {
      await call(`investor-${investor.label}:eligibility`, controller, 'setEligibility', [investor.wallet, id(investor.subject_id), id('ACCEPTANCE_SYNTHETIC_NOT_KYC'), eligibleUntil], 'compliance');
      await call(`investor-${investor.label}:test-usdc`, usdc, 'mint', [investor.wallet, input.topUp.testUsdcAtomic], 'governorA');
      await txSend(label(`investor-${investor.label}:inj`), signers.governorA, { to: investor.wallet, value: BigInt(input.topUp.injWei) });
    }
  }
  if (stage === 'screening') {
    const until = input.screeningUntil; ensure(until, 'Set screening_until in the acceptance input');
    if (!sent(`screening:${until}`)) { const time = await now(); ensure(time < until && until <= time + DAY, 'screening_until must fall within the next 24 hours of chain time'); }
    await call(`screening:${until}`, controller, 'refreshScreening', [until, id('ACCEPTANCE_SYNTHETIC_SCREENING_NOT_COMPLIANCE')], 'compliance');
    if (!work.screenings.includes(until)) work.screenings.push(until);
  }
  if (stage === 'repay') {
    const p = work.scenarios.normal; ensure(p?.pool_id, 'Prepare the acceptance pools first');
    if (!sent('normal:disburse')) {
      const [offer, finalized, screening, time] = await Promise.all([pool.offerings(p.pool_id), pool.fundingFinalized(p.pool_id), controller.screeningValidUntil(), now()]);
      ensure(finalized && chainStateName(offer.state) === 'Funded', 'The normal pool is not fully subscribed by the acceptor wallets yet');
      ensure(Number(screening) >= time, 'Screening has expired; run the screening stage first');
      ensure(time < Number(p.pack.terms.disburseUntil), 'The disbursement deadline has passed');
      p.disbursement_atomic = String(offer.raisedAtomic); await save();
    }
    await call('normal:disburse', controller, 'disburse', [p.pool_id, p.disbursement_atomic, id(`ACCEPTANCE_FICTIONAL_DRAWDOWN:${input.run}`)], 'operator');
    if (!p.repayment_atomic) { p.repayment_atomic = String(await pool.targetDistribution(p.pool_id)); await save(); }
    if (!sent('normal:approve-repayment')) ensure(await usdc.balanceOf(signers.holder.address) >= BigInt(p.repayment_atomic), 'The holder test balance cannot cover the repayment');
    await call('normal:approve-repayment', usdc, 'approve', [pool.target, p.repayment_atomic], 'holder');
    const repayment = await call('normal:repayment', pool, 'repay', [p.pool_id, p.repayment_atomic], 'holder');
    await call('normal:record-payment', controller, 'executeLifecycle', [pool.interface.encodeFunctionData('recordImporterPayment', [p.pool_id, repayment.tx_hash, p.repayment_atomic])], 'attestor');
    await call('normal:record-arrival', controller, 'executeLifecycle', [pool.interface.encodeFunctionData('recordCargoArrival', [p.pool_id, id(`ACCEPTANCE_SYNTHETIC_ARRIVAL:${input.run}`)])], 'attestor');
    await call('normal:settle', controller, 'executeLifecycle', [pool.interface.encodeFunctionData('settle', [p.pool_id, p.repayment_atomic])], 'operator');
    ensure(chainStateName((await pool.offerings(p.pool_id)).state) === 'Repaid', 'The normal pool did not settle');
    p.settled = true;
  }
  work.observed_at = new Date().toISOString(); await save();
  await fs.mkdir(path.join(directory, 'public-evidence'), { recursive: true });
  await writeJsonAtomic(path.join(directory, 'public-evidence', `acceptance-${input.run}.json`), safe(work));
  return work;
}
