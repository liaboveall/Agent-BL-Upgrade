// Demo scenario player: plays a scripted timeline through the
// SAME runtime the real sources feed -- events go into the bus, decisions come out, the policy engine
// and the simulated executor do their usual work. Nothing in a scenario decides an outcome; it only
// supplies what happened (a risk snapshot, a departure, a payment proof) and when.
//
//   steps:  risk_snapshot  the current world-risk picture for the case → the RiskTracker decides what changed
//           event          a literal AgentEvent (departure, arrival, payment, ...)
//           subscribe      an investor subscribes a fraction of the pool (Demo only, off-chain)
//           clock          move the virtual clock → the insurance monitor looks at the policy
//
// Results are deterministic: event ids are `scn:<scenario>:<step>`, so replaying a scenario on a
// runtime that already played it is detected instead of duplicating decisions. Demo mode only.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscribeToPool } from '../../../app/store.js';
import { RiskTracker } from './riskTracker.js';
import { insuranceEvents } from './voyageMonitor.js';
import { hashSnapshot } from '../../decisionLogger.js';
import { rebaseCaseDates, rebaseDocumentText } from '../../../core/caseDates.js';

const SCENARIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../data/agent-scenarios');
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const HOUR_MS = 60 * 60 * 1000;
const SCENARIO_WALLET = '0xDemoScenarioInvestor';

export class ScenarioError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ScenarioError';
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

function validateScenario(data, name) {
  if (!data || typeof data !== 'object' || data.name !== name) throw new ScenarioError('invalid_scenario', `Scenario ${name} is malformed`, 500);
  if (typeof data.case_id !== 'string' || !Array.isArray(data.steps) || data.steps.length === 0) {
    throw new ScenarioError('invalid_scenario', `Scenario ${name} needs a case_id and steps`, 500);
  }
  const kinds = new Set(['risk_snapshot', 'event', 'subscribe', 'clock', 'documents']);
  for (const [index, step] of data.steps.entries()) {
    if (!kinds.has(step.kind)) throw new ScenarioError('invalid_scenario', `Scenario ${name} step ${index} has an unknown kind`, 500);
  }
  return data;
}

export class ScenarioPlayer {
  /**
   * @param {object} options
   * @param {() => object} options.getService
   * @param {string} [options.dir]
   * @param {number} [options.clearTicks]
   * @param {number} [options.speed]   only scales the virtual timestamps; steps are not delayed in real time
   */
  constructor({ getService, dir = SCENARIO_DIR, clearTicks = 2, speed = 1 } = {}) {
    this.getService = getService;
    this.dir = dir;
    this.clearTicks = clearTicks;
    this.speed = speed;
    this.current = null;
    this.catalog = null;
    this.playback = null;
    this.playTask = null;
    this.stepTask = null;
    this.stepDelayMs = 1000;
  }

  /** The virtual clock (epoch ms) while a scenario is loaded, else null. */
  get clockMs() {
    return this.current ? this.current.clock_ms : null;
  }

  async list() {
    if (!this.catalog) {
      const names = (await fs.readdir(this.dir).catch(() => [])).filter((file) => file.endsWith('.json'));
      this.catalog = [];
      for (const file of names.sort()) {
        const name = file.replace(/\.json$/u, '');
        if (!NAME_PATTERN.test(name)) continue;
        const data = validateScenario(rebaseCaseDates(JSON.parse(await fs.readFile(path.join(this.dir, file), 'utf8'))), name);
        this.catalog.push({ name, title: data.title ?? { en: name }, description: data.description ?? null, case_id: data.case_id, steps: data.steps.length });
      }
    }
    return this.catalog.map((item) => structuredClone(item));
  }

  async #load(name) {
    if (!NAME_PATTERN.test(String(name))) throw new ScenarioError('invalid_scenario_name', 'Unknown scenario', 404);
    let raw;
    try {
      // Scenarios are written around the demo anchor day; they play out from today like the cases do.
      raw = rebaseCaseDates(JSON.parse(await fs.readFile(path.join(this.dir, `${name}.json`), 'utf8')));
    } catch {
      throw new ScenarioError('scenario_not_found', `No scenario named ${name}`, 404);
    }
    return validateScenario(raw, name);
  }

  status() {
    if (!this.current) return { loaded: false };
    const { scenario, index, clock_ms: clockMs, log } = this.current;
    return {
      loaded: true,
      name: scenario.name,
      case_id: scenario.case_id,
      total_steps: scenario.steps.length,
      next_step: index,
      finished: index >= scenario.steps.length,
      virtual_time: new Date(clockMs).toISOString(),
      log: structuredClone(log)
    };
  }

  /** Load a scenario. `reset: true` first clears everything the agent recorded in Demo, for a clean run. */
  async start(name, { reset = false, runId } = {}) {
    this.#manualGuard(runId);
    const service = this.getService();
    if (service.getMode() !== 'demo') throw new ScenarioError('demo_only', 'Scenarios only run in Demo mode', 409);
    const generation = service.getGeneration();
    const scenario = await this.#load(name);
    if (service.getMode() !== 'demo' || generation !== service.getGeneration()) throw new ScenarioError('mode_changed', 'Runtime changed while loading the scenario', 409);
    if (reset) await service.resetDemo();
    await service.ensurePools();
    if (service.getMode() !== 'demo' || generation !== service.getGeneration()) throw new ScenarioError('mode_changed', 'Runtime changed while loading pools', 409);
    if (!service.store.pools.has(scenario.case_id)) {
      throw new ScenarioError('case_not_in_market', `Scenario ${name} needs the case ${scenario.case_id}, which is not in the Demo market`, 409);
    }
    this.current = {
      scenario,
      generation,
      index: 0,
      clock_ms: Date.parse(scenario.start_at ?? new Date().toISOString()),
      tracker: new RiskTracker({ clearTicks: this.clearTicks }),
      log: []
    };
    return this.status();
  }

  async stop() {
    await this.stopPlayback();
    await this.stepTask;
    this.current = null;
    this.playback = null;
    this.playTask = null;
    return this.status();
  }

  /** Play the next step. Returns what happened, or `{done: true}` when the scenario is over. */
  async step({ runId } = {}) {
    this.#manualGuard(runId);
    if (this.stepTask) throw new ScenarioError('scenario_busy', 'A scenario step is already in progress', 409);
    this.stepTask = this.#step();
    try { return await this.stepTask; } finally { this.stepTask = null; }
  }

  async #step() {
    const run = this.current;
    if (!run) throw new ScenarioError('no_scenario', 'Start a scenario first', 409);
    const service = this.getService();
    if (service.getMode() !== 'demo') throw new ScenarioError('demo_only', 'Scenarios only run in Demo mode', 409);
    const assertCurrent = () => {
      if (service.getMode() !== 'demo' || service.getGeneration() !== run.generation || this.current !== run) {
        throw new ScenarioError('mode_changed', 'The scenario belongs to an older runtime', 409);
      }
    };
    assertCurrent();
    if (run.index >= run.scenario.steps.length) return { done: true, ...this.status() };

    const { scenario } = run;
    const index = run.index;
    const step = scenario.steps[index];
    run.clock_ms += Math.round((Number(step.after_hours ?? 1) * HOUR_MS) / this.speed);
    const occurredAt = new Date(run.clock_ms).toISOString();
    const entry = { index, kind: step.kind, label: step.label ?? null, virtual_time: occurredAt, events: [] };
    const caseId = scenario.case_id;
    const pool = service.store.pools.get(caseId);
    const eventId = `scn:${scenario.name}:${index}`;

    const submit = async (raw, suffix = '') => {
      assertCurrent();
      const accepted = await service.submitEvent({
        ...raw,
        event_id: `${eventId}${suffix}`,
        case_id: caseId,
        pool_id: pool?.poolId,
        occurred_at: occurredAt,
        source: 'scenario',
        source_mode: 'demo'
      });
      const settled = await service.waitFor(accepted.idempotency_key, 15_000);
      const decisions = [];
      for (const id of settled.result?.decisions ?? []) {
        const decision = await service.getDecision(id);
        if (decision) decisions.push({ decision_id: id, action: decision.action, status: decision.status, verdict: decision.policy?.verdict });
      }
      entry.events.push({
        type: raw.type,
        event_id: `${eventId}${suffix}`,
        accepted: accepted.accepted !== false,
        duplicate: accepted.duplicate === true,
        status: settled.status,
        ignored: settled.result?.ignored ?? null,
        decisions
      });
    };

    switch (step.kind) {
      case 'documents': {
        const documents = await Promise.all(['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md'].map(async (name) => ({
          name, mime_type: 'text/markdown', text: rebaseDocumentText(await fs.readFile(new URL(`../../../../data/uploads/copper-sg-shanghai/${name}`, import.meta.url), 'utf8'))
        })));
        assertCurrent();
        const uploaded = await service.submitDocuments({ case_id: caseId, documents }, { source: 'scenario', occurredAt, generation: run.generation });
        const settled = await service.waitFor(uploaded.idempotency_key, 30_000);
        const job = service.ingest.getJob(uploaded.job.job_id);
        entry.job_id = job.job_id;
        entry.events.push({ type: 'DOCUMENTS_INGESTED', status: settled.status, decisions: await Promise.all((job.decision_ids ?? []).map(async (id) => {
          const decision = await service.getDecision(id);
          return { decision_id: id, action: decision.action, status: decision.status, verdict: decision.policy?.verdict };
        })) });
        if (job.status !== 'DONE' || job.review_required || !['OPEN', 'OPEN_WITH_WARNING'].includes(job.result_action)) {
          throw new ScenarioError('scenario_review_required', 'Documents need review; playback stopped before subscription', 409);
        }
        break;
      }
      case 'risk_snapshot': {
        const change = await run.tracker.observe(caseId, step.events ?? []);
        entry.change = change ? change.type : null;
        if (change) await submit({ type: change.type, data: change.data });
        break;
      }
      case 'event': {
        const data = { ...step.data };
        if (step.type === 'PAYMENT_RECEIVED' && step.repayment_basis === 'subscribed_target') {
          data.repayment_amount = (pool.subscribedShares || Math.ceil(pool.subscribedUsd / pool.quote.final_issue_price_usd)) * (pool.redemptionValueUsd ?? 1);
        }
        await submit({ type: step.type, data });
        break;
      }
      case 'subscribe': {
        // Only an open pool takes subscriptions; replaying a scenario on a pool that has moved on skips this step.
        if (pool.status !== 'Open') {
          entry.skipped = `The pool is ${pool.status}, not Open, so nobody can subscribe`;
          break;
        }
        const amount = Math.round(pool.targetUsd * Number(step.fraction ?? 0.4));
        const prior = service.store.investments.find((investment) => investment.source?.scenario_step === eventId);
        if (prior) { entry.skipped = 'This scenario subscription is already recorded'; break; }
        assertCurrent();
        const result = subscribeToPool(SCENARIO_WALLET, caseId, amount, { source: { kind: 'scenario', scenario: scenario.name, scenario_step: eventId } });
        service.activity.append({ type: 'SUBSCRIPTION', action: 'DEMO_SUBSCRIBED', caseId, poolId: pool.poolId, mode: 'demo', reference: result.reference, details: { amount_usd: amount, scenario: scenario.name } });
        entry.subscribed_usd = amount;
        break;
      }
      case 'clock': {
        const events = insuranceEvents(pool, run.clock_ms, { warnDays: service.config.insuranceWarnDays });
        entry.change = events[0]?.type ?? null;
        for (const [offset, event] of events.entries()) await submit({ type: event.type, data: event.data }, offset ? `#${offset}` : '');
        break;
      }
      default:
        break;
    }

    run.index += 1;
    run.log.push(entry);
    return { done: run.index >= scenario.steps.length, entry };
  }

  /** Play every remaining step (stops early only on an error). */
  async run() {
    const entries = [];
    for (;;) {
      const result = await this.step();
      if (result.entry) entries.push(result.entry);
      if (result.done) break;
    }
    return { entries, ...this.status() };
  }

  #manualGuard(runId) {
    if (this.playback?.active && runId !== this.playback.run_id) throw new ScenarioError('demo_run_active', 'Stop the current playback before changing scenarios', 409);
  }

  playbackStatus() {
    if (!this.playback) return { active: false, state: 'idle' };
    const { cancelled: _cancelled, wake: _wake, ...run } = this.playback;
    return { ...structuredClone(run), scenario: this.status() };
  }

  #publish(action) {
    const run = this.playback;
    this.getService().activity.append({ type: 'SCENARIO', action, caseId: this.current?.scenario.case_id,
      mode: 'demo', details: { run: this.playbackStatus() } });
    return run;
  }

  /** Starts a paced background playback. speed changes wall-clock pacing, never evidence timestamps. */
  async play(name, { speed = 1 } = {}) {
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.25 || speed > 10) throw new ScenarioError('invalid_speed', 'speed must be a number between 0.25 and 10');
    const service = this.getService();
    if (service.getMode() !== 'demo') throw new ScenarioError('demo_only', 'Playback only runs in Demo mode', 409);
    this.#manualGuard();
    if (this.stepTask) throw new ScenarioError('scenario_busy', 'A manual scenario step is in progress', 409);
    if (service.autonomy().effective !== 'auto') throw new ScenarioError('demo_autonomy_required', 'Set Demo autonomy to auto before playback', 409);
    const run = { run_id: `demo-run:${hashSnapshot({ name, generation: service.getGeneration() }).slice(2, 26)}`,
      name, speed, generation: service.getGeneration(), active: true, state: 'starting', cancelled: false };
    this.playback = run;
    // Reserve the run before the first await, including its preparation, so two POSTs cannot race.
    this.playTask = (async () => {
      await this.start(name, { runId: run.run_id });
      if (run.cancelled) return;
      if (!service.running) await service.start();
      if (run.cancelled || service.getMode() !== 'demo' || service.getGeneration() !== run.generation) return;
      run.state = 'running'; this.#publish('DEMO_RUN_STARTED');
      while (!run.cancelled && service.getMode() === 'demo' && service.getGeneration() === run.generation) {
        const result = await this.step({ runId: run.run_id });
        this.#publish('DEMO_RUN_STEP');
        if (result.done) { run.state = 'completed'; break; }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, this.stepDelayMs / speed);
          run.wake = () => { clearTimeout(timer); resolve(); };
        });
        run.wake = null;
      }
      if (run.state !== 'completed') run.state = 'stopped';
    })().catch((error) => {
      run.state = run.cancelled || error.code === 'mode_changed' || error.code === 'demo_only' ? 'stopped' : 'failed';
      run.error = { code: error.code ?? 'scenario_failed', message: String(error.message).slice(0, 300) };
    }).finally(() => {
      run.active = false; run.wake = null;
      if (run.state === 'starting') run.state = 'stopped';
      this.#publish('DEMO_RUN_FINISHED');
    });
    // Validate the name before accepting the request; task errors are also retained for observers.
    await this.#load(name).catch(async (error) => { await this.stopPlayback(); throw error; });
    return this.playbackStatus();
  }

  async stopPlayback() {
    if (this.playback?.active) {
      this.playback.cancelled = true;
      this.playback.wake?.();
    }
    await this.playTask;
    return this.playbackStatus();
  }
}
