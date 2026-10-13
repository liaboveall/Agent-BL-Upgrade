// AgentService (docs/agent-implementation-plan.md WP1.5): the one object that wires the runtime
// together. An event goes in; out come decisions with a recorded policy verdict, and -- depending on
// that verdict, the mode and the autonomy level -- either an executed (Demo, simulated) action, an
// approval waiting for a human, or just a record.
//
//   event ─► EventBus ─► monitor pipeline ─► proposal ─► policy ─┬─ AUTO ───────────► executor
//                                                                ├─ NEEDS_APPROVAL ─► approval queue ─► executor | owner CLI
//                                                                ├─ OBSERVE_ONLY ───► record
//                                                                └─ REJECTED ───────► record
//
// Rules this class enforces on top of the pieces it wires (docs/agent-implementation-plan.md §2.2):
//   - a simulated result never carries a tx hash and a Live result is never simulated;
//   - the same event never produces a second execution (decision log + executor reconciliation);
//   - an approval created in one mode is not executed in another;
//   - nothing here lets the content of an event choose a contract, an address or a network.

import { createDecisionId } from '../decisionLogger.js';
import { executeWithRetry } from '../executionReliability.js';
import { AgentOrchestrator } from '../orchestrator.js';
import { proposeFromIngest } from '../pipelines/ingestPipeline.js';
import { proposeFromEvent } from '../pipelines/monitorPipeline.js';
import { ApprovalError, APPROVAL_STATUS } from './approvals.js';
import { effectiveAutonomy } from './config.js';
import { normalizeEvent } from './events.js';
import { EXECUTOR_METHOD_FOR, PRICING_ACTION_FOR, ExecutionPendingError } from './executors/chainExecutor.js';
import { buildOwnerPlan, verifyOwnerTx } from './ownerTxPlan.js';
import { INFORMATIONAL_ACTIONS, evaluatePolicy } from './policy.js';
import { PreferenceStore } from './preferences.js';
import { Scheduler } from './scheduler.js';

/** Event types an operator may inject through the API while the runtime is Live: only ones that carry a proof. */
export const LIVE_ADMIN_EVENT_TYPES = Object.freeze([
  'PAYMENT_RECEIVED', 'CARGO_ARRIVED', 'CARGO_DEPARTED', 'INSURANCE_EXPIRED', 'EMERGENCY_STOP_CHANGED', 'REVIEW_RESOLVED'
]);

const OWNER_PLAN_ACTIONS = new Set(['MARK_IN_TRANSIT', 'RECORD_PAYMENT', 'RECORD_ARRIVAL', 'SETTLE', 'CANCEL']);
const COUNTED_STATUSES = new Set(['COMPLETED', 'EXECUTING', 'PENDING_APPROVAL', 'AWAITING_OWNER_SIGNATURE', 'DECIDED']);

export class AgentServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AgentServiceError';
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

/** Serialises async work per key (per pool): a decision and an approval for one pool never interleave. */
class KeyedMutex {
  constructor() {
    this.tails = new Map();
  }

  run(key, task) {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(task);
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return result;
  }
}

export class AgentService {
  /**
   * @param {object} deps  see createAgentService() in src/agent/runtime/factory.js for how the real ones are built
   */
  constructor(deps) {
    Object.assign(this, {
      config: deps.config,
      getMode: deps.getMode ?? (() => 'demo'),
      getGeneration: deps.getGeneration ?? (() => 1),
      store: deps.store,
      ensurePools: deps.ensurePools ?? (async () => {}),
      activity: deps.activity,
      logger: deps.logger,
      approvals: deps.approvals,
      registry: deps.registry,
      bus: deps.bus,
      tracer: deps.tracer,
      sim: deps.sim,
      getChain: deps.getChain ?? (async () => null),
      getChainContext: deps.getChainContext ?? (async () => null),
      chainConfig: deps.chainConfig ?? null,
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep,
      sources: deps.sources ?? [],
      signerRoles: deps.signerRoles ?? (() => ({})),
      preferences: deps.preferences ?? new PreferenceStore(),
      ingest: deps.ingest ?? null,
      orchestrator: deps.orchestrator ?? new AgentOrchestrator(),
      scenarios: deps.scenarios ?? null,
      riskTracker: deps.riskTracker ?? null,
      env: deps.env ?? process.env
    });
    this.mutex = new KeyedMutex();
    this.running = false;
    this.emergencyStopped = false;
    this.autonomyOverride = null;
    this.lastError = null;
    this.initialized = false;
    this.scheduler = new Scheduler({
      task: () => this.tick(),
      intervalMs: this.config.monitorIntervalSec * 1000,
      onError: (error) => this.#noteError(error)
    });
    this.bus.handler = (event) => this.#handleEvent(event);
    this.bus.onSettled = (entry) => this.#onEventSettled(entry);
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    if (this.initialized) return this;
    await Promise.all([this.logger.init(), this.approvals.init(), this.registry.init(), this.bus.init(), this.preferences.init?.(), this.ingest?.init(), this.riskTracker?.init()]);
    await this.syncPools();
    this.initialized = true;
    return this;
  }

  /** Register the pools the agent may act on. Demo: every offchain pool. Live: the known on-chain pools, verified first. */
  async syncPools() {
    const mode = this.getMode();
    if (mode === 'demo') {
      await this.ensurePools();
      await this.registry.registerOffchainBatch([...this.store.pools.values()]
        .map((pool) => ({ case_id: pool.caseData?.case_id ?? pool.poolId, pool_id: pool.poolId })));
      return [];
    }
    const context = await this.getChainContext().catch(() => null);
    if (!context) return [];
    const { createChainReader } = await import('./poolRegistry.js');
    const results = await this.registry.bootstrapLive(createChainReader(context));
    for (const result of results) {
      this.#activity('SYSTEM', result.linked ? 'POOL_LINKED' : 'POOL_LINK_SKIPPED', null, { case_id: result.case_id, chain_pool_id: result.chain_pool_id, reason: result.reason ?? null }, { caseId: result.case_id });
    }
    return results;
  }

  async start() {
    await this.init();
    if (this.running) return this.status();
    this.running = true;
    const autonomy = this.autonomy();
    if (autonomy.downgraded) {
      console.warn('[agentbl] AGENT_AUTONOMY=auto is treated as propose in Live mode: every action needs human approval.');
    }
    this.bus.start();
    this.scheduler.start();
    this.#activity('SYSTEM', 'AGENT_STARTED', null, { mode: this.getMode(), autonomy: autonomy.effective, downgraded: autonomy.downgraded });
    return this.status();
  }

  async stop() {
    if (!this.running) return this.status();
    this.running = false;
    this.scheduler.stop();
    await this.scheduler.drain();
    await this.bus.stop();
    this.#activity('SYSTEM', 'AGENT_STOPPED', null, {});
    return this.status();
  }

  autonomy() {
    return effectiveAutonomy(this.getMode(), this.autonomyOverride ?? this.config.autonomy);
  }

  #noteError(error) {
    this.lastError = { at: this.now().toISOString(), message: String(error?.message ?? error).slice(0, 300) };
  }

  #activity(type, action, decision, details = {}, extra = {}) {
    return this.activity.append({
      type,
      action,
      caseId: decision?.case_id ?? extra.caseId,
      poolId: decision?.pool_id ?? extra.poolId,
      decision_id: decision?.decision_id,
      mode: decision?.mode ?? this.getMode(),
      ...extra.reference !== undefined ? { reference: extra.reference } : {},
      ...extra.tx_hash ? { tx_hash: extra.tx_hash } : {},
      ...extra.explorer_url ? { explorer_url: extra.explorer_url } : {},
      details
    });
  }

  // ---------------------------------------------------------------- status

  async status() {
    const autonomy = this.autonomy();
    const roles = this.signerRoles();
    const busStatus = this.bus.status();
    return {
      running: this.running,
      enabled: this.config.enabled,
      mode: this.getMode(),
      generation: this.getGeneration(),
      autonomy: { configured: this.autonomyOverride ?? this.config.autonomy ?? null, effective: autonomy.effective, downgraded: autonomy.downgraded },
      emergency_stop: this.emergencyStopped,
      scheduler: { interval_sec: this.config.monitorIntervalSec, last_tick_at: this.scheduler.lastRunAt, next_tick_at: this.scheduler.nextRunAt },
      queue: { queued: busStatus.queued, processing: busStatus.processing, counts: busStatus.counts, dead: busStatus.dead },
      executor: this.getMode() === 'live' ? 'chain' : 'sim',
      // Booleans only: whether a key is configured, never anything about the key.
      signers: Object.fromEntries(Object.entries(roles).map(([role, configured]) => [role, { configured: Boolean(configured) }])),
      pending_approvals: this.approvals.pendingCount(),
      awaiting_owner_signature: this.approvals.list({ status: APPROVAL_STATUS.AWAITING_OWNER_SIGNATURE }).length,
      protected_chain_pools: this.config.protectedChainPools,
      scenario: this.scenarios ? (({ loaded, name, next_step: next, total_steps: total, finished }) => ({ loaded, name, next_step: next, total_steps: total, finished }))(this.scenarios.status()) : null,
      last_error: this.lastError,
      activity: { last_seq: this.activity.seq, persist_error: this.activity.lastPersistError }
    };
  }

  // ---------------------------------------------------------------- events

  /**
   * Accept an event from an operator, a monitor or a scenario. `origin: 'api'` applies the Live
   * restrictions for hand-injected events.
   */
  async submitEvent(raw, { origin = 'internal' } = {}) {
    await this.init();
    const mode = this.getMode();
    const event = normalizeEvent(raw, { now: this.now, defaultMode: mode === 'live' ? 'live' : 'demo' });
    if (origin === 'api' && mode === 'live' && !LIVE_ADMIN_EVENT_TYPES.includes(event.type)) {
      throw new AgentServiceError('event_not_allowed_in_live',
        `${event.type} cannot be injected by hand in Live mode; allowed: ${LIVE_ADMIN_EVENT_TYPES.join(', ')}`, 403);
    }
    // Where an event came from and which mode it belongs to is decided here, never by the caller.
    if (origin === 'api') event.source_mode = mode === 'live' ? 'live' : 'demo';
    if (event.type === 'EMERGENCY_STOP_CHANGED') {
      this.emergencyStopped = Boolean(event.data.stopped);
      this.#activity('SYSTEM', 'EMERGENCY_STOP_CHANGED', null, { stopped: this.emergencyStopped }, { caseId: event.case_id });
    }
    const result = await this.bus.submit(event);
    return { ...result, event_type: event.type, case_id: event.case_id, mode };
  }

  /**
   * Accept uploaded documents: validate and store them, open a job and queue the DOCUMENTS_INGESTED
   * event that the ingest pipeline answers. Uploading the same bytes for the same case again returns
   * the same job instead of a second decision.
   */
  async submitDocuments(body) {
    await this.init();
    if (!this.ingest) throw new AgentServiceError('ingest_unavailable', 'This runtime has no document intake', 503);
    const { job, documents, created } = await this.ingest.accept(body);
    if (body.exporter_preferences !== undefined) await this.preferences.put(job.case_id, body.exporter_preferences);
    let accepted = null;
    if (created) {
      accepted = await this.submitEvent({
        event_id: job.event_id,
        type: 'DOCUMENTS_INGESTED',
        case_id: job.case_id,
        source: 'ingest',
        data: { job_id: job.job_id, document_ids: job.document_ids }
      });
    }
    return { job: this.ingest.getJob(job.job_id), documents, created, idempotency_key: accepted?.idempotency_key ?? `event:${job.event_id}` };
  }

  async setPreferences(caseId, input) {
    await this.init();
    const stored = await this.preferences.put(caseId, input);
    this.#activity('SYSTEM', 'EXPORTER_PREFERENCES_SET', null, { preferences: stored.preferences }, { caseId });
    return stored;
  }

  /** Wait until an event has been handled (or give up), and say what happened. For the Demo UI and tests. */
  async waitFor(idempotencyKey, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entry = this.bus.get(idempotencyKey);
      if (!entry) return { status: 'UNKNOWN' };
      if (!['RECEIVED', 'PROCESSING'].includes(entry.status)) {
        return { status: entry.status, result: entry.result ?? null, error: entry.error ?? null, note: entry.note ?? null };
      }
      if (Date.now() >= deadline) return { status: entry.status, timed_out: true };
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  #onEventSettled(entry) {
    if (entry.status === 'DEAD') {
      this.#noteError(new Error(`event ${entry.event_id} dead-lettered: ${entry.error?.message}`));
      this.#activity('SYSTEM', 'EVENT_DEAD_LETTERED', null, { event_id: entry.event_id, type: entry.type, attempts: entry.attempts, error: entry.error?.message }, { caseId: entry.case_id });
    } else if (entry.status === 'STALE') {
      this.#activity('SYSTEM', 'EVENT_STALE', null, { event_id: entry.event_id, type: entry.type, note: entry.note }, { caseId: entry.case_id });
    }
  }

  /** Bus handler: one event → zero or more decisions. Idempotent by decision id. */
  async #handleEvent(event) {
    const mode = this.getMode();
    const run = this.tracer.startRun({ name: 'agent.event', attributes: { event_type: event.type, case_id: event.case_id, source: event.source, mode } });
    try {
      if (event.type === 'EMERGENCY_STOP_CHANGED') {
        await run.end('ok');
        return { ignored: 'handled at submission' };
      }
      await this.ensurePools();
      const pool = this.store.pools.get(event.pool_id ?? event.case_id) ?? this.#poolByCase(event.case_id);
      const proposed = event.type === 'DOCUMENTS_INGESTED'
        ? await this.#proposeFromUpload(event, pool, run)
        : await run.span('monitor_pipeline', async () => proposeFromEvent(event, { pool, mode, now: () => Date.now() }), { event_type: event.type });
      if (proposed.proposals.length === 0) {
        this.#activity('SYSTEM', 'EVENT_IGNORED', null, { event_id: event.event_id, type: event.type, reason: proposed.ignored }, { caseId: event.case_id, poolId: pool?.poolId });
        await run.end('ok');
        return { ignored: proposed.ignored, decisions: [] };
      }
      const decisions = [];
      for (const [index, proposal] of proposed.proposals.entries()) {
        const decision = await this.#decide(event, pool, proposal, index, run);
        decisions.push(decision.decision_id);
      }
      if (event.type === 'DOCUMENTS_INGESTED') await this.#finishJob(event, { status: 'DONE', decision_ids: decisions });
      await run.end('ok');
      return { decisions };
    } catch (error) {
      if (event.type === 'DOCUMENTS_INGESTED') {
        await this.#finishJob(event, { status: 'FAILED', error: { code: error.code ?? 'ingest_failed', message: String(error.message ?? error).slice(0, 300) } });
      }
      await run.end('error');
      throw error;
    }
  }

  /** The ingest pipeline for a DOCUMENTS_INGESTED event: reports each step to the job, the feed and the trace. */
  async #proposeFromUpload(event, pool, run) {
    if (!this.ingest) return { proposals: [], ignored: 'This runtime has no document intake' };
    const jobId = event.data?.job_id;
    if (jobId) await this.ingest.updateJob(jobId, { status: 'RUNNING', started_at: this.now().toISOString() });
    this.#activity('PIPELINE', 'INGEST_STARTED', null, { job_id: jobId ?? null, documents: event.data?.document_ids?.length ?? 0 }, { caseId: event.case_id, poolId: pool?.poolId });
    return run.span('ingest_pipeline', async () => proposeFromIngest(event, {
      ingest: this.ingest,
      orchestrator: this.orchestrator,
      preferences: this.preferences,
      pool,
      forceDeterministic: !this.config.valuationLlm,
      valuation: { env: this.env },
      worldRisk: { env: this.env },
      onStep: async (step) => {
        if (jobId) await this.ingest.recordStep(jobId, step);
        this.#activity('PIPELINE', 'PIPELINE_STEP', null, { job_id: jobId ?? null, ...step }, { caseId: event.case_id, poolId: pool?.poolId });
      }
    }), { event_type: event.type });
  }

  async #finishJob(event, patch) {
    const jobId = event.data?.job_id;
    if (!jobId || !this.ingest) return;
    await this.ingest.updateJob(jobId, { ...patch, finished_at: this.now().toISOString() });
  }

  #poolByCase(caseId) {
    for (const pool of this.store.pools.values()) {
      if (pool.caseData?.case_id === caseId) return pool;
    }
    return null;
  }

  // ---------------------------------------------------------------- decisions

  async #decide(event, pool, proposal, index, run) {
    const mode = this.getMode();
    const poolId = pool?.poolId ?? event.pool_id ?? event.case_id;
    const idempotencyKey = index === 0 ? event.idempotency_key : `${event.idempotency_key}#${index}`;
    const core = {
      idempotency_key: idempotencyKey,
      event_id: event.event_id,
      event_type: event.type,
      case_id: event.case_id,
      pool_id: poolId,
      action: proposal.action,
      input_snapshot: proposal.input_snapshot,
      evidence_hash: proposal.evidence_hash
    };
    const decisionId = createDecisionId(core);
    run.bindDecision(run.decision_id ?? decisionId);

    // A restart can replay an event whose decision already exists: continue it, never redo it.
    const existing = await this.logger.get(decisionId);
    if (existing) {
      if (existing.status === 'DECIDED') return this.#route(existing, event, pool, run);
      return existing;
    }

    const entry = this.registry.get(event.case_id) ?? this.registry.get(poolId);
    const chainPoolId = entry?.chain?.pool_id ?? event.chain_pool_id ?? null;
    const protectedPool = this.registry.isProtected(event.case_id) || this.registry.isProtected(poolId);
    const autonomy = this.autonomy();
    const policyStarted = Date.now();
    const policy = await run.span('policy', async () => evaluatePolicy(
      {
        action: proposal.action,
        pool_id: poolId,
        findings: proposal.findings,
        llm_only: proposal.llm_only,
        price_move_bps: proposal.price_move_bps,
        new_issue_price_usd: proposal.new_issue_price_usd
      },
      {
        mode,
        autonomy: autonomy.effective,
        protectedPool,
        emergencyStopped: await this.#emergencyStopped(),
        evidenceStale: false,
        recentActions: await this.#recentActions(poolId),
        now: this.now().getTime(),
        exporterPreferences: this.preferences.get(event.case_id),
        thresholds: {
          maxPriceMoveBps: this.config.maxPriceMoveBps,
          cooldownSec: this.config.cooldownSec,
          maxActionsPerPoolPerDay: this.config.maxActionsPerPoolPerDay,
          allowUnattendedIrreversible: this.config.allowUnattendedIrreversible
        }
      }
    ));
    const action = policy.action_override ?? proposal.action;
    const record = await this.logger.record({
      ...core,
      decision_id: decisionId,
      action,
      proposed_action: proposal.action,
      reasoning_summary: proposal.reasoning_summary,
      mode,
      generation: this.getGeneration(),
      chain_pool_id: chainPoolId,
      pipeline: [...proposal.pipeline, { step: 'policy', status: policy.verdict === 'REJECTED' ? 'FAIL' : 'PASS', duration_ms: Date.now() - policyStarted }],
      findings: proposal.findings,
      quote_hash: proposal.quote_hash,
      proposal: { params: proposal.params, price_move_bps: proposal.price_move_bps ?? null, new_issue_price_usd: proposal.new_issue_price_usd ?? null },
      policy: { verdict: policy.verdict, reasons: policy.reasons, autonomy: policy.autonomy },
      status: 'DECIDED',
      trace_id: run.trace_id
    });
    this.#activity('DECISION', 'DECISION_MADE', record, {
      decision_action: record.action,
      verdict: policy.verdict,
      reasons: policy.reasons.map((reason) => reason.rule),
      summary: record.reasoning_summary,
      event_type: event.type
    });
    return this.#route(record, event, pool, run);
  }

  async #emergencyStopped() {
    if (this.emergencyStopped) return true;
    if (this.getMode() !== 'live') return false;
    try {
      const context = await this.getChainContext();
      return context ? Boolean(await context.pool.emergencyStopped()) : false;
    } catch {
      return false;
    }
  }

  async #recentActions(poolId) {
    const records = await this.logger.list({ pool_id: poolId });
    return records
      .filter((record) => COUNTED_STATUSES.has(record.status) && record.mode === this.getMode())
      .map((record) => ({ action: record.action, at: record.created_at }));
  }

  async #route(decision, event, pool, run) {
    const verdict = decision.policy.verdict;
    if (verdict === 'REJECTED') return this.#finish(decision, 'REJECTED', { note: decision.policy.reasons[0]?.message });
    if (verdict === 'OBSERVE_ONLY') return this.#finish(decision, 'SKIPPED', { note: decision.policy.reasons[0]?.message });

    const informational = INFORMATIONAL_ACTIONS.includes(decision.action);
    const needsChain = this.getMode() === 'live' && !informational;
    if (needsChain && !decision.chain_pool_id) {
      return this.#finish(decision, 'SKIPPED', { note: 'No on-chain pool is mapped for this case, so the proposal is recorded but nothing can be executed on-chain.' });
    }

    if (verdict === 'NEEDS_APPROVAL' && !informational) {
      return this.#requestApproval(decision);
    }
    return this.mutex.run(decision.pool_id, () => this.#execute(decision, run));
  }

  async #finish(decision, status, extra = {}) {
    const updated = await this.logger.update(decision.decision_id, { status, ...extra });
    if (status === 'REJECTED' || status === 'SKIPPED') {
      this.#activity('DECISION', status === 'REJECTED' ? 'DECISION_REJECTED' : 'DECISION_RECORDED', updated, { decision_action: updated.action, note: extra.note ?? null });
    }
    return updated;
  }

  // ---------------------------------------------------------------- execution

  /** Which executor handles a decision in the current mode, or null when the server cannot (an operator signs). */
  async #executorFor(decision) {
    if (this.getMode() === 'demo') return { kind: 'sim', executor: this.sim };
    const chain = await this.getChain();
    if (!chain) return null;
    if (PRICING_ACTION_FOR[decision.action] || (EXECUTOR_METHOD_FOR[decision.action] && await chain.canExecute(decision.action))) {
      return { kind: 'chain', executor: chain };
    }
    return null;
  }

  #command(decision, onSubmitted) {
    return {
      decision_id: decision.decision_id,
      idempotency_key: decision.idempotency_key,
      action: decision.action,
      case_id: decision.case_id,
      pool_id: decision.pool_id,
      chain_pool_id: decision.chain_pool_id ?? null,
      params: decision.proposal?.params ?? {},
      onSubmitted
    };
  }

  async #execute(decision, run, approval = null) {
    const informational = INFORMATIONAL_ACTIONS.includes(decision.action);
    if (informational && this.getMode() === 'live') {
      // A Live record changes nothing on-chain. The offchain mirror is updated and nothing is claimed as executed.
      await this.#mirror(decision);
      return this.#complete(decision, { mode: 'record', reference: null, note: 'Recorded only; nothing was sent on-chain.', attempts: 0 });
    }

    const route = await this.#executorFor(decision);
    if (!route) {
      return this.#fail(decision, {
        code: this.getMode() === 'live' ? 'chain_unavailable' : 'no_executor',
        message: this.getMode() === 'live'
          ? 'The server cannot send this action (no signer for it, or the chain is unreachable)'
          : 'No executor is available for this action'
      }, approval);
    }

    await this.logger.update(decision.decision_id, { status: 'EXECUTING' });
    this.#activity('EXECUTION', 'EXECUTION_SUBMITTED', decision, { decision_action: decision.action, executor: route.kind });
    const started = Date.now();
    const ownRun = !run;
    const activeRun = run ?? this.tracer.startRun({ decision_id: decision.decision_id, name: 'agent.execute' });
    try {
      const retried = await activeRun.span('execute', async () => executeWithRetry(
        () => route.executor.execute(this.#command(decision, async (info) => {
          // Persist the hash as soon as it exists: a crash before the receipt can then be reconciled by hash.
          await this.logger.update(decision.decision_id, { status: 'EXECUTING', execution: { mode: 'chain', ...info } });
          this.#activity('EXECUTION', 'EXECUTION_BROADCAST', decision, { decision_action: decision.action }, { tx_hash: info.tx_hash });
        })),
        { maxAttempts: 3, baseDelayMs: 300, sleep: this.sleep, shouldRetry: (error) => error?.retryable === true }
      ), { executor: route.kind });
      const result = retried.value;
      if (route.kind === 'chain') await this.#mirror(decision);
      if (result.skipped) {
        return this.#finish(decision, 'SKIPPED', { note: result.note, execution: this.#executionRecord(result, retried.attempts, started) });
      }
      return this.#complete(decision, this.#executionRecord(result, retried.attempts, started), approval);
    } catch (thrown) {
      // executeWithRetry wraps whatever the executor threw; the executor's own error is what matters.
      const error = thrown?.name === 'RetryExhaustedError' && thrown.cause ? thrown.cause : thrown;
      if (error instanceof ExecutionPendingError) {
        await this.logger.update(decision.decision_id, { status: 'EXECUTING', execution: { mode: 'chain', tx_hash: error.tx_hash, pending: true } });
        this.#activity('EXECUTION', 'EXECUTION_PENDING', decision, { decision_action: decision.action }, { tx_hash: error.tx_hash });
        return this.logger.get(decision.decision_id);
      }
      return this.#fail(decision, error, approval);
    } finally {
      if (ownRun) await activeRun.end('ok');
    }
  }

  #executionRecord(result, attempts, started) {
    return {
      mode: result.mode,
      signer_role: result.signer_role ?? null,
      reference: result.reference ?? null,
      ...(result.tx_hash ? { tx_hash: result.tx_hash } : {}),
      ...(result.explorer_url ? { explorer_url: result.explorer_url } : {}),
      ...(result.block_number !== undefined ? { block_number: result.block_number } : {}),
      ...(result.confirmed_events ? { confirmed_events: result.confirmed_events } : {}),
      ...(result.effects ? { effects: result.effects } : {}),
      ...(result.note ? { note: result.note } : {}),
      attempts: result.attempts ?? attempts,
      duration_ms: Date.now() - started
    };
  }

  async #complete(decision, execution, approval = null) {
    const updated = await this.logger.update(decision.decision_id, { status: 'COMPLETED', execution, error: undefined });
    await this.#maybeProposeSettlement(updated);
    if (approval) await this.approvals.markExecuted(approval.approval_id, { reference: execution.reference, tx_hash: execution.tx_hash ?? null });
    this.#activity('EXECUTION', 'EXECUTION_CONFIRMED', updated, {
      decision_action: updated.action,
      mode: execution.mode,
      signer_role: execution.signer_role,
      effects: execution.effects ?? null,
      block_number: execution.block_number ?? null
    }, {
      reference: execution.reference ?? undefined,
      tx_hash: execution.tx_hash,
      explorer_url: execution.explorer_url
    });
    return updated;
  }

  /**
   * Once both settlement proofs are on record the pool can be settled. The agent proposes SETTLE as its
   * own event, so the policy engine (which always asks for approval) decides what happens next.
   */
  async #maybeProposeSettlement(decision) {
    if (!['RECORD_PAYMENT', 'RECORD_ARRIVAL'].includes(decision.action)) return;
    const pool = this.store.pools.get(decision.pool_id) ?? this.#poolByCase(decision.case_id);
    const settlement = pool?.settlement;
    if (!settlement?.payment_proof || !settlement?.arrival_proof || settlement.settled_at) return;
    const event = normalizeEvent({
      event_id: `settlement-ready:${decision.mode}:${pool.poolId}`,
      type: 'SETTLEMENT_READY',
      case_id: decision.case_id,
      pool_id: pool.poolId,
      source: 'agent',
      source_mode: decision.mode,
      data: { repayment_amount: settlement.repayment_amount, trigger_decision: decision.decision_id }
    }, { now: this.now, defaultMode: decision.mode });
    await this.bus.submit(event).catch((error) => this.#noteError(error));
  }

  async #fail(decision, error, approval = null) {
    const failure = { code: error.code ?? error.name ?? 'error', message: String(error.message ?? error).slice(0, 500) };
    const updated = await this.logger.update(decision.decision_id, { status: 'FAILED', error: failure });
    if (approval) await this.approvals.markFailed(approval.approval_id, failure).catch(() => {});
    this.#noteError(error);
    this.#activity('EXECUTION', 'EXECUTION_FAILED', updated, { decision_action: updated.action, ...failure });
    return updated;
  }

  /** Keep the offchain mirror of a Live pool in step with what just happened on-chain. Best effort. */
  async #mirror(decision) {
    try {
      await this.sim.execute({
        ...this.#command(decision),
        idempotency_key: `mirror:${decision.idempotency_key}`
      });
    } catch {
      // The mirror is advisory; the chain is the source of truth and the watcher reconciles it (WP2.7).
    }
  }

  // ---------------------------------------------------------------- approvals

  async #requestApproval(decision) {
    const mode = this.getMode();
    let route = 'sim';
    let plan = null;
    if (mode === 'live') {
      const chosen = await this.#executorFor(decision);
      route = chosen ? 'server' : 'owner_cli';
      if (route === 'owner_cli') {
        if (!OWNER_PLAN_ACTIONS.has(decision.action)) {
          return this.#finish(decision, 'SKIPPED', { note: `${decision.action} has no signing route yet in Live (no key can send it)` });
        }
        plan = await buildOwnerPlan({
          action: decision.action,
          chain_pool_id: decision.chain_pool_id,
          params: decision.proposal?.params ?? {},
          chainConfig: this.chainConfig
        });
      }
    }
    const approval = await this.approvals.create({
      decision_id: decision.decision_id,
      route,
      case_id: decision.case_id,
      pool_id: decision.pool_id,
      action: decision.action,
      mode,
      summary: decision.reasoning_summary,
      plan,
      ttlSec: this.config.approvalTtlSec
    });
    const updated = await this.logger.update(decision.decision_id, { status: 'PENDING_APPROVAL', approval: { approval_id: approval.approval_id, status: approval.status, route, expires_at: approval.expires_at } });
    this.#activity('APPROVAL', 'APPROVAL_REQUESTED', updated, { decision_action: updated.action, approval_id: approval.approval_id, route, expires_at: approval.expires_at });
    return updated;
  }

  async approve(approvalId, { by = 'admin', note = null } = {}) {
    await this.init();
    const approval = await this.approvals.approve(approvalId, { by, note });
    const decision = await this.logger.get(approval.decision_id);
    if (!decision) throw new AgentServiceError('decision_missing', `Decision ${approval.decision_id} of approval ${approvalId} is gone`, 409);
    this.#activity('APPROVAL', 'APPROVAL_GRANTED', decision, { decision_action: decision.action, approval_id: approvalId, by });
    await this.logger.update(decision.decision_id, { approval: { approval_id: approvalId, status: 'APPROVED', route: approval.route, decided_by: by, decided_at: approval.decided_at } });

    if (approval.mode !== this.getMode()) {
      await this.approvals.markFailed(approvalId, { code: 'mode_changed', message: `Approved in ${this.getMode()} but created in ${approval.mode}` });
      await this.#fail(decision, { code: 'mode_changed', message: `The runtime mode changed from ${approval.mode} to ${this.getMode()} before this was approved` });
      throw new AgentServiceError('mode_changed', 'The runtime mode changed since this proposal was made; it was not executed', 409);
    }

    if (approval.route === 'owner_cli') {
      await this.approvals.markAwaitingOwner(approvalId);
      const waiting = await this.logger.update(decision.decision_id, { status: 'AWAITING_OWNER_SIGNATURE' });
      this.#activity('APPROVAL', 'OWNER_SIGNATURE_REQUIRED', waiting, { decision_action: waiting.action, approval_id: approvalId, steps: approval.plan?.steps?.length ?? 0 });
      return { approval: this.approvals.get(approvalId), decision: waiting };
    }

    const executed = await this.mutex.run(decision.pool_id, () => this.#execute(decision, null, approval));
    return { approval: this.approvals.get(approvalId), decision: executed };
  }

  async reject(approvalId, { by = 'admin', note = null } = {}) {
    await this.init();
    const approval = await this.approvals.reject(approvalId, { by, note });
    const decision = await this.logger.update(approval.decision_id, { status: 'REJECTED', note: note ?? 'Rejected by an operator', approval: { approval_id: approvalId, status: 'REJECTED', route: approval.route, decided_by: by, decided_at: approval.decided_at } });
    this.#activity('APPROVAL', 'APPROVAL_REJECTED', decision, { decision_action: decision.action, approval_id: approvalId, by, note });
    return { approval: this.approvals.get(approvalId), decision };
  }

  /**
   * Record a transaction an operator signed with the owner key. Nothing is trusted from the caller
   * except the hash: the chain is asked what that transaction really did.
   */
  async attachTx(approvalId, { tx_hash: txHash, step_index: stepIndex = 0 }, { verify } = {}) {
    await this.init();
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new ApprovalError('approval_not_found', `Unknown approval ${approvalId}`, 404);
    if (approval.status !== APPROVAL_STATUS.AWAITING_OWNER_SIGNATURE) {
      throw new ApprovalError('invalid_transition', `Approval ${approvalId} is ${approval.status}; it is not waiting for an owner signature`);
    }
    const step = approval.plan?.steps?.[stepIndex];
    if (!step) throw new ApprovalError('unknown_step', `Approval ${approvalId} has no step ${stepIndex}`, 400);

    const verifier = verify ?? ((input) => this.#verifyOwnerStep(input));
    const verdict = await verifier({ step, txHash });
    if (!verdict.ok) {
      this.#activity('APPROVAL', 'OWNER_TX_REJECTED', null, { approval_id: approvalId, step: stepIndex, errors: verdict.errors }, { caseId: approval.case_id, poolId: approval.pool_id });
      throw new ApprovalError('tx_verification_failed', `The transaction does not match the approved plan: ${verdict.errors.join('; ')}`, 422);
    }

    const recorded = await this.approvals.recordStep(approvalId, {
      index: stepIndex, tx_hash: txHash, block_number: verdict.block_number, from: verdict.from, confirmed_events: verdict.confirmed_events, verified_at: this.now().toISOString()
    });
    const decision = await this.logger.get(approval.decision_id);
    if (!recorded.complete) return { approval: recorded.approval, decision, complete: false };

    const base = String(this.chainConfig?.explorerBase ?? '').replace(/\/$/u, '');
    const last = recorded.approval.steps_done.at(-1);
    const execution = {
      mode: 'chain',
      signer_role: 'OWNER_CLI',
      reference: last.tx_hash,
      tx_hash: last.tx_hash,
      tx_hashes: recorded.approval.steps_done.map((done) => done.tx_hash),
      explorer_url: base ? `${base}/tx/${last.tx_hash}` : undefined,
      block_number: last.block_number,
      confirmed_events: recorded.approval.steps_done.flatMap((done) => done.confirmed_events ?? []),
      attempts: 1
    };
    await this.#mirror(decision);
    const completed = await this.#complete(decision, execution, recorded.approval);
    return { approval: this.approvals.get(approvalId), decision: completed, complete: true };
  }

  async #verifyOwnerStep({ step, txHash }) {
    const context = await this.getChainContext();
    if (!context) return { ok: false, errors: ['The chain is not reachable from this server, so the transaction cannot be verified'], confirmed_events: [] };
    const { Interface } = await import('ethers');
    const abi = this.chainConfig?.abis?.[step.contract];
    if (!abi) return { ok: false, errors: [`No ABI for ${step.contract}`], confirmed_events: [] };
    const allowed = [];
    try {
      allowed.push(await context.pool.owner());
    } catch {
      return { ok: false, errors: ['Could not read the contract owner to check who sent the transaction'], confirmed_events: [] };
    }
    if (context.signers?.AGENT_EXECUTOR) allowed.push(context.signers.AGENT_EXECUTOR);
    return verifyOwnerTx({ step, txHash, provider: context.provider, iface: new Interface(abi), allowedSenders: allowed });
  }

  // ---------------------------------------------------------------- periodic work

  /** One scheduler tick: expire approvals, reconcile submitted transactions, poll the sources. */
  async tick() {
    await this.init();
    const expired = await this.approvals.expireStale();
    for (const approval of expired) {
      const decision = await this.logger.get(approval.decision_id);
      if (decision && ['PENDING_APPROVAL', 'AWAITING_OWNER_SIGNATURE'].includes(decision.status)) {
        const updated = await this.logger.update(decision.decision_id, { status: 'SKIPPED', note: 'The approval expired before anyone acted on it', approval: { ...decision.approval, status: 'EXPIRED' } });
        this.#activity('APPROVAL', 'APPROVAL_EXPIRED', updated, { decision_action: updated.action, approval_id: approval.approval_id });
      }
    }
    await this.#reconcilePending();
    for (const source of this.sources) {
      try {
        const events = await source({ service: this });
        for (const raw of events ?? []) await this.submitEvent(raw, { origin: 'internal' });
      } catch (error) {
        this.#noteError(error);
      }
    }
    await this.logger.prune({ maxRecords: this.config.maxDecisions, olderThanMs: this.config.retentionDays * 24 * 3600 * 1000 });
    return { ok: true, expired: expired.length };
  }

  async #reconcilePending() {
    if (this.getMode() !== 'live') return;
    const pending = (await this.logger.list({ status: 'EXECUTING' })).filter((decision) => decision.execution?.tx_hash && decision.mode === 'live');
    if (!pending.length) return;
    const chain = await this.getChain();
    if (!chain) return;
    for (const decision of pending) {
      try {
        const result = await chain.findTransaction(decision.execution.tx_hash, decision.action);
        if (!result) continue;
        const approval = this.approvals.list({ decision_id: decision.decision_id })[0] ?? null;
        await this.#mirror(decision);
        await this.#complete(decision, this.#executionRecord(result, 1, Date.now()), approval && approval.status === APPROVAL_STATUS.APPROVED ? approval : null);
      } catch (error) {
        await this.#fail(decision, error);
      }
    }
  }

  // ---------------------------------------------------------------- operator controls

  async control({ action, autonomy, stopped, ...rest }) {
    await this.init();
    switch (action) {
      case 'start':
        return this.start();
      case 'stop':
        return this.stop();
      case 'tick':
        await this.scheduler.trigger();
        return this.status();
      case 'set_autonomy': {
        if (!['off', 'observe', 'propose', 'auto'].includes(autonomy)) throw new AgentServiceError('invalid_autonomy', 'autonomy must be off, observe, propose or auto');
        this.autonomyOverride = autonomy;
        const effective = this.autonomy();
        this.#activity('SYSTEM', 'AUTONOMY_CHANGED', null, { requested: autonomy, effective: effective.effective, downgraded: effective.downgraded });
        return this.status();
      }
      case 'emergency_stop':
        this.emergencyStopped = stopped !== false;
        this.#activity('SYSTEM', 'EMERGENCY_STOP_CHANGED', null, { stopped: this.emergencyStopped, ...rest.reason ? { reason: String(rest.reason).slice(0, 200) } : {} });
        return this.status();
      default:
        throw new AgentServiceError('invalid_action', 'action must be start, stop, tick, set_autonomy or emergency_stop');
    }
  }

  // ---------------------------------------------------------------- Demo reset

  /** Clear everything the agent recorded in Demo mode. Live records are never touched. */
  async resetDemo() {
    await this.init();
    const removed = await this.logger.clearWhere((record) => record.mode === 'demo');
    await this.approvals.clearMode('demo');
    await this.bus.clearMode('demo');
    await this.activity.clearMode('demo');
    await this.registry.clearOffchain();
    this.sim.done.clear();
    await this.ingest?.clear();
    await this.riskTracker?.clear();
    await this.scenarios?.stop();
    await this.preferences.clear?.();
    this.emergencyStopped = false;
    await this.syncPools();
    return { removed_decisions: removed };
  }

  // ---------------------------------------------------------------- reads

  async listDecisions({ case_id: caseId, pool_id: poolId, status, action, limit = 50, cursor } = {}) {
    const all = await this.logger.list();
    let items = all;
    if (caseId) items = items.filter((record) => record.case_id === caseId);
    if (poolId) items = items.filter((record) => record.pool_id === poolId);
    if (status) items = items.filter((record) => record.status === status);
    if (action) items = items.filter((record) => record.action === action);
    // Newest first; records created in the same millisecond keep their insertion order (newest last-inserted first).
    const order = new Map(all.map((record, index) => [record.decision_id, index]));
    items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || order.get(b.decision_id) - order.get(a.decision_id));
    const start = cursor ? Math.max(0, items.findIndex((record) => record.decision_id === cursor) + 1) : 0;
    const page = items.slice(start, start + limit);
    return { decisions: page, count: items.length, next_cursor: start + limit < items.length ? page.at(-1)?.decision_id : null };
  }

  getDecision(id) {
    return this.logger.get(id);
  }

  async getTrace(id) {
    return this.tracer.getByDecision(id);
  }
}
