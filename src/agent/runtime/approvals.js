// Approval queue (docs/agent-implementation-plan.md WP1.3). In Live this is the only way an agent
// decision becomes an action: every proposal waits here for a human.
//
//   PENDING ──approve──► APPROVED ──(server can sign)──► EXECUTED | FAILED
//      │                     └──(owner must sign)──────► AWAITING_OWNER_SIGNATURE ──► EXECUTED | FAILED
//      ├──reject──► REJECTED
//      └──ttl─────► EXPIRED
//
// This class is only the state machine and its persistence; deciding who executes an approved
// action, and doing it, is the service's job.

import crypto from 'node:crypto';
import { readPrivateJson, writePrivateJson } from '../security/privateStore.js';
import { createWriteQueue } from '../../lib/jsonStore.js';

export const APPROVAL_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  AWAITING_OWNER_SIGNATURE: 'AWAITING_OWNER_SIGNATURE',
  EXECUTED: 'EXECUTED',
  FAILED: 'FAILED'
});

const S = APPROVAL_STATUS;
const TRANSITIONS = {
  [S.PENDING]: [S.APPROVED, S.REJECTED, S.EXPIRED],
  [S.APPROVED]: [S.AWAITING_OWNER_SIGNATURE, S.EXECUTED, S.FAILED],
  [S.AWAITING_OWNER_SIGNATURE]: [S.EXECUTED, S.FAILED, S.EXPIRED],
  [S.REJECTED]: [],
  [S.EXPIRED]: [],
  [S.EXECUTED]: [],
  [S.FAILED]: []
};

export const TERMINAL_APPROVAL_STATUSES = Object.freeze([S.REJECTED, S.EXPIRED, S.EXECUTED, S.FAILED]);

export class ApprovalError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

export class ApprovalQueue {
  /**
   * @param {{file?: string|null, now?: ()=>Date, ttlSec?: number, maxRecords?: number}} [options]
   */
  constructor({ file = null, now = () => new Date(), ttlSec = 24 * 60 * 60, maxRecords = 2000 } = {}) {
    this.file = file;
    this.now = now;
    this.ttlSec = ttlSec;
    this.maxRecords = maxRecords;
    this.records = new Map();
    this.enqueueWrite = createWriteQueue();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    if (this.file) {
      const saved = await readPrivateJson(this.file, null);
      for (const record of saved?.approvals ?? []) this.records.set(record.approval_id, record);
    }
    this.initialized = true;
    return this;
  }

  async #persist() {
    if (!this.file) return;
    const snapshot = { version: 1, approvals: [...this.records.values()] };
    await this.enqueueWrite(() => writePrivateJson(this.file, snapshot));
  }

  async pruneRetention({ now, retentionDays, protectedDecisions }) {
    const cutoff = now - retentionDays * 86400000;
    for (const [id, record] of this.records) {
      if (TERMINAL_APPROVAL_STATUSES.includes(record.status) && !protectedDecisions.has(record.decision_id) && Date.parse(record.updated_at) < cutoff) this.records.delete(id);
    }
    this.#prune();
    await this.#persist();
  }

  #prune() {
    if (this.records.size <= this.maxRecords) return;
    const finished = [...this.records.values()]
      .filter((record) => TERMINAL_APPROVAL_STATUSES.includes(record.status))
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
    for (const record of finished) {
      if (this.records.size <= this.maxRecords) break;
      this.records.delete(record.approval_id);
    }
  }

  /**
   * Open an approval for a decision. There is at most one open approval per decision: asking again
   * returns the existing one, so a replayed event cannot pile up proposals.
   * @param {object} input
   * @param {string} input.decision_id
   * @param {string} input.route           'sim' | 'server' | 'owner_cli'
   * @param {object} [input.plan]          the transactions an owner has to sign (owner_cli)
   */
  async create({ decision_id: decisionId, route, case_id: caseId, pool_id: poolId, action, mode, summary, plan, ttlSec }) {
    await this.init();
    if (!decisionId) throw new TypeError('decision_id is required');
    if (!['sim', 'server', 'owner_cli', 'link'].includes(route)) throw new TypeError('route must be sim, server, owner_cli or link');
    const open = [...this.records.values()].find((record) => record.decision_id === decisionId
      && !TERMINAL_APPROVAL_STATUSES.includes(record.status));
    if (open) return structuredClone(open);

    const createdAt = this.now();
    const record = {
      approval_id: `appr_${crypto.randomBytes(8).toString('hex')}`,
      decision_id: decisionId,
      case_id: caseId ?? null,
      pool_id: poolId ?? null,
      action,
      mode,
      route,
      summary: summary ?? null,
      plan: plan ?? null,
      status: S.PENDING,
      created_at: createdAt.toISOString(),
      updated_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + (ttlSec ?? this.ttlSec) * 1000).toISOString(),
      decided_by: null,
      decided_at: null,
      note: null,
      steps_done: [],
      execution: null,
      error: null
    };
    this.records.set(record.approval_id, record);
    this.#prune();
    await this.#persist();
    return structuredClone(record);
  }

  get(id) {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  list({ status, case_id: caseId, decision_id: decisionId, limit = 100 } = {}) {
    let items = [...this.records.values()];
    if (status) items = items.filter((record) => record.status === status);
    if (caseId) items = items.filter((record) => record.case_id === caseId);
    if (decisionId) items = items.filter((record) => record.decision_id === decisionId);
    items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return structuredClone(items.slice(0, limit));
  }

  pendingCount() {
    return [...this.records.values()].filter((record) => record.status === S.PENDING).length;
  }

  #require(id) {
    const record = this.records.get(id);
    if (!record) throw new ApprovalError('approval_not_found', `Unknown approval ${id}`, 404);
    return record;
  }

  async #move(id, to, patch = {}) {
    const record = this.#require(id);
    if (!TRANSITIONS[record.status].includes(to)) {
      throw new ApprovalError('invalid_transition', `Approval ${id} is ${record.status}; it cannot become ${to}`);
    }
    Object.assign(record, patch, { status: to, updated_at: this.now().toISOString() });
    await this.#persist();
    return structuredClone(record);
  }

  /** Forget every approval of one mode (Demo reset). Live approvals are never touched. */
  async clearMode(mode) {
    await this.init();
    let changed = false;
    for (const [id, record] of [...this.records]) {
      if (record.mode === mode) { this.records.delete(id); changed = true; }
    }
    if (changed) await this.#persist();
  }

  /** Expire anything past its deadline. Call before reading or deciding. */
  async expireStale() {
    await this.init();
    const nowMs = this.now().getTime();
    const expired = [];
    for (const record of this.records.values()) {
      const verifiedAll = record.plan?.steps?.length > 0 && record.steps_done.length === record.plan.steps.length;
      if ([S.PENDING, S.AWAITING_OWNER_SIGNATURE].includes(record.status) && !verifiedAll && Date.parse(record.expires_at) <= nowMs) {
        record.status = S.EXPIRED;
        record.updated_at = this.now().toISOString();
        expired.push(structuredClone(record));
      }
    }
    if (expired.length) await this.#persist();
    return expired;
  }

  async approve(id, { by = 'admin', note = null } = {}) {
    await this.init();
    await this.expireStale();
    const record = this.#require(id);
    if (record.status === S.EXPIRED) throw new ApprovalError('approval_expired', `Approval ${id} expired at ${record.expires_at}`);
    return this.#move(id, S.APPROVED, { decided_by: by, decided_at: this.now().toISOString(), note });
  }

  async reject(id, { by = 'admin', note = null } = {}) {
    await this.init();
    await this.expireStale();
    const record = this.#require(id);
    if (record.status === S.EXPIRED) throw new ApprovalError('approval_expired', `Approval ${id} expired at ${record.expires_at}`);
    return this.#move(id, S.REJECTED, { decided_by: by, decided_at: this.now().toISOString(), note });
  }

  markAwaitingOwner(id) {
    return this.#move(id, S.AWAITING_OWNER_SIGNATURE);
  }

  markExecuted(id, execution) {
    return this.#move(id, S.EXECUTED, { execution: execution ?? null, error: null });
  }

  markFailed(id, error) {
    return this.#move(id, S.FAILED, { error: typeof error === 'string' ? { message: error } : { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 500) } });
  }

  /** Record one verified owner-signed step. Returns the record and whether every step is now done. */
  async recordStep(id, step) {
    await this.init();
    const record = this.#require(id);
    if (record.status !== S.AWAITING_OWNER_SIGNATURE) {
      throw new ApprovalError('invalid_transition', `Approval ${id} is ${record.status}; it is not waiting for an owner signature`);
    }
    if (record.steps_done.some((done) => done.index === step.index)) {
      throw new ApprovalError('step_already_recorded', `Step ${step.index} of ${id} is already recorded`);
    }
    const expectedIndex = record.steps_done.length;
    if (step.index !== expectedIndex) {
      throw new ApprovalError('step_out_of_order', `Step ${expectedIndex} must be recorded before step ${step.index}`);
    }
    record.steps_done.push(step);
    if (step.bindings && record.plan) record.plan.bindings = { ...record.plan.bindings, ...step.bindings };
    record.updated_at = this.now().toISOString();
    await this.#persist();
    const total = record.plan?.steps?.length ?? 0;
    return { approval: structuredClone(record), complete: record.steps_done.length >= total };
  }
}
