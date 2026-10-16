// Policy engine (docs/agent-implementation-plan.md §4.5). A pure function: given what the agent wants
// to do and the situation around it, decide whether that may happen unattended, needs a human, is
// only recorded, or is refused. The LLM never reaches this decision; it only sees the outcome.
//
// Rules run in order. `verdict` is the first rule that matches; `reasons` lists every rule that
// matched so the UI can say, e.g., "Live requires approval; price move above the cap".

export const AGENT_ACTIONS = Object.freeze([
  'OPEN', 'OPEN_WITH_WARNING', 'HOLD_FOR_REVIEW', 'REJECT',
  'REPRICE', 'PAUSE', 'RESUME', 'WARNING',
  'MARK_IN_TRANSIT', 'RECORD_PAYMENT', 'RECORD_ARRIVAL',
  'SETTLE', 'FREEZE', 'LIQUIDATE', 'CANCEL'
]);

/** Actions that cannot be undone on-chain. */
export const IRREVERSIBLE_ACTIONS = Object.freeze(['SETTLE', 'FREEZE', 'LIQUIDATE', 'CANCEL']);
/** Actions that change nothing on a pool: they are records, so they never wait for approval. */
export const INFORMATIONAL_ACTIONS = Object.freeze(['WARNING', 'HOLD_FOR_REVIEW', 'REJECT']);
/** Actions a protected pool (the standing Live demo pool) must never receive. */
export const PROTECTED_POOL_BLOCKED_ACTIONS = IRREVERSIBLE_ACTIONS;

export const POLICY_VERDICTS = Object.freeze(['AUTO', 'NEEDS_APPROVAL', 'OBSERVE_ONLY', 'REJECTED']);

export const POLICY_RULES = Object.freeze([
  'CHAIN_OBSERVATION_UNAVAILABLE',
  'EMERGENCY_STOP',
  'PROTECTED_POOL',
  'AUTONOMY',
  'UNSAFE_FINDING',
  'LLM_ONLY_SIGNAL',
  'COOLDOWN',
  'LIVE_REQUIRES_APPROVAL',
  'INFORMATIONAL',
  'STALE_EVIDENCE',
  'IRREVERSIBLE',
  'PRICE_GUARD',
  'AUTONOMY_LEVEL'
]);

const BLOCKING_FINDINGS = new Set(['COMPLIANCE_BLOCK']);
const REVIEW_FINDINGS = new Set(['PROMPT_INJECTION_SUSPECTED', 'COMPLIANCE_REVIEW']);

const DEFAULT_THRESHOLDS = Object.freeze({
  maxPriceMoveBps: 200,
  cooldownSec: 600,
  maxActionsPerPoolPerDay: 12,
  allowUnattendedIrreversible: false
});

function directionOf(action) {
  // Cooldown is about repeating the same move on a pool, so the action itself is the direction.
  return action;
}

/**
 * @param {object} proposal
 * @param {string} proposal.action              one of AGENT_ACTIONS
 * @param {string} [proposal.pool_id]
 * @param {Array<{kind:string}>} [proposal.findings]
 * @param {boolean} [proposal.llm_only]         true when no deterministic evidence backs the signal
 * @param {number} [proposal.price_move_bps]    absolute size of a price change, in basis points
 * @param {number} [proposal.new_issue_price_usd]
 * @param {object} ctx
 * @param {'demo'|'live'} ctx.mode
 * @param {'off'|'observe'|'propose'|'auto'} ctx.autonomy  the EFFECTIVE autonomy (see effectiveAutonomy)
 * @param {boolean} [ctx.protectedPool]
 * @param {boolean} [ctx.emergencyStopped]
 * @param {boolean} [ctx.evidenceStale]
 * @param {Array<{action:string, at:string|number}>} [ctx.recentActions]  this pool's earlier agent actions
 * @param {number} [ctx.now]                     epoch ms
 * @param {{min_acceptable_issue_price?:number}} [ctx.exporterPreferences]
 * @param {object} [ctx.thresholds]
 * @returns {{ verdict: string, reasons: Array<{rule:string, verdict:string, message:string}>, action: string,
 *             action_override: string|null, autonomy: string, mode: string }}
 */
export function evaluatePolicy(proposal, ctx) {
  const action = proposal?.action;
  if (!AGENT_ACTIONS.includes(action)) throw new RangeError(`Unknown agent action: ${String(action)}`);
  if (!['demo', 'live'].includes(ctx?.mode)) throw new RangeError('ctx.mode must be demo or live');
  const autonomy = ctx.autonomy;
  if (!['off', 'observe', 'propose', 'auto'].includes(autonomy)) throw new RangeError('ctx.autonomy is invalid');
  const t = { ...DEFAULT_THRESHOLDS, ...(ctx.thresholds ?? {}) };
  const findings = Array.isArray(proposal.findings) ? proposal.findings : [];
  const now = ctx.now ?? Date.now();

  const hits = [];
  const hit = (rule, verdict, message, extra = {}) => hits.push({ rule, verdict, message, ...extra });
  const informational = INFORMATIONAL_ACTIONS.includes(action);

  if (ctx.mode === 'live' && ctx.chainObservationUnavailable && !informational) {
    hit('CHAIN_OBSERVATION_UNAVAILABLE', 'REJECTED', 'Confirmed chain monitoring is unavailable or still syncing.');
  }

  // 1. Emergency stop: nothing may run except a PAUSE (which only reduces exposure). Pure records
  //    (warnings) change nothing, so an emergency stop does not hide them.
  if (ctx.emergencyStopped && action !== 'PAUSE' && !informational) {
    hit('EMERGENCY_STOP', 'REJECTED', 'Emergency stop is active; only PAUSE is allowed.');
  }

  // 2. The protected pool keeps the standing Live demo reusable: no terminal state, ever.
  if (ctx.protectedPool && PROTECTED_POOL_BLOCKED_ACTIONS.includes(action)) {
    hit('PROTECTED_POOL', 'REJECTED', `${action} is never proposed for a protected pool.`);
  }

  // 3. Autonomy switch.
  if (autonomy === 'off') hit('AUTONOMY', 'REJECTED', 'Agent autonomy is off.');
  else if (autonomy === 'observe') hit('AUTONOMY', 'OBSERVE_ONLY', 'Agent is in observe-only mode.');

  // 4. Findings that make the input untrustworthy or non-compliant change what the agent may do.
  const blocking = findings.find((finding) => BLOCKING_FINDINGS.has(finding?.kind));
  const review = findings.find((finding) => REVIEW_FINDINGS.has(finding?.kind));
  if (blocking) {
    hit('UNSAFE_FINDING', 'REJECTED', `Compliance blocked this case (${blocking.kind}).`, { action_override: 'REJECT' });
  } else if (review) {
    hit('UNSAFE_FINDING', 'NEEDS_APPROVAL', `A reviewer must look first (${review.kind}).`, { action_override: 'HOLD_FOR_REVIEW' });
  }

  // 5. A signal produced only by a model, without deterministic evidence, is recorded but not acted on.
  if (proposal.llm_only) {
    hit('LLM_ONLY_SIGNAL', 'OBSERVE_ONLY', 'The signal has no deterministic evidence behind it.');
  }

  // 6. Debounce: same move on the same pool inside the cooldown, or too many moves today.
  const recent = Array.isArray(ctx.recentActions) ? ctx.recentActions : [];
  const cooldownMs = Math.max(0, t.cooldownSec) * 1000;
  const repeated = recent.find((past) => directionOf(past.action) === directionOf(action)
    && now - Date.parse(past.at) < cooldownMs && now - Date.parse(past.at) >= 0);
  if (repeated) {
    hit('COOLDOWN', 'OBSERVE_ONLY', `The same action ran on this pool ${Math.round((now - Date.parse(repeated.at)) / 1000)}s ago (cooldown ${t.cooldownSec}s).`);
  }
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const today = recent.filter((past) => Date.parse(past.at) >= dayAgo).length;
  if (today >= t.maxActionsPerPoolPerDay) {
    hit('COOLDOWN', 'OBSERVE_ONLY', `This pool already had ${today} agent actions in 24h (limit ${t.maxActionsPerPoolPerDay}).`);
  }

  // An action that changes nothing is just recorded: there is nothing for a human to approve.
  if (informational) {
    hit('INFORMATIONAL', 'AUTO', `${action} changes no state; it is recorded without approval.`);
  }

  // 7. Live: a human approves every action that does something (D1).
  if (ctx.mode === 'live' && !informational) {
    hit('LIVE_REQUIRES_APPROVAL', 'NEEDS_APPROVAL', 'Live mode: every action needs human approval.');
  }

  // 8. Stale evidence downgrades to approval and is flagged.
  if (ctx.evidenceStale && !informational) {
    hit('STALE_EVIDENCE', 'NEEDS_APPROVAL', 'Key evidence is stale (data too old to act on unattended).');
  }

  // 9. Irreversible or money-sensitive actions. The unattended exemption exists for Demo only.
  const sensitive = IRREVERSIBLE_ACTIONS.includes(action) || action === 'RECORD_PAYMENT';
  if (sensitive && !(ctx.mode === 'demo' && t.allowUnattendedIrreversible)) {
    hit('IRREVERSIBLE', 'NEEDS_APPROVAL', `${action} is irreversible or money-sensitive; it needs approval.`);
  }

  // 10. Price guard: too large a move, or below the exporter's floor.
  if (Number.isFinite(proposal.price_move_bps) && proposal.price_move_bps > t.maxPriceMoveBps) {
    hit('PRICE_GUARD', 'NEEDS_APPROVAL', `Price move of ${proposal.price_move_bps} bps exceeds the ${t.maxPriceMoveBps} bps limit.`);
  }
  const floor = Number(ctx.exporterPreferences?.min_acceptable_issue_price);
  if (Number.isFinite(floor) && Number.isFinite(proposal.new_issue_price_usd) && proposal.new_issue_price_usd < floor) {
    hit('PRICE_GUARD', 'NEEDS_APPROVAL', `New price ${proposal.new_issue_price_usd} is below the exporter's minimum ${floor}.`);
  }

  // 11. Autonomy level decides what is left.
  if (!informational) {
    if (autonomy === 'propose') hit('AUTONOMY_LEVEL', 'NEEDS_APPROVAL', 'Autonomy is propose: a human approves.');
    else if (autonomy === 'auto') hit('AUTONOMY_LEVEL', 'AUTO', 'Autonomy is auto.');
  }

  const first = hits[0];
  return {
    verdict: first.verdict,
    reasons: hits.map(({ rule, verdict, message }) => ({ rule, verdict, message })),
    action,
    action_override: hits.find((h) => h.action_override)?.action_override ?? null,
    autonomy,
    mode: ctx.mode
  };
}
