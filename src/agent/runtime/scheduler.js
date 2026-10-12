// Periodic tick for the agent runtime (docs/agent-implementation-plan.md WP2.5/WP1.5): runs
// `task` every `intervalMs` (±10% jitter so several instances do not hit an RPC in lockstep), never
// overlaps itself (a slow tick makes the next one wait), and its timer is unref'd so it cannot keep
// the process alive. `trigger()` runs one tick on demand with the same no-overlap guarantee.

export class Scheduler {
  /**
   * @param {object} options
   * @param {() => Promise<void>} options.task
   * @param {number} options.intervalMs
   * @param {number} [options.jitter=0.1]
   * @param {() => number} [options.random]
   * @param {{setTimeout:Function, clearTimeout:Function}} [options.timers]  injectable for tests
   * @param {() => number} [options.now]
   * @param {(error: Error) => void} [options.onError]
   */
  constructor({ task, intervalMs, jitter = 0.1, random = Math.random, timers = { setTimeout, clearTimeout }, now = () => Date.now(), onError = () => {} }) {
    if (typeof task !== 'function') throw new TypeError('Scheduler requires a task');
    this.task = task;
    this.intervalMs = intervalMs;
    this.jitter = jitter;
    this.random = random;
    this.timers = timers;
    this.now = now;
    this.onError = onError;
    this.timer = null;
    this.running = false;
    this.inFlight = null;
    this.lastRunAt = null;
    this.nextRunAt = null;
    this.skipped = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  /** Wait for a tick that is running right now (graceful shutdown). */
  async drain() {
    await this.inFlight?.catch(() => {});
  }

  setInterval(intervalMs) {
    this.intervalMs = intervalMs;
    if (this.running) {
      if (this.timer) this.timers.clearTimeout(this.timer);
      this.#schedule();
    }
  }

  /** Run one tick now. If one is already running it returns that tick instead of starting another. */
  trigger() {
    if (this.inFlight) {
      this.skipped += 1;
      return this.inFlight;
    }
    this.lastRunAt = new Date(this.now()).toISOString();
    this.inFlight = Promise.resolve()
      .then(() => this.task())
      .catch((error) => { this.onError(error); })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  #schedule() {
    const spread = this.intervalMs * this.jitter;
    const delay = Math.max(1, Math.round(this.intervalMs + (this.random() * 2 - 1) * spread));
    this.nextRunAt = new Date(this.now() + delay).toISOString();
    this.timer = this.timers.setTimeout(async () => {
      this.timer = null;
      await this.trigger();
      if (this.running) this.#schedule();
    }, delay);
    this.timer.unref?.();
  }
}
