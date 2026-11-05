import { id } from 'ethers';
import { chainStateName } from '../agent/runtime/poolRules.js';
import { RpcReadPool, assertSnapshot, snapshotInfo } from './reads.js';
import { verifyChain } from './chain.js';
import { readScreening } from './screening.js';
import { controllerSourceBlockers } from './sources.js';
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
// Who may start the deterministic exits (RightsController.startExit) and cancel an offering nobody subscribed.
const EXIT_ROLES = ['custodian', 'holder', 'investor', 'reviewer'];
const CANCEL_ROLES = ['operator', 'custodian'];
const FINALIZE_ROLES = ['operator', 'custodian', 'issuer', 'holder', 'investor'];
const SUBSCRIBABLE = ['Open', 'Subscribed', 'Repriced'];
const TERMINAL = ['Cancelled', 'Repaid', 'Redeemed', 'LossSettled'];
const RESOLUTION = ['Defaulted', 'Liquidation'];
// The on-chain role the contract itself demands of the wallet that acts on a step (RightsController onlyRole): enrollment in
// this application never grants it, so a step the caller is enrolled for can still be refused for this wallet.
const CALLER_ROLE = { eligibility: 'compliance', draw: 'operator' };
const ONCHAIN_ROLES = ['issuer', 'valuer', 'operator', 'compliance', 'disposer', 'reviewer', 'attestor'];
const ZERO_ADDRESS = /^0x0{40}$/iu;

/**
 * A step's `phase` says what its roles can do about it now, so the workspace lists real tasks instead of every unfinished
 * step: `actionable` (its roles can act now), `waiting` (an earlier step, another role or a date comes first),
 * `blocked` (the pool's state or an instance-wide condition stops it; `blocker` names the first reason, `blockers` all of
 * them), `complete`, `not_applicable` or `unknown`. `status` keeps the step's own detail (finalize_required,
 * refund_available, partial, ...). Phases are hints read from one block: each wallet operation still runs the contract's
 * own preflight, and a step that reads `actionable` here is never a promise that the preflight will pass.
 */
function set(step, status, phase, extra = {}) {
  Object.assign(step, { status, phase, ...extra });
  if (!extra.blocker) delete step.blocker;
  if (!extra.blockers) delete step.blockers;
}
const phaseOf = (status) => status === 'complete' ? 'complete' : status === 'not_applicable' ? 'not_applicable' : status === 'unknown' ? 'unknown' : null;

/** Phases before the offering exists, from the statuses read so far. */
function phasesBeforeIssue(steps, pack) {
  const [document, title, terms, consent, issue, ...later] = steps;
  set(document, 'complete', 'complete');
  if (title.status === 'pending') set(title, 'pending', 'actionable');
  else title.phase = phaseOf(title.status);
  // Without imported terms the issuer imports them; otherwise reviewers approve and the issuer publishes.
  terms.phase = terms.status === 'complete' ? 'complete' : 'actionable';
  if (consent.status === 'pending') set(consent, 'pending', title.status !== 'complete' ? 'waiting' : terms.status !== 'complete' ? 'waiting' : 'actionable',
    title.status !== 'complete' ? { blocker: 'title_not_registered' } : terms.status !== 'complete' ? { blocker: 'terms_unpublished' } : {});
  else consent.phase = phaseOf(consent.status);
  if (issue.status === 'pending') set(issue, 'pending', consent.status !== 'complete' ? 'waiting' : 'actionable', consent.status !== 'complete' ? { blocker: 'pledge_missing' } : {});
  else issue.phase = phaseOf(issue.status);
  for (const step of later) {
    if (step.status === 'unknown' && pack && issue.status === 'pending') set(step, 'pending', 'waiting', { blocker: 'not_issued' });
    else step.phase = phaseOf(step.status) ?? 'waiting';
  }
}

/** Phases of an issued pool that is still running, from the conditions the contracts check (docs/contracts.md, freeze matrix). */
function phasesWhileRunning(result, steps, c, roles) {
  const [, , , , , eligibility, fund, draw, repay, exit] = steps;
  const subscriptionsOpen = SUBSCRIBABLE.includes(c.state) && !c.deadlinePassed && !c.full;
  // The sources the controller checks for every new subscription (isEligible) and for every draw (disburse): the intake
  // switch, the screening and its signer, the valuation and its valuer, the title and the settlement asset (sources.js).
  // They differ by a second of valuation arithmetic only, so each is judged by its own rule.
  const fundSources = controllerSourceBlockers(c.sources), drawSources = controllerSourceBlockers(c.sources, { draw: true });
  const newRisk = fundSources.blockers[0] ?? null, unknownNewRisk = fundSources.unknown;
  const drawRisk = drawSources.blockers[0] ?? null, unknownDrawRisk = drawSources.unknown;
  const raiseFailed = !c.finalized && c.subscribed && c.deadlinePassed && c.metMinimum === false && [...SUBSCRIBABLE, 'Paused', 'Frozen'].includes(c.state);
  const unsubscribed = !c.subscribed && c.deadlinePassed;
  const drawOver = c.drawDeadline != null && c.now >= c.drawDeadline;
  const drawPending = c.finalized && !c.disbursed && !drawOver && !RESOLUTION.includes(c.state);

  // Eligibility: compliance approves investors while subscriptions are open; the instance-wide screening must also hold
  // for the draw. A lapsed or orphaned screening is a compliance task while this pool still needs one.
  if (eligibility.status === 'pending') set(eligibility, 'pending', subscriptionsOpen || drawPending ? 'actionable' : 'not_applicable',
    eligibility.blocker ? { blocker: eligibility.blocker } : {});
  else if (eligibility.status === 'check_each_investor') set(eligibility, subscriptionsOpen ? 'check_each_investor' : 'complete', subscriptionsOpen ? 'actionable' : 'complete');
  else eligibility.phase = phaseOf(eligibility.status) ?? 'unknown';

  // Funding: closed by the last share or by finalizeFunding(); a raise below its minimum at the deadline is refunded.
  if (c.finalized) set(fund, 'complete', 'complete');
  else if (fund.status === 'finalize_required') set(fund, 'finalize_required', 'actionable');
  else if (raiseFailed) set(fund, 'not_applicable', 'not_applicable', { blocker: 'minimum_not_reached' });
  else if (unsubscribed) set(fund, 'not_applicable', 'not_applicable', { blocker: 'no_subscribers' });
  else if (c.state === 'Frozen') set(fund, 'pending', 'blocked', { blocker: 'state_frozen' });
  else if (c.state === 'Paused') set(fund, 'pending', 'blocked', { blocker: 'state_paused' });
  else if (subscriptionsOpen) set(fund, 'pending', newRisk ? 'blocked' : unknownNewRisk ? 'unknown' : 'actionable', newRisk ? { blocker: newRisk, blockers: fundSources.blockers } : {});
  else if (SUBSCRIBABLE.includes(c.state) && c.deadlinePassed && c.metMinimum == null) set(fund, 'pending', 'unknown');
  else set(fund, 'not_applicable', 'not_applicable');

  // Draw: only a finalized raise, in Funded or InTransit, before the draw deadline (which the contract keeps before
  // maturity), with every source current. The principal may be drawn in several calls until the raise is used up, so a
  // first draw is a milestone, not the end of the step: it stays open while anything is left and the window is open.
  const drawn = c.drawn ?? 0n, remaining = c.raised == null ? null : c.raised - drawn;
  const amounts = { drawn_atomic: String(drawn), remaining_atomic: remaining == null ? null : String(remaining > 0n ? remaining : 0n) };
  if (c.disbursed && remaining != null && remaining <= 0n) set(draw, 'complete', 'complete', amounts);
  else if (c.disbursed) {
    if (RESOLUTION.includes(c.state) || drawOver) set(draw, 'window_closed', 'complete', { ...amounts, next: null });
    else if (c.state === 'Frozen') set(draw, 'partial', 'blocked', { ...amounts, blocker: 'state_frozen' });
    else if (c.state === 'Paused') set(draw, 'partial', 'blocked', { ...amounts, blocker: 'state_paused' });
    else if (drawRisk) set(draw, 'partial', 'blocked', { ...amounts, blocker: drawRisk, blockers: drawSources.blockers });
    else set(draw, 'partial', unknownDrawRisk || c.drawDeadline == null ? 'unknown' : 'actionable', amounts);
  } else if (raiseFailed || unsubscribed || RESOLUTION.includes(c.state)) set(draw, 'not_applicable', 'not_applicable');
  else if (drawOver) set(draw, 'not_applicable', 'blocked', { blocker: 'draw_deadline_passed' });
  else if (!c.finalized) {
    const later = subscriptionsOpen || fund.status === 'finalize_required' || ['Paused', 'Frozen'].includes(c.state);
    set(draw, later ? 'pending' : 'not_applicable', later ? 'waiting' : 'not_applicable', later ? { blocker: 'funding_not_finalized' } : {});
  } else if (c.state === 'Frozen') set(draw, 'pending', 'blocked', { blocker: 'state_frozen' });
  else if (c.state === 'Paused') set(draw, 'pending', 'blocked', { blocker: 'state_paused' });
  else if (drawRisk) set(draw, 'pending', 'blocked', { blocker: drawRisk, blockers: drawSources.blockers });
  else set(draw, 'pending', unknownDrawRisk || c.drawDeadline == null ? 'unknown' : 'actionable');

  // Repayment exists only once something was drawn; until then it waits for the draw or never applies.
  if (!c.disbursed) {
    const later = ['actionable', 'waiting', 'unknown'].includes(draw.phase) || draw.phase === 'blocked' && draw.blocker !== 'draw_deadline_passed';
    set(repay, later ? 'pending' : 'not_applicable', later ? 'waiting' : 'not_applicable', later ? { blocker: 'not_disbursed' } : {});
  } else if (RESOLUTION.includes(c.state)) set(repay, 'resolution', 'actionable');
  else set(repay, 'pending', 'actionable');

  // Exits: refunds of a failed raise, the deterministic exits anyone may start, or waiting for settlement.
  if (raiseFailed) set(exit, 'refund_available', 'actionable', { next: 'refund' });
  else if (unsubscribed && ['Open', 'Repriced', 'Paused', 'Frozen', 'Liquidation'].includes(c.state)) {
    // v4: anyone's startExit cancels it unless the pool is frozen; the operator's cancellation works either way.
    const anyone = c.controlVersion >= 4 && c.state !== 'Frozen';
    exit.roles = anyone ? EXIT_ROLES : CANCEL_ROLES;
    set(exit, 'exit_available', 'actionable', { next: anyone ? 'start_exit' : 'cancel_offering' });
  } else if (c.subscribed && !c.disbursed && drawOver && c.metMinimum === true && c.controlVersion >= 2) {
    // The one exit a freeze does not stop: undrawn principal closes as repaid after the draw deadline.
    exit.roles = EXIT_ROLES;
    set(exit, 'exit_available', 'actionable', { next: 'start_exit' });
  } else if (c.disbursed && c.matured && !RESOLUTION.includes(c.state)) {
    // At maturity anyone's startExit closes a cash-covered pool as repaid or turns a real shortfall into default; a
    // frozen pool can only take the default path, so with no debt left it waits for governance to unfreeze it.
    exit.roles = EXIT_ROLES;
    if (c.state === 'Frozen' && c.outstanding === 0n) set(exit, 'pending', 'blocked', { blocker: 'state_frozen' });
    else set(exit, 'exit_available', c.state === 'Frozen' && c.outstanding == null ? 'unknown' : 'actionable', { next: 'start_exit' });
  } else if (RESOLUTION.includes(c.state)) set(exit, 'check_refund_or_wait', 'waiting', { blocker: 'resolution_pending' });
  else set(exit, 'check_refund_or_wait', 'waiting');
  for (const step of [fund, exit]) step.assigned_to_you = step.roles.some((role) => roles.includes(role));
  // Enrollment here never grants the on-chain role the contract demands of the acting wallet. A step this caller is enrolled
  // for but whose wallet lacks that role is not theirs to do now, however clear the pool is; another wallet's role may be fine.
  for (const [id, role] of Object.entries(CALLER_ROLE)) {
    const step = steps.find((item) => item.id === id);
    if (step?.phase === 'actionable' && step.assigned_to_you && c.callerRoles?.[role] === false) Object.assign(step, { caller_blocker: 'caller_role_missing', caller_role: role });
  }
  // A state the reader should see before the step list.
  if (['Frozen', 'Paused'].includes(c.state)) result.state_notice = c.state === 'Frozen' ? 'state_frozen' : 'state_paused';
}

/** Workflow observations are hints. Each wallet operation still executes a fresh
 * contract preflight, and a missing observation never means a step succeeded. */
export async function materialWorkflow(chain, principal, record, pack, published, approvals, readPool = new RpcReadPool()) {
  const result = { material_id: record.material_id, revision: record.revision, document_hash: record.document_hash,
    terms_hash: record.public_summary.terms_hash, approvals, published: Boolean(published), steps: WORKFLOW_STEPS.map((step, index) => ({ ...step,
      status: index === 0 ? 'complete' : 'unknown', assigned_to_you: step.roles.some((role) => principal.roles.includes(role)) })),
    disclosure: pack ?? null, business_enabled: false, snapshot: null, pool_id: null, state: null };
  result.steps[2].status = published && approvals >= 2 ? 'complete' : 'pending';
  if (!chain || !pack) {
    result.warning = !chain ? 'rights_chain_not_configured' : 'financing_disclosure_missing';
    phasesBeforeIssue(result.steps, pack);
    return result;
  }
  const { read, stats } = readPool.budget(140);
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
    if (!issued) phasesBeforeIssue(result.steps, pack);
    if (issued) {
      result.steps[3].status = 'complete';
      phasesBeforeIssue(result.steps, pack);
      const optional = (contract, method, ...args) => typeof contract?.[method] === 'function' ? read(() => contract[method](...args, at)) : Promise.resolve(null);
      const [offer, disbursed, recovery, screening, finalized, deadline, intakeStopped, valuation] = await Promise.all([
        read(() => chain.pool.offerings(poolId, at)), read(() => chain.pool.disbursedAtomic(poolId, at)),
        read(() => chain.pool.recoveredAtomic(poolId, at)), readScreening(chain, binding?.control_version, read, at),
        read(() => chain.pool.fundingFinalized(poolId, at)), read(() => chain.pool.subscriptionDeadline(poolId, at)),
        optional(chain.controller, 'intakeStopped'), optional(chain.controller, 'valuations', poolId) ]);
      result.pool_id = Number(poolId); result.state = chainStateName(offer.state); result.funding_finalized = Boolean(finalized);
      // What disburse() and isEligible() also read besides the screening: the valuer's role, the title and the settlement asset,
      // and the wallet's own on-chain roles. All from the block above, so they cannot disagree with each other.
      const running = !TERMINAL.includes(result.state);
      const [valuer, titleActive, assetAllowed, callerRoles] = await Promise.all([
        running ? optional(chain.controller, 'valuer', poolId) : null, running ? optional(chain.registry, 'isActive', eblId) : null,
        running ? optional(chain.controller, 'testAsset', offer.settlementAsset) : null,
        Promise.all(ONCHAIN_ROLES.map(async (role) => [role, await read(() => chain.controller.roles(id(role.toUpperCase()), principal.wallet, at))])).then(Object.fromEntries) ]);
      const valuerActive = valuer == null ? null : ZERO_ADDRESS.test(valuer) ? false : Boolean(await read(() => chain.controller.roles(id('VALUER'), valuer, at)));
      // Eligibility also needs the screening's signer to still hold COMPLIANCE (the controller's isEligible()).
      const screeningUnknown = screening.valid_until == null || binding?.control_version === CONTROL_VERSION && screening.attestor_active == null;
      const screeningLapsed = !screeningUnknown && Number(screening.valid_until) < block.timestamp;
      result.steps[5].status = screeningUnknown ? 'unknown' : !screeningLapsed && screening.attestor_active !== false ? 'check_each_investor' : 'pending';
      // The compliance task's own reason is the screening part of the shared conditions (sources.js), so it reads the same everywhere.
      const screeningReason = controllerSourceBlockers({ now: block.timestamp, screeningValidUntil: screeningUnknown ? null : screening.valid_until,
        screeningActive: screening.attestor_active }).blockers[0];
      if (screeningReason) result.steps[5].blocker = screeningReason;
      // Reaching the minimum is not funding: a partial raise is closed by finalizeFunding() after the deadline, and only
      // a finalized raise can be drawn. A full raise finalizes itself on its last subscription.
      const closable = !finalized && offer.subscribed > 0n && offer.raisedAtomic >= BigInt(pack.terms.minRaise)
        && Number(deadline) < block.timestamp && [2, 3, 6].includes(Number(offer.state));
      result.steps[6].status = finalized ? 'complete' : closable ? 'finalize_required' : 'pending';
      if (closable) {
        Object.assign(result.steps[6], { next: 'finalize_funding', roles: FINALIZE_ROLES });
        result.steps[6].assigned_to_you = result.steps[6].roles.some((role) => principal.roles.includes(role));
      }
      // Provisional: a running pool's phases below decide whether a first draw leaves the step open (partial) or finished.
      result.steps[7].status = disbursed > 0n ? 'complete' : 'pending';
      result.steps[8].status = [9, 14].includes(Number(offer.state)) ? 'complete' : 'pending';
      result.steps[9].status = [9, 14].includes(Number(offer.state)) ? 'claim_available' : 'check_refund_or_wait';
      if (TERMINAL.includes(result.state)) {
        // Terminal pools never ask for new eligibility, subscriptions, draws or debt that never existed.
        result.steps[5].status = 'not_applicable'; delete result.steps[5].blocker;
        result.steps[6].status = finalized ? 'complete' : 'not_applicable';
        result.steps[7].status = disbursed > 0n ? 'complete' : 'not_applicable';
        result.steps[8].status = disbursed > 0n ? 'complete' : 'not_applicable';
        const refundable = result.state === 'Cancelled';
        const available = await read(() => refundable
          ? chain.pool.investorPaid(poolId, offer.settlementAsset, principal.wallet, at)
          : chain.pool.claimable(poolId, principal.wallet, at));
        result.steps[9].status = available > 0n ? (refundable ? 'refund_available' : 'claim_available') : 'complete';
        result.steps[9].next = available > 0n ? (refundable ? 'refund' : 'claim') : null;
        result.exit_available_atomic = String(available);
        for (const step of result.steps.slice(5)) step.phase = phaseOf(step.status) ?? 'actionable';
      } else {
        const terms = pack.terms, minRaise = offer.minRaise ?? (terms.minRaise == null ? null : BigInt(terms.minRaise));
        const supply = offer.tokenSupply ?? (terms.supply == null ? null : BigInt(terms.supply));
        const matured = terms.maturity == null ? null : block.timestamp >= Number(terms.maturity);
        const outstanding = offer.subscribed > 0n && disbursed > 0n && matured && typeof chain.pool.outstandingDebt === 'function'
          ? await read(() => chain.pool.outstandingDebt(poolId, at)).catch(() => null) : null;
        // A screening that cannot be read whole is unknown, never assumed open; earlier controls have no signer slot to read.
        const sources = { now: block.timestamp, intakeStopped: intakeStopped == null ? null : Boolean(intakeStopped),
          screeningValidUntil: screeningUnknown ? null : screening.valid_until,
          screeningActive: binding?.control_version === CONTROL_VERSION ? screening.attestor_active : screening.attestor_active ?? true,
          valuationValidUntil: valuation?.validUntil ?? null, valuerActive,
          titleActive: titleActive == null ? null : Boolean(titleActive), assetAllowed: assetAllowed == null ? null : Boolean(assetAllowed) };
        phasesWhileRunning(result, result.steps, { state: result.state, now: block.timestamp, controlVersion: binding?.control_version ?? CONTROL_VERSION,
          finalized: Boolean(finalized), subscribed: offer.subscribed > 0n, full: supply != null && offer.subscribed >= supply,
          metMinimum: minRaise == null ? null : offer.raisedAtomic >= minRaise, deadlinePassed: Number(deadline) < block.timestamp,
          disbursed: disbursed > 0n, raised: offer.raisedAtomic, drawn: disbursed, drawDeadline: terms.disburseUntil == null ? null : Number(terms.disburseUntil), matured, outstanding,
          sources, callerRoles }, principal.roles);
      }
      for (const step of result.steps) if (['complete', 'not_applicable'].includes(step.status)) step.next = null;
      result.amounts = { raised_atomic: String(offer.raisedAtomic), disbursed_atomic: String(disbursed), recovered_atomic: String(recovery) };
      if (finalized) result.amounts.undrawn_atomic = String(offer.raisedAtomic > disbursed ? offer.raisedAtomic - disbursed : 0n);
      result.onchain_roles = callerRoles;
    }
    await assertSnapshot(chain.provider, block, read); result.snapshot = snapshotInfo(block); result.read_metrics = stats;
  } catch {
    // Discard every optimistic chain observation when any read or canonical check fails.
    for (const step of result.steps) if (!['document', 'terms'].includes(step.id)) {
      step.status = 'unknown'; step.phase = 'unknown';
      for (const key of ['blocker', 'blockers', 'caller_blocker', 'caller_role', 'drawn_atomic', 'remaining_atomic']) delete step[key];
    }
    result.steps[0].phase = 'complete'; result.steps[2].phase = result.steps[2].status === 'complete' ? 'complete' : 'actionable';
    result.pool_id = null; result.state = null; delete result.amounts; delete result.onchain_roles; delete result.exit_available_atomic; delete result.state_notice;
    result.warning = 'workflow_chain_unavailable';
  }
  return result;
}
