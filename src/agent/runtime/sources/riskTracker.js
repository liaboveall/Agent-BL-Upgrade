// World-risk change detector with hysteresis (docs/agent-implementation-plan.md WP2.5).
//
// The offline fixture (and any slow live feed) returns the SAME snapshot every time it is polled, so
// "there is risk" is not an event -- a CHANGE is. For every case this keeps what was last seen and
// emits:
//
//   WORLD_RISK_UPDATED  an alert appeared, or one got more severe        (carries the current alerts)
//   RISK_CLEARED        no alert for `clearTicks` consecutive observations (so one quiet poll in the
//                       middle of a storm does not resume a paused pool)
//
// The first observation of a case is a baseline: it is remembered and never reported, because the pool
// was priced from the same evidence. State survives a restart when a file is given.

import { createWriteQueue, readJson, writeJsonAtomic } from '../../../lib/jsonStore.js';
import { hashSnapshot } from '../../decisionLogger.js';

const RANK = { info: 0, low: 0, medium: 1, warning: 1, high: 2, critical: 3 };
const rankOf = (event) => RANK[String(event?.severity ?? 'info').toLowerCase()] ?? 0;
const keyOf = (event) => `${event.type ?? 'unknown'}|${event.region ?? ''}`;
const isAlert = (event) => rankOf(event) >= 1;

export class RiskTracker {
  /** @param {{clearTicks?: number, file?: string|null}} [options] */
  constructor({ clearTicks = 2, file = null } = {}) {
    this.clearTicks = Math.max(1, clearTicks);
    this.file = file;
    this.cases = new Map();
    this.queue = createWriteQueue();
    this.loaded = false;
  }

  async init() {
    if (this.loaded) return this;
    this.loaded = true;
    if (this.file) {
      const stored = await readJson(this.file, {});
      for (const [caseId, state] of Object.entries(stored ?? {})) this.cases.set(caseId, state);
    }
    return this;
  }

  #save() {
    if (!this.file) return Promise.resolve();
    return this.queue(() => writeJsonAtomic(this.file, Object.fromEntries(this.cases)));
  }

  state(caseId) {
    const state = this.cases.get(caseId);
    return state ? structuredClone(state) : null;
  }

  /**
   * @param {string} caseId
   * @param {Array<{type?:string, region?:string, severity?:string}>} events  the full current picture for this case
   * @returns {Promise<null | {type: 'WORLD_RISK_UPDATED', data: {events: object[], max_severity: string}} | {type: 'RISK_CLEARED', data: {quiet_ticks: number}}>}
   */
  async observe(caseId, events = []) {
    await this.init();
    const alerts = events.filter(isAlert);
    const known = this.cases.get(caseId);

    if (!known) {
      this.cases.set(caseId, { alerts: Object.fromEntries(alerts.map((e) => [keyOf(e), rankOf(e)])), quiet: 0, active: false, emitted: 0 });
      await this.#save();
      return null;
    }

    if (alerts.length > 0) {
      const raised = alerts.some((e) => rankOf(e) > (known.alerts[keyOf(e)] ?? -1));
      known.alerts = Object.fromEntries(alerts.map((e) => [keyOf(e), rankOf(e)]));
      known.quiet = 0;
      if (!raised) {
        await this.#save();
        return null;
      }
      known.active = true;
      known.emitted += 1;
      await this.#save();
      const top = Math.max(...alerts.map(rankOf));
      return {
        type: 'WORLD_RISK_UPDATED',
        sequence: known.emitted,
        data: { events: alerts, max_severity: top >= 3 ? 'critical' : top >= 2 ? 'high' : 'warning', signature: hashSnapshot(Object.keys(known.alerts).sort()).slice(2, 14) }
      };
    }

    if (!known.active) {
      known.alerts = {};
      await this.#save();
      return null;
    }
    // Still inside an episode: remember what was alarming, so the same alert coming back after one
    // quiet look is the same episode continuing, not a new announcement.
    known.quiet += 1;
    if (known.quiet < this.clearTicks) {
      await this.#save();
      return null;
    }
    known.active = false;
    known.alerts = {};
    known.quiet = 0;
    known.emitted += 1;
    await this.#save();
    return { type: 'RISK_CLEARED', sequence: known.emitted, data: { quiet_ticks: this.clearTicks } };
  }

  async clear() {
    this.cases.clear();
    await this.#save();
  }
}
