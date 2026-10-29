import { id } from 'ethers';
import { chainStateName } from '../agent/runtime/poolRules.js';
import { RpcReadPool, assertSnapshot, snapshotInfo } from './reads.js';
import { verifyChain } from './chain.js';
import { readScreening } from './screening.js';
import { CONTROL_VERSION } from './typedData.js';

export const WORKFLOW_STEPS = [
  { id: 'document', roles: ['issuer'], next: 'create_material' },
  { id: 'title', roles: ['issuer'], next: 'register_title' },
  { id: 'terms', roles: ['issuer', 'reviewer', 'valuer'], next: 'review_material' },
  { id: 'consent', roles: ['holder'], next: 'pledge' },
  { id: 'issue', roles: ['issuer'], next: 'create_offering' },
  { id: 'eligibility', roles: ['compliance'], next: 'set_eligibility' },
  { id: 'fund', roles: ['investor'], next: 'acknowledge_terms' },
  { id: 'draw', roles: ['operator'], next: 'disburse' },
  { id: 'repay', roles: ['holder', 'attestor', 'operator', 'disposer', 'reviewer'], next: 'repay' },
  { id: 'exit', roles: ['investor'], next: 'claim' }
];

/** Workflow observations are hints. Each wallet operation still executes a fresh
 * contract preflight, and a missing observation never means a step succeeded. */
export async function materialWorkflow(chain, principal, record, pack, published, approvals, readPool = new RpcReadPool()) {
  const result = { material_id: record.material_id, revision: record.revision, document_hash: record.document_hash,
    terms_hash: record.public_summary.terms_hash, approvals, published: Boolean(published), steps: WORKFLOW_STEPS.map((step, index) => ({ ...step,
      status: index === 0 ? 'complete' : 'unknown', assigned_to_you: step.roles.some((role) => principal.roles.includes(role)) })),
    disclosure: pack ?? null, business_enabled: false, snapshot: null, pool_id: null, state: null };
  result.steps[2].status = published && approvals >= 2 ? 'complete' : 'pending';
  if (!chain || !pack) { result.warning = !chain ? 'rights_chain_not_configured' : 'financing_disclosure_missing'; return result; }
  const { read, stats } = readPool.budget(120);
  try {
    const block = await read(() => chain.provider.getBlock('latest')), at = { blockTag: block.number };
    const binding = await verifyChain(chain, { read, readAt: at });
    const eblId = await read(() => chain.registry.eblForAsset(pack.terms.assetKey, at));
    const [title, pledge, pledgeTerms, poolId] = eblId > 0n ? await Promise.all([
      read(() => chain.registry.titles(eblId, at)), read(() => chain.registry.pledgedTo(eblId, at)), read(() => chain.registry.pledgeTerms(eblId, at)), read(() => chain.controller.latestPoolForEbl(eblId, at)) ]) : [null, null, null, 0n];
    result.steps[1].status = title && title.documentHash === record.document_hash && String(eblId) === pack.terms.eblId ? 'complete' : 'pending';
    result.steps[3].status = pledgeTerms === pack.terms_hash && pledge?.toLowerCase() === (await chain.pool.getAddress()).toLowerCase() ? 'complete' : 'pending';
    const issued = poolId > 0n && await read(() => chain.controller.termsHash(poolId, at)) === pack.terms_hash;
    result.steps[4].status = issued ? 'complete' : 'pending';
    if (issued) {
      result.steps[3].status = 'complete';
      const [offer, disbursed, recovery, screening, finalized, deadline] = await Promise.all([
        read(() => chain.pool.offerings(poolId, at)), read(() => chain.pool.disbursedAtomic(poolId, at)),
        read(() => chain.pool.recoveredAtomic(poolId, at)), readScreening(chain, binding?.control_version, read, at),
        read(() => chain.pool.fundingFinalized(poolId, at)), read(() => chain.pool.subscriptionDeadline(poolId, at)) ]);
      result.pool_id = Number(poolId); result.state = chainStateName(offer.state); result.funding_finalized = Boolean(finalized);
      // Eligibility also needs the screening's signer to still hold COMPLIANCE (the controller's isEligible()).
      result.steps[5].status = screening.valid_until == null || binding?.control_version === CONTROL_VERSION && screening.attestor_active == null
        ? 'unknown' : Number(screening.valid_until) >= block.timestamp && screening.attestor_active !== false ? 'check_each_investor' : 'pending';
      if (screening.attestor_active === false && Number(screening.valid_until) >= block.timestamp) result.steps[5].blocker = 'screening_source_inactive';
      // Reaching the minimum is not funding: a partial raise is closed by finalizeFunding() after the deadline, and only
      // a finalized raise can be drawn. A full raise finalizes itself on its last subscription.
      const closable = !finalized && offer.subscribed > 0n && offer.raisedAtomic >= BigInt(pack.terms.minRaise)
        && Number(deadline) < block.timestamp && [2, 3, 6].includes(Number(offer.state));
      result.steps[6].status = finalized ? 'complete' : closable ? 'finalize_required' : 'pending';
      if (closable) {
        Object.assign(result.steps[6], { next: 'finalize_funding', roles: ['operator', 'custodian', 'issuer', 'holder', 'investor'] });
        result.steps[6].assigned_to_you = result.steps[6].roles.some((role) => principal.roles.includes(role));
      }
      result.steps[7].status = disbursed > 0n ? 'complete' : 'pending';
      result.steps[8].status = [9, 14].includes(Number(offer.state)) ? 'complete' : 'pending';
      result.steps[9].status = [9, 14].includes(Number(offer.state)) ? 'claim_available' : 'check_refund_or_wait';
      result.amounts = { raised_atomic: String(offer.raisedAtomic), disbursed_atomic: String(disbursed), recovered_atomic: String(recovery) };
      result.onchain_roles = Object.fromEntries(await Promise.all(['issuer', 'valuer', 'operator', 'compliance', 'disposer', 'reviewer', 'attestor'].map(async (role) =>
        [role, await read(() => chain.controller.roles(id(role.toUpperCase()), principal.wallet, at))])));
    }
    await assertSnapshot(chain.provider, block, read); result.snapshot = snapshotInfo(block); result.read_metrics = stats;
  } catch {
    // Discard every optimistic chain observation when any read or canonical check fails.
    for (const step of result.steps) if (!['document', 'terms'].includes(step.id)) step.status = 'unknown';
    result.pool_id = null; result.state = null; delete result.amounts; delete result.onchain_roles;
    result.warning = 'workflow_chain_unavailable';
  }
  return result;
}
