// AI-16 — persistent, deterministic decision audit log.
//
// Stores input snapshots, concise reasoning summaries, evidence hashes,
// decisions and transaction receipts. It deliberately does not store hidden
// chain-of-thought. Writes are serialized and atomically replace the JSON file.

import crypto from 'node:crypto';
import path from 'node:path';
import { sanitizeAudit, stripSecretFields, sealRecords, openRecords } from './security/privacy.js';
import fs from 'node:fs/promises';
import { createWriteQueue, writeFileAtomic } from '../lib/jsonStore.js';
import { runtimePath } from '../runtimePaths.js';

const DEFAULT_LOG_PATH = runtimePath('agent-decisions.json');
const HASH_RE = /^0x[0-9a-f]{64}$/u;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, canonicalize(value[key])]));
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashSnapshot(value) {
  return `0x${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function createDecisionId(decision = {}) {
  const identity = {
    idempotency_key: decision.idempotency_key ?? null,
    event_id: decision.event_id ?? null,
    event_type: decision.event_type ?? null,
    case_id: decision.case_id ?? null,
    pool_id: decision.pool_id ?? null,
    action: decision.action ?? decision.decision?.action ?? null,
    input_snapshot: decision.input_snapshot ?? null,
    evidence_hash: decision.evidence_hash ?? null
  };
  return `decision_${hashSnapshot(identity).slice(2, 26)}`;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('decision must be an object');
  if (!record.case_id || typeof record.case_id !== 'string') throw new TypeError('decision.case_id is required');
  if (!record.action || typeof record.action !== 'string') throw new TypeError('decision.action is required');
  if (!record.reasoning_summary || typeof record.reasoning_summary !== 'string') {
    throw new TypeError('decision.reasoning_summary is required (concise summary, not chain-of-thought)');
  }
  if (record.evidence_hash !== undefined && !HASH_RE.test(record.evidence_hash)) {
    throw new TypeError('decision.evidence_hash must be a 0x-prefixed sha256 hash');
  }
}

export class DecisionLogger {
  constructor(options = {}) {
    this.filePath = options.filePath === null ? null : (options.filePath ?? DEFAULT_LOG_PATH);
    this.clock = options.clock ?? (() => new Date());
    this.records = [];
    this.initialized = false;
    this.enqueueWrite = createWriteQueue();
    this.agentVersion = options.agentVersion;
    this.onRecord = options.onRecord;
  }

  async init() {
    if (this.initialized) return this;
    if (this.filePath) {
      try {
        const body = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        if (!Array.isArray(body)) throw new Error('decision log root must be an array');
        this.records = [];
        this.needsMigration = body.some((record) => !record._private);
        for (const stored of body) {
          if (!stored._private) { this.records.push(stripSecretFields(stored)); continue; }
          const { _private: sealed, ...audit } = stored;
          const decoded = openRecords(sealed, await this.storageKey(false));
          if (stableStringify(sanitizeAudit(decoded)) !== stableStringify(audit)) throw new Error('Audit journal differs from its authenticated operational snapshot');
          this.records.push(decoded);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        this.records = [];
      }
    }
    this.initialized = true;
    if (this.needsMigration) { await this.persist(); this.needsMigration = false; }
    return this;
  }

  now() {
    return this.clock().toISOString();
  }

  async persist() {
    if (!this.filePath) return;
    const records = clone(this.records);
    await this.enqueueWrite(async () => {
      const key = await this.storageKey(true);
      const stored = records.map((record) => ({ ...sanitizeAudit(record), _private: sealRecords(record, key) }));
      await writeFileAtomic(this.filePath, `${JSON.stringify(stored, null, 2)}\n`);
    });
  }

  async storageKey(create) {
    if (this.key) return this.key;
    const file = `${this.filePath}.key`;
    try { this.key = Buffer.from(await fs.readFile(file, 'utf8'), 'base64'); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await fs.mkdir(path.dirname(file), { recursive: true });
      try { await fs.writeFile(file, crypto.generateKeySync('aes', { length: 256 }).export().toString('base64'), { flag: 'wx', mode: 0o600 }); }
      catch (race) { if (race.code !== 'EEXIST') throw race; }
      this.key = Buffer.from(await fs.readFile(file, 'utf8'), 'base64');
    }
    if (this.key.length !== 32) throw new Error('Invalid operational journal encryption key');
    return this.key;
  }

  async record(decision) {
    await this.init();
    validateRecord(decision);
    const timestamp = this.now();
    const record = {
      ...stripSecretFields(clone(decision)),
      ...(this.agentVersion ? { agent_version: decision.agent_version ?? this.agentVersion } : {}),
      decision_id: decision.decision_id ?? createDecisionId(decision),
      status: decision.status ?? 'DECIDED',
      created_at: decision.created_at ?? timestamp,
      updated_at: timestamp,
      transaction: decision.transaction ?? null
    };
    const existingIndex = this.records.findIndex((item) => item.decision_id === record.decision_id);
    if (existingIndex >= 0) {
      const existing = this.records[existingIndex];
      this.records[existingIndex] = {
        ...existing,
        ...record,
        created_at: existing.created_at,
        agent_version: existing.agent_version ?? null,
        transaction: record.transaction ?? existing.transaction ?? null
      };
    } else {
      this.records.push(record);
    }
    await this.persist();
    const saved = clone(this.records.find((item) => item.decision_id === record.decision_id));
    await this.onRecord?.(saved);
    return saved;
  }

  async update(decisionId, patch) {
    await this.init();
    const index = this.records.findIndex((record) => record.decision_id === decisionId);
    if (index < 0) throw new Error(`Unknown decision_id: ${decisionId}`);
    const immutable = this.records[index];
    this.records[index] = {
      ...immutable,
      ...stripSecretFields(clone(patch)),
      decision_id: immutable.decision_id,
      created_at: immutable.created_at,
      updated_at: this.now()
    };
    await this.persist();
    const saved = clone(this.records[index]);
    await this.onRecord?.(saved);
    return saved;
  }

  async attachTransaction(decisionId, transaction) {
    if (!transaction || typeof transaction !== 'object') throw new TypeError('transaction must be an object');
    return this.update(decisionId, {
      transaction,
      status: transaction.success === false ? 'FAILED' : 'COMPLETED'
    });
  }

  /** Remove every record the predicate matches (Demo reset). Returns how many were removed. */
  async clearWhere(predicate) {
    await this.init();
    const before = this.records.length;
    this.records = this.records.filter((record) => !predicate(record));
    const removed = before - this.records.length;
    if (removed) await this.persist();
    return removed;
  }

  /**
   * Keep the log bounded: drop the oldest finished records beyond `maxRecords`, and finished records
   * older than `olderThanMs`. Records that are still in flight are never dropped.
   */
  async prune({ maxRecords, olderThanMs, finished = ['COMPLETED', 'FAILED', 'SKIPPED', 'REJECTED'] } = {}) {
    await this.init();
    const isFinished = (record) => finished.includes(record.status);
    const cutoff = olderThanMs ? Date.parse(this.now()) - olderThanMs : null;
    let records = this.records;
    if (cutoff !== null) {
      records = records.filter((record) => !(isFinished(record) && Date.parse(record.created_at) < cutoff));
    }
    if (maxRecords && records.length > maxRecords) {
      let excess = records.length - maxRecords;
      records = records.filter((record) => {
        if (excess > 0 && isFinished(record)) { excess -= 1; return false; }
        return true;
      });
    }
    const removed = this.records.length - records.length;
    if (removed) {
      this.records = records;
      await this.persist();
    }
    return removed;
  }

  async get(decisionId) {
    await this.init();
    return clone(this.records.find((record) => record.decision_id === decisionId) ?? null);
  }

  async findByIdempotencyKey(key) {
    await this.init();
    return clone(this.records.find((record) => record.idempotency_key === key) ?? null);
  }

  async list(filters = {}) {
    await this.init();
    let result = this.records;
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) result = result.filter((record) => record[key] === value);
    }
    return clone(result);
  }
}

