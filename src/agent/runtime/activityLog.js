// Agent activity feed (docs/agent-implementation-plan.md WP1.5). It replaces the in-memory-only
// feed that lived in server.js:
//   - every record gets a monotonic `seq`, which SSE sends as the event id so a reconnecting client
//     can ask for what it missed (Last-Event-ID) instead of silently losing events;
//   - records are appended to a JSONL file when persistence is attached, and survive a restart;
//   - the newest records are kept in memory (the same array other modules and tests already read as
//     `storeState.agentActivities`).
//
// A record never carries a transaction hash unless a transaction really happened: `tx_hash` and
// `explorer_url` are copied through as given, `reference` holds `demo:` identifiers.

import crypto from 'node:crypto';
import { sanitizeAudit } from '../security/privacy.js';
import { pruneJsonl, retainRecords } from './retention.js';
import { promises as fs } from 'node:fs';
import { appendJsonl, createWriteQueue, readJson, readJsonl, writeFileAtomic, writeJsonAtomic } from '../../lib/jsonStore.js';

const MAX_MEMORY = 1000;

export class ActivityLog {
  /**
   * @param {object} [options]
   * @param {{agentActivities?: object[]}} [options.store]  holder of the in-memory buffer (storeState)
   * @param {number} [options.maxMemory]
   * @param {()=>string} [options.mode]                      current runtime mode, stamped on each record
   * @param {()=>Date} [options.now]
   */
  constructor({ store = { agentActivities: [] }, maxMemory = MAX_MEMORY, mode = () => 'demo', now = () => new Date() } = {}) {
    this.store = store;
    this.maxMemory = maxMemory;
    this.currentMode = mode;
    this.now = now;
    this.file = null;
    this.maxFileBytes = 5 * 1024 * 1024;
    this.keepFiles = 3;
    this.seq = 0;
    this.listeners = new Set();
    this.enqueueWrite = createWriteQueue();
    this.lastPersistError = null;
  }

  get buffer() {
    if (!Array.isArray(this.store.agentActivities)) this.store.agentActivities = [];
    return this.store.agentActivities;
  }

  /** Subscribe to every appended record (the SSE broadcaster). Returns an unsubscribe function. */
  onAppend(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Turn persistence on: load the newest records and continue the sequence after the last one on
   * disk. Records appended before this call (during startup) are written after the existing ones.
   */
  async attachFile(file, { maxFileBytes, keepFiles } = {}) {
    this.file = file;
    if (maxFileBytes) this.maxFileBytes = maxFileBytes;
    if (keepFiles !== undefined) this.keepFiles = keepFiles;
    const saved = await readJsonl(file, { tail: this.maxMemory, includeRotated: true, keepFiles: this.keepFiles });
    const checkpoint = await readJson(`${file}.sequence.json`, { seq: 0 });
    const lastOnDisk = saved.reduce((max, record) => Math.max(max, Number(record.seq) || 0), Number(checkpoint.seq) || 0);
    const early = this.buffer.splice(0, this.buffer.length);
    this.seq = lastOnDisk;
    this.buffer.push(...saved.map((record) => sanitizeAudit(record)));
    for (const record of early) {
      this.seq += 1;
      record.seq = this.seq;
      this.buffer.push(record);
      this.#persist(record);
    }
    this.#trim();
    await this.flush();
    return this;
  }

  async flush() {
    await this.enqueueWrite(async () => {});
  }

  /**
   * Add a record. Synchronous: the returned record already has its `seq`; the disk write follows.
   * @param {object} activity  { type, action, caseId?, poolId?, decision_id?, mode?, reference?, tx_hash?, explorer_url?, details? }
   */
  append(activity) {
    this.seq += 1;
    const record = {
      id: `activity-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: this.now().toISOString(),
      mode: this.currentMode(),
      ...sanitizeAudit(activity),
      seq: this.seq
    };
    this.buffer.push(record);
    this.#trim();
    this.#persist(record);
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // A broken subscriber must not stop the feed.
      }
    }
    return record;
  }

  #trim() {
    const buffer = this.buffer;
    if (buffer.length > this.maxMemory) buffer.splice(0, buffer.length - this.maxMemory);
  }

  #persist(record) {
    if (!this.file) return;
    const file = this.file;
    this.enqueueWrite(() => appendJsonl(file, record, { maxBytes: this.maxFileBytes, keepFiles: this.keepFiles }))
      .catch((error) => { this.lastPersistError = error?.message ?? String(error); });
  }

  /** Newest `limit` records matching the filters, oldest first. */
  list({ caseId, poolId, limit = 50 } = {}) {
    let items = this.buffer;
    if (caseId) items = items.filter((record) => record.caseId === caseId);
    if (poolId) items = items.filter((record) => record.poolId === poolId);
    return items.slice(-limit);
  }

  count({ caseId, poolId } = {}) {
    return this.list({ caseId, poolId, limit: Infinity }).length;
  }

  /**
   * Records after `seq`, oldest first, for SSE resume. Memory covers the common case; when the client
   * is further behind than the buffer, the files are read.
   */
  async since(seq, { caseId, poolId, limit = 500 } = {}) {
    const after = Number(seq);
    if (!Number.isFinite(after) || after < 0) return [];
    const matches = (record) => record.seq > after
      && (!caseId || record.caseId === caseId)
      && (!poolId || record.poolId === poolId);
    const oldestInMemory = this.buffer[0]?.seq ?? this.seq + 1;
    if (after + 1 >= oldestInMemory || !this.file) return this.buffer.filter(matches).slice(0, limit);
    await this.flush();
    const fromDisk = await readJsonl(this.file, { filter: matches, includeRotated: true, keepFiles: this.keepFiles });
    return fromDisk.slice(0, limit);
  }

  async prune(options) {
    const watermark = this.seq;
    return this.enqueueWrite(async () => {
      // Persist the high-water mark BEFORE cleanup so a crash cannot reuse an expired SSE id.
      if (this.file) await writeJsonAtomic(`${this.file}.sequence.json`, { seq: watermark });
      const kept = this.file ? await pruneJsonl(this.file, this.keepFiles, { ...options, timestamp: 'timestamp' })
        : retainRecords(this.buffer, { ...options, timestamp: 'timestamp' });
      const appended = this.buffer.filter((record) => record.seq > watermark);
      this.store.agentActivities = [...kept, ...appended].slice(-this.maxMemory);
    });
  }

  /** Forget every record of one mode (Demo reset). Live records are never touched. */
  async clearMode(mode) {
    const keep = (record) => record.mode !== mode;
    this.store.agentActivities = this.buffer.filter(keep);
    if (!this.file) return;
    await this.flush();
    const files = [this.file, ...Array.from({ length: this.keepFiles }, (_, i) => `${this.file}.${i + 1}`)];
    for (const file of files) {
      const records = await readJsonl(file);
      if (!records.length) continue;
      const kept = records.filter(keep);
      if (kept.length === records.length) continue;
      if (kept.length === 0) await fs.rm(file, { force: true });
      else await writeFileAtomic(file, kept.map((record) => JSON.stringify(record)).join('\n') + '\n');
    }
  }
}
