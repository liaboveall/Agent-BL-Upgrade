// Exporter preferences per case. They are used in two
// places: the ingest pipeline picks a payout speed and a financing target with them, and the policy
// engine refuses to lower a price below the exporter's floor without a human (rule 10).
//
// Map-like on purpose (`get`/`set`): the policy call site only ever reads `get(case_id)`.
//
// A change is visible to readers only once it is on disk: each write builds the next state from the last committed
// one inside the write queue, persists it, and only then replaces what `get` returns. A failed write leaves the
// previous preferences in force, and a later successful write is never rolled back by an earlier failure.
// Each entry records the runtime mode it was saved in, so the Demo reset clears Demo entries only.

import { z } from 'zod';
import { PAYOUT_SPEEDS } from '../../core/pricingSchema.js';
import { createWriteQueue, readJson, writeJsonAtomic } from '../../lib/jsonStore.js';

const preferenceSchema = z.strictObject({
  min_acceptable_issue_price: z.number().finite().min(0).max(1).optional(),
  payout_speed_preference: z.enum(PAYOUT_SPEEDS).optional(),
  target_financing_amount: z.number().finite().positive().max(1e12).optional()
});

export class PreferenceError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'PreferenceError';
    this.code = 'invalid_preferences';
    this.status = 400;
    this.expose = true;
    this.issues = issues;
  }
}

/** Validate a preference object; unknown keys are an error so a typo is not silently ignored. */
export function parsePreferences(input) {
  const result = preferenceSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(preferences)'}: ${issue.message}`);
    throw new PreferenceError(`Invalid exporter preferences: ${issues.join('; ')}`, issues);
  }
  return result.data;
}

export class PreferenceStore {
  /** @param {{file?: string|null, now?: ()=>Date}} [options] */
  constructor({ file = null, now = () => new Date() } = {}) {
    this.file = file;
    this.now = now;
    this.byCase = new Map();
    this.queue = createWriteQueue();
    this.loading = null;
    // Whether `has` answers for what is stored: a file-backed store does not know before its file is read.
    this.ready = !file;
  }

  /**
   * Load once. Every caller waits for the same read: a save that arrived while the file was still being read would
   * otherwise start from an empty store and write that over what was saved.
   */
  init() {
    this.loading ??= (async () => {
      if (this.file) {
        const stored = await readJson(this.file, {});
        for (const [caseId, value] of Object.entries(stored ?? {})) this.byCase.set(caseId, value);
      }
      this.ready = true;
      return this;
    })().catch((error) => { this.loading = null; throw error; });
    return this.loading;
  }

  get(caseId) {
    const entry = this.byCase.get(caseId);
    return entry ? { ...entry.preferences } : undefined;
  }

  has(caseId) {
    return this.byCase.has(caseId);
  }

  /** The stored record, including when it was last changed. */
  describe(caseId) {
    const entry = this.byCase.get(caseId);
    return entry ? structuredClone(entry) : null;
  }

  /** Replace a case's preferences (PUT semantics). An empty object clears them. */
  async put(caseId, input, { mode } = {}) {
    await this.init();
    const preferences = parsePreferences(input ?? {});
    await this.#commit((next) => {
      if (Object.keys(preferences).length === 0) next.delete(caseId);
      else next.set(caseId, { preferences, updated_at: this.now().toISOString(), ...(mode ? { mode } : {}) });
    });
    return this.describe(caseId) ?? { preferences: {}, updated_at: this.now().toISOString() };
  }

  async clear() {
    await this.init();
    await this.#commit((next) => next.clear());
  }

  /** The Demo reset: entries saved in Live, or for a case `keep` names (Live material), stay. */
  async clearDemo({ keep = new Set() } = {}) {
    await this.init();
    await this.#commit((next) => {
      for (const [caseId, entry] of next) if (entry.mode !== 'live' && !keep.has(caseId)) next.delete(caseId);
    });
  }

  /** Apply `change` to a copy of the committed state, persist it, then publish it. */
  #commit(change) {
    return this.queue(async () => {
      const next = new Map(this.byCase);
      change(next);
      if (this.file) await writeJsonAtomic(this.file, Object.fromEntries(next), { mode: 0o600 });
      this.byCase = next;
    });
  }
}
