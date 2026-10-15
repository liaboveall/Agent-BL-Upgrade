// Agent events (docs/agent-implementation-plan.md §4.3). Every input to the agent runtime -- an
// uploaded document, a world-risk change, an insurance deadline, a payment proof, a chain log -- is
// normalised into one validated shape before it is queued, so the rest of the runtime never has to
// guess what it was given. Event data is untrusted: it can carry values, never instructions.

import { z } from 'zod';
import { evidenceMetadata, SOURCE_STATUSES } from './freshness.js';
import { hashSnapshot } from '../decisionLogger.js';
import { eventIdempotencyKey } from '../executionReliability.js';

export const EVENT_TYPES = Object.freeze([
  'DOCUMENTS_INGESTED', 'EBL_MINTED', 'OFFERING_CREATED',
  'WORLD_RISK_UPDATED', 'RISK_CLEARED',
  'INSURANCE_EXPIRING', 'INSURANCE_EXPIRED',
  'CARGO_DEPARTED', 'CARGO_ARRIVED',
  'PAYMENT_RECEIVED', 'SUBSCRIPTION_RECEIVED', 'SETTLEMENT_READY',
  'CHAIN_STATE_CHANGED', 'EMERGENCY_STOP_CHANGED', 'REVIEW_RESOLVED'
]);

export const EVENT_SOURCES = Object.freeze(['ingest', 'world-risk-monitor', 'voyage-monitor', 'chain-watcher', 'scenario', 'admin', 'agent']);
export const SOURCE_MODES = Object.freeze(['live', 'fixture', 'demo']);

const HASH_RE = /^0x[0-9a-f]{64}$/u;
const isoDate = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'must be an ISO date-time');
const proof = z.string().min(1).max(300);
const repayment = z.union([z.number().positive().finite(), z.string().max(85).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u)]);
const looseData = (shape = {}) => z.looseObject(shape);

// Per-type payloads. Unknown extra keys are kept (loose) but the keys the pipelines rely on are checked.
const DATA_SCHEMAS = {
  DOCUMENTS_INGESTED: looseData({ job_id: z.string().max(128).optional(), document_ids: z.array(z.string().max(200)).max(50).optional() }),
  EBL_MINTED: looseData(),
  OFFERING_CREATED: looseData(),
  WORLD_RISK_UPDATED: looseData({
    events: z.array(z.looseObject({ severity: z.string().max(32).optional() })).max(200).optional()
  }),
  RISK_CLEARED: looseData(),
  INSURANCE_EXPIRING: looseData({ expires_at: isoDate.optional(), days_left: z.number().min(0).optional() }),
  INSURANCE_EXPIRED: looseData({ expired_at: isoDate.optional() }),
  CARGO_DEPARTED: looseData({ departure_proof: proof.optional() }),
  CARGO_ARRIVED: looseData({ arrival_proof: proof.optional(), payment_received: z.boolean().optional() }),
  PAYMENT_RECEIVED: looseData({
    payment_proof: proof,
    repayment_amount: repayment,
    proof_source: z.string().max(64).optional()
  }),
  SUBSCRIPTION_RECEIVED: looseData({ amount_usd: z.number().positive().finite().optional() }),
  SETTLEMENT_READY: looseData({ repayment_amount: repayment }),
  CHAIN_STATE_CHANGED: looseData(),
  EMERGENCY_STOP_CHANGED: looseData({ stopped: z.boolean() }),
  REVIEW_RESOLVED: looseData({ resolution: z.enum(['approve', 'reject']).optional(), approval_id: z.string().max(128).optional() })
};

const eventSchema = z.object({
  event_id: z.string().min(1).max(200).optional(),
  type: z.enum(EVENT_TYPES),
  case_id: z.string().min(1).max(128),
  pool_id: z.string().min(1).max(128).optional(),
  chain_pool_id: z.number().int().positive().optional(),
  occurred_at: isoDate.optional(),
  observed_at: isoDate.optional(),
  expires_at: isoDate.optional(),
  source_status: z.enum(SOURCE_STATUSES).optional(),
  source: z.enum(EVENT_SOURCES),
  source_mode: z.enum(SOURCE_MODES).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  evidence_hash: z.string().regex(HASH_RE).optional()
});

export class EventValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'EventValidationError';
    this.code = 'invalid_event';
    this.status = 400;
    this.expose = true;
    this.issues = issues;
  }
}

function describe(error) {
  return error.issues.map((issue) => `${issue.path.join('.') || '(event)'}: ${issue.message}`);
}

/**
 * Validate and complete a raw event. Fills `occurred_at`/`observed_at` (from `now`), `source_mode`
 * (from `defaultMode`) and, when absent, a content-derived `event_id` -- so two submissions of the
 * same occurrence collapse into one, while a different occurrence never does.
 * @returns {object} the normalised event, including `idempotency_key`
 */
export function normalizeEvent(raw, { now = () => new Date(), defaultMode = 'demo' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EventValidationError('event must be an object');
  }
  const base = eventSchema.safeParse(raw);
  if (!base.success) throw new EventValidationError(`Invalid event: ${describe(base.error).join('; ')}`, describe(base.error));
  const event = base.data;

  const dataResult = DATA_SCHEMAS[event.type].safeParse(event.data ?? {});
  if (!dataResult.success) {
    throw new EventValidationError(`Invalid ${event.type} data: ${describe(dataResult.error).join('; ')}`, describe(dataResult.error));
  }

  const observedAt = event.observed_at ?? now().toISOString();
  const occurredAt = event.occurred_at ?? observedAt;
  const normalized = {
    ...event,
    data: dataResult.data,
    occurred_at: occurredAt,
    ...evidenceMetadata({ ...event, observed_at: observedAt }, { now: now().getTime(), mode: event.source_mode ?? defaultMode }),
    source_mode: event.source_mode ?? defaultMode
  };
  normalized.event_id = event.event_id
    ?? `evt_${hashSnapshot({
      type: normalized.type,
      case_id: normalized.case_id,
      pool_id: normalized.pool_id ?? null,
      occurred_at: normalized.occurred_at,
      source: normalized.source,
      data: normalized.data
    }).slice(2, 22)}`;
  normalized.idempotency_key = eventIdempotencyKey(normalized);
  return normalized;
}
