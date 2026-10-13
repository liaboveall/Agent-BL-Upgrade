// Demo scenario player (docs/agent-implementation-plan.md WP2.5): plays a scripted timeline through the
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
  const kinds = new Set(['risk_snapshot', 'event', 'subscribe', 'clock']);
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
        const data = validateScenario(JSON.parse(await fs.readFile(path.join(this.dir, file), 'utf8')), name);
        this.catalog.push({ name, title: data.title ?? { en: name }, description: data.description ?? null, case_id: data.case_id, steps: data.steps.length });
      }
    }
    return this.catalog.map((item) => structuredClone(item));
  }

  async #load(name) {
    if (!NAME_PATTERN.test(String(name))) throw new ScenarioError('invalid_scenario_name', 'Unknown scenario', 404);
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(path.join(this.dir, `${name}.json`), 'utf8'));
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
  async start(name, { reset = false } = {}) {
    const service = this.getService();
    if (service.getMode() !== 'demo') throw new ScenarioError('demo_only', 'Scenarios only run in Demo mode', 409);
    const scenario = await this.#load(name);
    if (reset) await service.resetDemo();
    await service.ensurePools();
    if (!service.store.pools.has(scenario.case_id)) {
      throw new ScenarioError('case_not_in_market', `Scenario ${name} needs the case ${scenario.case_id}, which is not in the Demo market`, 409);
    }
    this.current = {
      scenario,
      index: 0,
      clock_ms: Date.parse(scenario.start_at ?? '2026-06-10T00:00:00Z'),
      tracker: new RiskTracker({ clearTicks: this.clearTicks }),
      log: []
    };
    return this.status();
  }

  async stop() {
    this.current = null;
    return this.status();
  }

  /** Play the next step. Returns what happened, or `{done: true}` when the scenario is over. */
  async step() {
    const run = this.current;
    if (!run) throw new ScenarioError('no_scenario', 'Start a scenario first', 409);
    const service = this.getService();
    if (service.getMode() !== 'demo') throw new ScenarioError('demo_only', 'Scenarios only run in Demo mode', 409);
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
      case 'risk_snapshot': {
        const change = await run.tracker.observe(caseId, step.events ?? []);
        entry.change = change ? change.type : null;
        if (change) await submit({ type: change.type, data: change.data });
        break;
      }
      case 'event':
        await submit({ type: step.type, data: step.data ?? {} });
        break;
      case 'subscribe': {
        // Only an open pool takes subscriptions; replaying a scenario on a pool that has moved on skips this step.
        if (pool.status !== 'Open') {
          entry.skipped = `The pool is ${pool.status}, not Open, so nobody can subscribe`;
          break;
        }
        const amount = Math.round(pool.targetUsd * Number(step.fraction ?? 0.4));
        const result = subscribeToPool(SCENARIO_WALLET, caseId, amount, { source: { kind: 'scenario', scenario: scenario.name } });
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
}
