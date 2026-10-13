// Persistent event queue for the agent runtime (docs/agent-implementation-plan.md WP1.1).
//
//  - de-duplication: an idempotency key is processed once, ever (within the retention window);
//  - ordering: events of one case run one at a time in arrival order, different cases in parallel
//    (up to `concurrency`);
//  - out-of-order: an event older than the last one handled for the same case+type is STALE
//    (recorded, never executed) -- a delayed feed must not undo a newer decision;
//  - retry then dead letter: a failing handler is retried with backoff, then the event is DEAD and
//    kept with its payload so an operator can inspect or replay it;
//  - restart: events that were RECEIVED or PROCESSING when the process stopped are queued again. The
//    handler is idempotent (decision log + executor reconciliation), so this cannot double-execute.
//
// Every accepted event is also appended to a JSONL audit log; the index file holds only state.

import { appendJsonl, createWriteQueue, readJson, writeJsonAtomic } from '../../lib/jsonStore.js';
import { executeWithRetry } from '../executionReliability.js';

export const EVENT_STATUS = Object.freeze({
  RECEIVED: 'RECEIVED',
  PROCESSING: 'PROCESSING',
  DONE: 'DONE',
  FAILED: 'FAILED',
  DEAD: 'DEAD',
  STALE: 'STALE'
});

const KEEP_PAYLOAD = new Set([EVENT_STATUS.RECEIVED, EVENT_STATUS.PROCESSING, EVENT_STATUS.DEAD]);
const riskTypes = new Set(['WORLD_RISK_UPDATED', 'RISK_CLEARED']);
const stream = (event) => `${event.case_id}::${riskTypes.has(event.type) ? 'WORLD_RISK' : event.type}`;

export class EventBus {
  /**
   * @param {object} options
   * @param {(event:object)=>Promise<object|void>} options.handler  processes one event; may return a small result
   * @param {string|null} [options.eventsFile]  JSONL audit log (null = memory only)
   * @param {string|null} [options.indexFile]   state index (null = memory only)
   * @param {number} [options.concurrency=4]
   * @param {number} [options.maxAttempts=3]
   * @param {number} [options.baseDelayMs=200]
   * @param {(ms:number)=>Promise<void>} [options.sleep]
   * @param {()=>Date} [options.now]
   * @param {number} [options.maxIndexEntries=5000]
   * @param {(entry:object)=>void} [options.onSettled]  called when an event reaches DONE/DEAD/STALE/FAILED
   */
  constructor(options = {}) {
    if (typeof options.handler !== 'function') throw new TypeError('EventBus requires a handler');
    this.handler = options.handler;
    this.eventsFile = options.eventsFile ?? null;
    this.indexFile = options.indexFile ?? null;
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseDelayMs = options.baseDelayMs ?? 200;
    this.sleep = options.sleep;
    this.now = options.now ?? (() => new Date());
    this.maxIndexEntries = options.maxIndexEntries ?? 5000;
    this.onSettled = options.onSettled ?? (() => {});

    this.entries = new Map();         // idempotency_key -> entry
    this.lastOccurred = new Map();    // "case::type" -> ISO occurred_at of the newest handled event
    this.queue = [];                  // idempotency keys, arrival order
    this.activeCases = new Set();
    this.activeRuns = new Set();      // in-flight run promises
    this.started = false;
    this.initialized = false;
    this.enqueueWrite = createWriteQueue();
    this.dirty = false;
    this.flushing = null;
  }

  async init() {
    if (this.initialized) return this;
    if (this.indexFile) {
      const saved = await readJson(this.indexFile, null);
      for (const entry of saved?.entries ?? []) this.entries.set(entry.idempotency_key, entry);
      for (const [key, occurred] of Object.entries(saved?.last_occurred ?? {})) this.lastOccurred.set(key, occurred);
      // Older indexes kept clearing and escalation in separate streams. Preserve both high-water marks.
      for (const [key, occurred] of this.lastOccurred) {
        const split = key.lastIndexOf('::');
        if (!riskTypes.has(key.slice(split + 2))) continue;
        const combined = `${key.slice(0, split)}::WORLD_RISK`;
        if (!this.lastOccurred.has(combined) || Date.parse(occurred) > Date.parse(this.lastOccurred.get(combined))) {
          this.lastOccurred.set(combined, occurred);
        }
      }
    }
    // Anything that was in flight when the process stopped is picked up again, oldest first.
    const unfinished = [...this.entries.values()]
      .filter((entry) => [EVENT_STATUS.RECEIVED, EVENT_STATUS.PROCESSING].includes(entry.status) && entry.event)
      .sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
    for (const entry of unfinished) {
      entry.status = EVENT_STATUS.RECEIVED;
      this.queue.push(entry.idempotency_key);
    }
    this.initialized = true;
    return this;
  }

  /** Start processing (and process anything recovered by init()). */
  start() {
    this.started = true;
    this.#pump();
  }

  /** Stop taking new work and wait for in-flight events to finish. Queued events stay queued on disk. */
  async stop() {
    this.started = false;
    await Promise.allSettled([...this.activeRuns]);
    await this.flush();
  }

  /**
   * Accept a normalised event. Returns immediately after the event is durably recorded.
   * @returns {Promise<{ accepted:boolean, duplicate:boolean, event_id:string, idempotency_key:string, status:string }>}
   */
  async submit(event) {
    await this.init();
    const key = event.idempotency_key;
    if (!key) throw new TypeError('event.idempotency_key is required (use normalizeEvent)');
    const existing = this.entries.get(key);
    if (existing) {
      return { accepted: false, duplicate: true, event_id: existing.event_id, idempotency_key: key, status: existing.status };
    }
    const receivedAt = this.now().toISOString();
    const entry = {
      idempotency_key: key,
      event_id: event.event_id,
      case_id: event.case_id,
      type: event.type,
      occurred_at: event.occurred_at,
      mode: event.source_mode ?? null,
      status: EVENT_STATUS.RECEIVED,
      attempts: 0,
      received_at: receivedAt,
      updated_at: receivedAt,
      event
    };
    this.entries.set(key, entry);
    if (this.eventsFile) await appendJsonl(this.eventsFile, { received_at: receivedAt, event });
    await this.flush();
    this.queue.push(key);
    this.#pump();
    return { accepted: true, duplicate: false, event_id: event.event_id, idempotency_key: key, status: EVENT_STATUS.RECEIVED };
  }

  /** Wait until nothing is queued or running (tests and graceful shutdown). */
  async idle() {
    while (this.queue.length > 0 || this.activeRuns.size > 0) {
      if (!this.started && this.activeRuns.size === 0) break; // not running: queued work waits for start()
      await Promise.allSettled([...this.activeRuns]);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await this.flush();
  }

  get(key) {
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry) : null;
  }

  list({ status, case_id: caseId, type, limit = 100 } = {}) {
    let items = [...this.entries.values()];
    if (status) items = items.filter((entry) => entry.status === status);
    if (caseId) items = items.filter((entry) => entry.case_id === caseId);
    if (type) items = items.filter((entry) => entry.type === type);
    items.sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
    return structuredClone(items.slice(0, limit));
  }

  status() {
    const counts = {};
    for (const entry of this.entries.values()) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    return {
      started: this.started,
      queued: this.queue.length,
      processing: this.activeRuns.size,
      concurrency: this.concurrency,
      counts,
      dead: counts[EVENT_STATUS.DEAD] ?? 0
    };
  }

  /**
   * Forget every finished event of one mode (Demo reset) so the same events can be injected again.
   * Events that are queued or running are left alone.
   */
  async clearMode(mode) {
    const running = new Set([...this.activeCases]);
    for (const [key, entry] of [...this.entries]) {
      if (entry.mode !== mode || [EVENT_STATUS.RECEIVED, EVENT_STATUS.PROCESSING].includes(entry.status)) continue;
      if (running.has(entry.case_id)) continue;
      this.entries.delete(key);
    }
    for (const key of [...this.lastOccurred.keys()]) {
      // Stale detection is per case+type; a Demo reset starts the demo timeline over.
      if (![...this.entries.values()].some((entry) => stream(entry) === key)) this.lastOccurred.delete(key);
    }
    await this.flush();
  }

  /** Put a DEAD event back in the queue (operator action). */
  async retryDead(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.status !== EVENT_STATUS.DEAD || !entry.event) return false;
    entry.status = EVENT_STATUS.RECEIVED;
    entry.attempts = 0;
    entry.error = null;
    entry.updated_at = this.now().toISOString();
    this.queue.push(key);
    await this.flush();
    this.#pump();
    return true;
  }

  // ---- scheduling ----

  #pump() {
    if (!this.started) return;
    while (this.activeRuns.size < this.concurrency) {
      // The first queued event of a case that is not already running: arrival order is kept per case.
      const index = this.queue.findIndex((key) => !this.activeCases.has(this.entries.get(key)?.case_id));
      if (index < 0) return;
      const [key] = this.queue.splice(index, 1);
      const entry = this.entries.get(key);
      if (!entry) continue;
      this.activeCases.add(entry.case_id);
      const run = this.#run(entry)
        .catch(() => {})
        .finally(() => {
          this.activeCases.delete(entry.case_id);
          this.activeRuns.delete(run);
          this.#pump();
        });
      this.activeRuns.add(run);
    }
  }

  async #run(entry) {
    const event = entry.event;
    const streamKey = stream(event);
    const last = this.lastOccurred.get(streamKey);
    if (last && Date.parse(event.occurred_at) < Date.parse(last)) {
      return this.#settle(entry, EVENT_STATUS.STALE, { note: `older than the last handled ${event.type} for this case (${last})` });
    }

    entry.status = EVENT_STATUS.PROCESSING;
    entry.updated_at = this.now().toISOString();
    await this.flush();

    try {
      const retried = await executeWithRetry(async (attempt) => {
        entry.attempts = attempt;
        return this.handler(structuredClone(event));
      }, { maxAttempts: this.maxAttempts, baseDelayMs: this.baseDelayMs, sleep: this.sleep });
      const previous = this.lastOccurred.get(streamKey);
      if (!previous || Date.parse(event.occurred_at) > Date.parse(previous)) {
        this.lastOccurred.set(streamKey, event.occurred_at);
      }
      return this.#settle(entry, EVENT_STATUS.DONE, { attempts: retried.attempts, result: retried.value ?? null });
    } catch (error) {
      return this.#settle(entry, EVENT_STATUS.DEAD, {
        attempts: error.attempts ?? entry.attempts,
        error: { name: error.name, message: String(error.cause?.message ?? error.message).slice(0, 500) }
      });
    }
  }

  async #settle(entry, status, patch) {
    Object.assign(entry, patch, { status, updated_at: this.now().toISOString() });
    if (!KEEP_PAYLOAD.has(status)) delete entry.event;
    this.#prune();
    await this.flush();
    try {
      this.onSettled(structuredClone(entry));
    } catch {
      // A listener bug must not change the event's outcome.
    }
  }

  #prune() {
    if (this.entries.size <= this.maxIndexEntries) return;
    // Forget the oldest finished events first; unfinished and dead ones are never dropped.
    const droppable = [...this.entries.values()]
      .filter((entry) => [EVENT_STATUS.DONE, EVENT_STATUS.STALE, EVENT_STATUS.FAILED].includes(entry.status))
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
    for (const entry of droppable) {
      if (this.entries.size <= this.maxIndexEntries) break;
      this.entries.delete(entry.idempotency_key);
    }
  }

  // ---- persistence (coalesced: at most one write in flight, always followed by the latest state) ----

  flush() {
    if (!this.indexFile) return Promise.resolve();
    this.dirty = true;
    if (!this.flushing) {
      this.flushing = (async () => {
        while (this.dirty) {
          this.dirty = false;
          const snapshot = {
            version: 1,
            last_occurred: Object.fromEntries(this.lastOccurred),
            entries: [...this.entries.values()]
          };
          await this.enqueueWrite(() => writeJsonAtomic(this.indexFile, snapshot));
        }
      })().finally(() => { this.flushing = null; });
    }
    return this.flushing;
  }
}
