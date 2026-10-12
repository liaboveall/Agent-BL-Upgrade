// Monitor pipeline: turns one agent event into zero or more action PROPOSALS (docs/agent-
// implementation-plan.md §4.4). It decides WHAT the agent would do; whether that may run, needs a
// human or is only recorded is the policy engine's call, and doing it is the executor's.
//
// Everything here is deterministic: prices come from the pricing engine, risk from the world-risk
// scorer, and the same event on the same pool state always yields the same proposal. No LLM is
// involved, so nothing here can be steered by text inside an event.

import { createHash } from 'node:crypto';
import { hashSnapshot } from '../decisionLogger.js';
import { PAYOUT_SPEEDS } from '../../core/pricingSchema.js';
import { repriceWithWorldRisk } from '../../core/worldRiskPricing.js';
import { ACTIVE_STATES } from '../runtime/poolRules.js';

const SEVERITY_RANK = { info: 0, low: 1, medium: 2, warning: 2, high: 3, critical: 4 };
const FORCED_PAUSE_ACTIONS = new Set(['PAUSE_OFFERING', 'FREEZE_POOL', 'TRIGGER_LIQUIDATION']);

function maxSeverity(events) {
  let best = 'info';
  for (const event of events) {
    const level = String(event?.severity ?? 'info').toLowerCase();
    if ((SEVERITY_RANK[level] ?? 0) > (SEVERITY_RANK[best] ?? 0)) best = level;
  }
  return best;
}

function bps(from, to) {
  if (!(from > 0)) return 0;
  return Math.round((Math.abs(to - from) / from) * 10_000);
}

function demoProof(kind, event) {
  return `demo:${kind}:${createHash('sha256').update(event.event_id).digest('hex').slice(0, 12)}`;
}

/** The deterministic, timestamp-free description of what the agent looked at. */
export function snapshotOf(event, pool) {
  return {
    event_id: event.event_id,
    type: event.type,
    case_id: event.case_id,
    pool_id: event.pool_id ?? pool?.poolId ?? null,
    occurred_at: event.occurred_at,
    source: event.source,
    source_mode: event.source_mode,
    data_hash: hashSnapshot(event.data ?? {}),
    pool_state: pool?.status ?? null,
    quote_hash: pool?.quote?.quote_hash ?? null,
    issue_price_usd: pool?.quote?.final_issue_price_usd ?? null
  };
}

function proposal(event, pool, fields, steps = []) {
  return {
    action: fields.action,
    reasoning_summary: fields.reasoning_summary,
    params: fields.params ?? {},
    findings: fields.findings ?? [],
    price_move_bps: fields.price_move_bps,
    new_issue_price_usd: fields.new_issue_price_usd,
    evidence_hash: fields.evidence_hash ?? hashSnapshot(snapshotOf(event, pool)),
    quote_hash: fields.quote_hash ?? pool?.quote?.quote_hash ?? undefined,
    llm_only: fields.llm_only ?? false,
    pipeline: [{ step: 'event_validated', status: 'PASS', duration_ms: 0 }, ...steps],
    input_snapshot: snapshotOf(event, pool)
  };
}

const ignored = (reason) => ({ proposals: [], ignored: reason });

/**
 * @param {object} event  a normalised AgentEvent
 * @param {{pool: object|null, mode: 'demo'|'live', now?: ()=>number}} deps
 * @returns {{ proposals: object[], ignored?: string }}
 */
export function proposeFromEvent(event, { pool, mode, now = () => Date.now() }) {
  const needsPool = !['EMERGENCY_STOP_CHANGED', 'DOCUMENTS_INGESTED', 'EBL_MINTED', 'OFFERING_CREATED', 'REVIEW_RESOLVED'].includes(event.type);
  if (needsPool && !pool) return ignored(`No pool is known for case ${event.case_id}`);
  const active = pool ? ACTIVE_STATES.includes(pool.status === 'Open' && pool.subscribedUsd > 0 ? 'Subscribed' : pool.status) : false;

  switch (event.type) {
    case 'WORLD_RISK_UPDATED': {
      const worldEvents = Array.isArray(event.data?.events) ? event.data.events : [];
      const started = now();
      const speed = PAYOUT_SPEEDS.includes(pool.quote?.payout_speed) ? pool.quote.payout_speed : 'BALANCED';
      const repricing = repriceWithWorldRisk(pool.caseData, worldEvents, { payout_speed: speed });
      const after = repricing.after;
      const current = pool.quote;
      const severity = maxSeverity(worldEvents);
      const step = { step: 'world_risk_reprice', status: 'PASS', duration_ms: Math.max(0, now() - started) };
      const finding = {
        kind: 'WORLD_RISK',
        severity: severity === 'critical' ? 'critical' : severity === 'high' ? 'high' : severity === 'info' ? 'info' : 'warning',
        detail: `${worldEvents.length} world-risk event(s); risk ${current.risk_level} → ${after.risk_level}; price ${current.final_issue_price_usd} → ${after.final_issue_price_usd}`,
        evidence: after.evidence_hash
      };
      const forcedPause = severity === 'critical' || FORCED_PAUSE_ACTIONS.has(after.pricing_action);

      if (forcedPause) {
        if (pool.status === 'Paused') return ignored('The pool is already paused');
        if (!active) return ignored(`The pool is ${pool.status}; it cannot be paused`);
        return {
          proposals: [proposal(event, pool, {
            action: 'PAUSE',
            reasoning_summary: `World risk rose to ${after.risk_level} (${after.risk_score_bps} bps); the offering should pause.`,
            params: { quote: after },
            findings: [finding],
            evidence_hash: after.evidence_hash,
            quote_hash: after.quote_hash
          }, [step])]
        };
      }
      if (after.final_issue_price_usd < current.final_issue_price_usd) {
        if (!active) return ignored(`The pool is ${pool.status}; its price is not changed`);
        return {
          proposals: [proposal(event, pool, {
            action: 'REPRICE',
            reasoning_summary: `World risk added ${repricing.delta.risk_score_bps} bps and lowers the issue price from ${current.final_issue_price_usd} to ${after.final_issue_price_usd}.`,
            params: { quote: after },
            findings: [finding],
            price_move_bps: bps(current.final_issue_price_usd, after.final_issue_price_usd),
            new_issue_price_usd: after.final_issue_price_usd,
            evidence_hash: after.evidence_hash,
            quote_hash: after.quote_hash
          }, [step])]
        };
      }
      if (after.risk_level === current.risk_level && after.final_issue_price_usd === current.final_issue_price_usd) {
        return ignored('World risk did not change the quote');
      }
      return {
        proposals: [proposal(event, pool, {
          action: 'WARNING',
          reasoning_summary: 'World-risk evidence changed, but the pricing guardrails did not require a lower price.',
          params: { warning: 'WORLD_RISK_CHANGED' },
          findings: [finding],
          evidence_hash: after.evidence_hash
        }, [step])]
      };
    }

    case 'RISK_CLEARED': {
      if (pool.status !== 'Paused') return ignored(`The pool is ${pool.status}, not Paused; nothing to resume`);
      return {
        proposals: [proposal(event, pool, {
          action: 'RESUME',
          reasoning_summary: 'The blocking risk stayed below the threshold for the required number of checks; the pool may resume at its last verified quote.',
          params: { quote: pool.quote },
          findings: [{ kind: 'RISK_CLEARED', severity: 'info', detail: 'Risk below threshold after hysteresis' }]
        })]
      };
    }

    case 'INSURANCE_EXPIRING':
      return {
        proposals: [proposal(event, pool, {
          action: 'WARNING',
          reasoning_summary: `Insurance cover expires soon${Number.isFinite(event.data?.days_left) ? ` (${event.data.days_left} day(s) left)` : ''}; renew it before departure.`,
          params: { warning: 'INSURANCE_EXPIRING', days_left: event.data?.days_left },
          findings: [{ kind: 'INSURANCE_EXPIRING', severity: 'warning', detail: 'Cover expires within the warning window' }]
        })]
      };

    case 'INSURANCE_EXPIRED':
      if (pool.status === 'Paused') return ignored('The pool is already paused');
      return {
        proposals: [active
          ? proposal(event, pool, {
            action: 'PAUSE',
            reasoning_summary: 'Insurance expired while the offering is active; pause new exposure until cover is renewed.',
            params: { quote: pool.quote, warning: 'INSURANCE_EXPIRED' },
            findings: [{ kind: 'INSURANCE_EXPIRED', severity: 'high', detail: 'Cargo is uninsured while the offering is active' }]
          })
          : proposal(event, pool, {
            action: 'WARNING',
            reasoning_summary: 'Insurance expired outside an active financing state; recorded for review.',
            params: { warning: 'INSURANCE_EXPIRED' },
            findings: [{ kind: 'INSURANCE_EXPIRED', severity: 'warning', detail: 'Cover expired' }]
          })]
      };

    case 'CARGO_DEPARTED': {
      const proof = event.data?.departure_proof ?? (mode === 'demo' ? demoProof('departure', event) : null);
      if (!proof) return ignored('A departure_proof is required in Live mode');
      return {
        proposals: [proposal(event, pool, {
          action: 'MARK_IN_TRANSIT',
          reasoning_summary: 'The cargo has departed; the offering moves to InTransit.',
          params: { departure_proof: proof },
          findings: [{ kind: 'CARGO_DEPARTED', severity: 'info', detail: 'Departure recorded' }]
        })]
      };
    }

    case 'PAYMENT_RECEIVED':
      return {
        proposals: [proposal(event, pool, {
          action: 'RECORD_PAYMENT',
          reasoning_summary: `Importer payment of ${event.data.repayment_amount} was reported with proof; record it as settlement evidence.`,
          params: {
            payment_proof: event.data.payment_proof,
            repayment_amount: event.data.repayment_amount,
            proof_source: event.data.proof_source ?? null
          },
          findings: [{ kind: 'PAYMENT_RECEIVED', severity: 'info', detail: `Proof source: ${event.data.proof_source ?? 'unspecified'}` }]
        })]
      };

    case 'CARGO_ARRIVED': {
      const proof = event.data?.arrival_proof ?? (mode === 'demo' ? demoProof('arrival', event) : null);
      if (!proof) return ignored('An arrival_proof is required in Live mode');
      return {
        proposals: [proposal(event, pool, {
          action: 'RECORD_ARRIVAL',
          reasoning_summary: 'The cargo has arrived; record the arrival proof. Settlement is proposed separately once both proofs exist.',
          params: { arrival_proof: proof },
          findings: [{ kind: 'CARGO_ARRIVED', severity: 'info', detail: 'Arrival recorded' }]
        })]
      };
    }

    case 'SUBSCRIPTION_RECEIVED':
    case 'CHAIN_STATE_CHANGED':
      return ignored(`${event.type} is informational for the monitor pipeline`);

    default:
      return ignored(`${event.type} is not handled by the monitor pipeline`);
  }
}
