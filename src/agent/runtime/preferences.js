// Exporter preferences per case (docs/agent-implementation-plan.md WP2.8, FE-14). They are used in two
// places: the ingest pipeline picks a payout speed and a financing target with them, and the policy
// engine refuses to lower a price below the exporter's floor without a human (rule 10).
//
// Map-like on purpose (`get`/`set`): the policy call site only ever reads `get(case_id)`.

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
    this.loaded = false;
  }

  async init() {
    if (this.loaded) return this;
    this.loaded = true;
    if (this.file) {
      const stored = await readJson(this.file, {});
      for (const [caseId, value] of Object.entries(stored ?? {})) this.byCase.set(caseId, value);
    }
    return this;
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
  async put(caseId, input) {
    await this.init();
    const preferences = parsePreferences(input ?? {});
    if (Object.keys(preferences).length === 0) {
      this.byCase.delete(caseId);
    } else {
      this.byCase.set(caseId, { preferences, updated_at: this.now().toISOString() });
    }
    await this.#persist();
    return this.describe(caseId) ?? { preferences: {}, updated_at: this.now().toISOString() };
  }

  async clear() {
    this.byCase.clear();
    await this.#persist();
  }

  #persist() {
    if (!this.file) return Promise.resolve();
    return this.queue(() => writeJsonAtomic(this.file, Object.fromEntries(this.byCase)));
  }
}
