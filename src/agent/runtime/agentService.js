// AgentService: the one object that wires the runtime
// together. An event goes in; out come decisions with a recorded policy verdict, and -- depending on
// that verdict, the mode and the autonomy level -- either an executed (Demo, simulated) action, an
// approval waiting for a human, or just a record.
//
//   event ─► EventBus ─► monitor pipeline ─► proposal ─► policy ─┬─ AUTO ───────────► executor
//                                                                ├─ NEEDS_APPROVAL ─► approval queue ─► Demo executor
//                                                                ├─ OBSERVE_ONLY ───► record
//                                                                └─ REJECTED ───────► record
//
// Rules this class enforces on top of the pieces it wires:
//   - a simulated result never carries a tx hash and a Live result is never simulated;
//   - the same event never produces a second execution (decision log + executor reconciliation);
//   - an approval created in one mode is not executed in another;
//   - nothing here lets the content of an event choose a contract, an address or a network.

import { eventFreshness, assessFreshness } from './freshness.js';
import { replayDecision } from './replay.js';
import { sanitizeAudit } from '../security/privacy.js';
import { createDecisionId } from '../decisionLogger.js';
import { executeWithRetry } from '../executionReliability.js';
import { AgentOrchestrator } from '../orchestrator.js';
import { proposeFromIngest } from '../pipelines/ingestPipeline.js';
import { proposeFromEvent } from '../pipelines/monitorPipeline.js';
import { APPROVAL_STATUS } from './approvals.js';
import { effectiveAutonomy } from './config.js';
import { normalizeEvent } from './events.js';
import { INFORMATIONAL_ACTIONS, evaluatePolicy } from './policy.js';
import { PreferenceStore, parsePreferences } from './preferences.js';
import { Scheduler } from './scheduler.js';
import { hashSnapshot } from '../decisionLogger.js';
import { createAgentVersion } from './agentVersion.js';
const SETTLEMENT_ACTIONS = ['RECORD_PAYMENT', 'RECORD_ARRIVAL', 'SETTLE'];

/** Event types an operator may inject through the API while the runtime is Live: only ones that carry a proof. */
export const LIVE_ADMIN_EVENT_TYPES = Object.freeze(['PAYMENT_RECEIVED', 'CARGO_ARRIVED', 'CARGO_DEPARTED', 'INSURANCE_EXPIRED', 'EMERGENCY_STOP_CHANGED', 'REVIEW_RESOLVED']);
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
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
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
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep,
      sources: deps.sources ?? [],
      signerRoles: deps.signerRoles ?? (() => ({})),
      preferences: deps.preferences ?? new PreferenceStore(),
      ingest: deps.ingest ?? null,
      orchestrator: deps.orchestrator ?? new AgentOrchestrator(),
      documentParser: deps.documentParser ?? {},
      scenarios: deps.scenarios ?? null,
      riskTracker: deps.riskTracker ?? null,
      chainWatcher: deps.chainWatcher ?? null,
      anchoring: deps.anchoring ?? null,
      // Whether new material may enter (the server's readiness). Every intake entry point calls the service, so
      // the gate holds for aliases and retries without each route having to remember it.
      intakeGate: deps.intakeGate ?? (() => ({ ok: true })),
      env: deps.env ?? process.env
    });
    this.mutex = new KeyedMutex();
    this.running = false;
    this.localEmergencyStopped = false;
    this.chainEmergencyStopped = false;
    this.chainSafetyUnknown = Boolean(this.chainWatcher);
    this.autonomyOverride = null;
    this.lastError = null;
    this.initialized = false;
    this.scheduler = new Scheduler({
      task: () => this.tick(),
      intervalMs: this.config.monitorIntervalSec * 1000,
      onError: error => this.#noteError(error)
    });
    this.bus.handler = event => this.#handleEvent(event);
    this.bus.onSettled = entry => this.#onEventSettled(entry);
  }

  /**
   * Live chain safety is unknown until the watcher has confirmed a caught-up chain, and again once
   * that confirmation is older than the watcher's staleness bound. Watcher failures set the flag.
   */
  get chainSafetyUnknown() {
    return this.chainSafetyFlag || Boolean(this.chainWatcher?.confirmationStale?.());
  }
  set chainSafetyUnknown(value) {
    this.chainSafetyFlag = Boolean(value);
  }
  get emergencyStopped() {
    return this.localEmergencyStopped || this.getMode() === 'live' && (this.chainEmergencyStopped || this.chainSafetyUnknown);
  }
  set emergencyStopped(value) {
    this.localEmergencyStopped = Boolean(value);
  }
  async onModeChanged() {
    await this.scenarios?.stopPlayback();
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    if (this.initialized) return this;
    await Promise.all([this.logger.init(), this.approvals.init(), this.registry.init(), this.bus.init(), this.preferences.init?.(), this.ingest?.init(), this.riskTracker?.init()]);
    await this.syncPools();
    await this.anchoring?.init();
    await this.anchoring?.collect();
    this.initialized = true;
    return this;
  }

  /** Register the pools the agent may act on. Demo: every offchain pool. Live: the known on-chain pools, verified first. */
  async syncPools() {
    if (this.getMode() !== 'demo') return [];
    await this.ensurePools();
    await this.registry.registerOffchainBatch([...this.store.pools.values()].map(pool => ({
      case_id: pool.caseData?.case_id ?? pool.poolId,
      pool_id: pool.poolId
    })));
    return [];
  }
  async start() {
    await this.init();
    if (this.running) return this.status();
    this.running = true;
    await this.anchoring?.start();
    await this.chainWatcher?.poll(this);
    const autonomy = this.autonomy();
    if (autonomy.downgraded) {
      console.warn('[agentbl] AGENT_AUTONOMY=auto is treated as propose in Live mode: every action needs human approval.');
    }
    this.bus.start();
    this.chainWatcher?.start(this);
    this.scheduler.start();
    this.#activity('SYSTEM', 'AGENT_STARTED', null, {
      mode: this.getMode(),
      autonomy: autonomy.effective,
      downgraded: autonomy.downgraded
    });
    return this.status();
  }
  async stop() {
    await this.scenarios?.stopPlayback();
    if (!this.running) {
      await this.anchoring?.stop();
      return this.status();
    }
    this.running = false;
    this.scheduler.stop();
    await this.scheduler.drain();
    await this.chainWatcher?.stop();
    await this.bus.stop();
    await this.anchoring?.stop();
    this.#activity('SYSTEM', 'AGENT_STOPPED', null, {});
    return this.status();
  }
  autonomy() {
    return effectiveAutonomy(this.getMode(), this.autonomyOverride ?? this.config.autonomy);
  }
  #noteError(error) {
    this.lastError = sanitizeAudit({
      at: this.now().toISOString(),
      message: String(error?.message ?? error).slice(0, 300)
    });
  }
  #activity(type, action, decision, details = {}, extra = {}) {
    return this.activity.append({
      type,
      action,
      caseId: decision?.case_id ?? extra.caseId,
      poolId: decision?.pool_id ?? extra.poolId,
      decision_id: decision?.decision_id,
      mode: decision?.mode ?? this.getMode(),
      ...(extra.reference !== undefined ? {
        reference: extra.reference
      } : {}),
      ...(extra.tx_hash ? {
        tx_hash: extra.tx_hash
      } : {}),
      ...(extra.explorer_url ? {
        explorer_url: extra.explorer_url
      } : {}),
      details
    });
  }

  // ---------------------------------------------------------------- status

  async status() {
    const autonomy = this.autonomy();
    const roles = this.signerRoles();
    const busStatus = this.bus.status();
    const observedSources = [...this.store.pools.values()].map(pool => pool.quote?.data_quality).filter(Boolean);
    const sources = {
      observed: observedSources.length > 0,
      total: observedSources.length,
      expired_live: observedSources.filter(source => source.status === 'live' && (!Number.isFinite(Date.parse(source.expires_at)) || Date.parse(source.expires_at) <= this.now().getTime())).length,
      unavailable: observedSources.filter(source => ['stale', 'unavailable'].includes(source.status)).length,
      fixture: observedSources.filter(source => ['fixture', 'synthetic', 'offline'].includes(source.status)).length
    };
    return {
      running: this.running,
      enabled: this.config.enabled,
      mode: this.getMode(),
      generation: this.getGeneration(),
      autonomy: {
        configured: this.autonomyOverride ?? this.config.autonomy ?? null,
        effective: autonomy.effective,
        downgraded: autonomy.downgraded
      },
      emergency_stop: this.emergencyStopped,
      emergency_stop_sources: {
        local: this.localEmergencyStopped,
        chain: this.getMode() === 'live' && this.chainEmergencyStopped,
        chain_unknown: this.getMode() === 'live' && this.chainSafetyUnknown
      },
      chain_watcher: this.chainWatcher?.status(this.getMode()) ?? {
        enabled: false,
        state: 'disabled'
      },
      sources,
      anchoring: this.anchoring?.status() ?? {
        enabled: false
      },
      scheduler: {
        interval_sec: this.config.monitorIntervalSec,
        last_tick_at: this.scheduler.lastRunAt,
        next_tick_at: this.scheduler.nextRunAt
      },
      queue: {
        queued: busStatus.queued,
        processing: busStatus.processing,
        counts: busStatus.counts,
        dead: busStatus.dead
      },
      executor: this.getMode() === 'live' ? 'analysis' : 'sim',
      // Booleans only: whether a key is configured, never anything about the key.
      signers: Object.fromEntries(Object.entries(roles).map(([role, configured]) => [role, {
        configured: Boolean(configured)
      }])),
      pending_approvals: this.approvals.pendingCount(),
      awaiting_owner_signature: this.approvals.list({
        status: APPROVAL_STATUS.AWAITING_OWNER_SIGNATURE
      }).length,
      protected_chain_pools: this.config.protectedChainPools,
      settlement: { workflow: 'controlled_wallet', automatic_execution: false },
      demo_run: this.scenarios?.playbackStatus(),
      scenario: this.scenarios ? (({
        loaded,
        name,
        next_step: next,
        total_steps: total,
        finished
      }) => ({
        loaded,
        name,
        next_step: next,
        total_steps: total,
        finished
      }))(this.scenarios.status()) : null,
      last_error: this.lastError,
      activity: {
        last_seq: this.activity.seq,
        persist_error: this.activity.lastPersistError
      }
    };
  }

  // ---------------------------------------------------------------- events

  /**
   * Accept an event from an operator, a monitor or a scenario. `origin: 'api'` applies the Live
   * restrictions for hand-injected events.
   */
  async submitEvent(raw, {
    origin = 'internal'
  } = {}) {
    const mode = this.getMode(),
      generation = this.getGeneration();
    await this.init();
    this.#assertCurrent({
      mode,
      generation
    });
    if (origin === 'api') raw = {
      ...raw,
      source: 'admin'
    };
    const event = normalizeEvent(raw, {
      now: this.now,
      defaultMode: mode
    });
    event.runtime_generation = generation;
    event.runtime_mode = mode;
    if (origin === 'api') event.source_mode = mode;
    if (mode === 'live' && !LIVE_ADMIN_EVENT_TYPES.includes(event.type) && origin === 'api') throw new AgentServiceError('event_not_allowed_in_live', 'This event is unavailable in Live analysis', 403);
    if (event.type === 'EMERGENCY_STOP_CHANGED') this.emergencyStopped = Boolean(event.data.stopped);
    const result = await this.bus.submit(event);
    return {
      ...result,
      event_type: event.type,
      case_id: event.case_id,
      mode
    };
  }

  /**
   * Accept uploaded documents: validate and store them, open a job and queue the DOCUMENTS_INGESTED
   * event that the ingest pipeline answers. Uploading the same bytes for the same case again returns
   * the same job instead of a second decision.
   */
  async submitDocuments(body, {
    source = 'ingest',
    occurredAt,
    generation = this.getGeneration(),
    ownerId
  } = {}) {
    const mode = this.getMode();
    await this.init();
    if (!this.ingest) throw new AgentServiceError('ingest_unavailable', 'This runtime has no document intake', 503);
    // Demo scenarios replay curated fixtures; anything else is new material and waits while operations are not ready.
    if (source !== 'scenario') this.#assertIntakeOpen();
    // Everything that can be refused is checked before the job exists, so a refused request leaves nothing behind.
    if (body?.exporter_preferences !== undefined) parsePreferences(body.exporter_preferences);
    const {
      job,
      documents,
      created
    } = await this.ingest.accept(body, {
      ownerId,
      visibility: mode === 'demo' && source === 'scenario' ? 'public-demo' : 'private'
    });
    this.#assertCurrent({
      mode,
      generation
    });
    if (body.exporter_preferences !== undefined) await this.preferences.put(job.case_id, body.exporter_preferences, { mode });
    let accepted = null;
    // A job still QUEUED may never have reached the bus (a failed preference write or event submission after the job
    // was stored): submitting its event again is safe, the bus drops it when it already holds it.
    if (created || job.status === 'QUEUED') {
      accepted = await this.submitEvent({
        event_id: job.event_id,
        type: 'DOCUMENTS_INGESTED',
        case_id: job.case_id,
        source,
        ...(occurredAt ? {
          occurred_at: occurredAt
        } : {}),
        data: {
          job_id: job.job_id,
          document_ids: job.document_ids,
          ...(job.source_case_id ? {
            template_case_id: job.source_case_id
          } : {})
        }
      });
    }
    return {
      job: this.ingest.getJob(job.job_id),
      documents,
      created,
      idempotency_key: accepted?.idempotency_key ?? `event:${job.event_id}`
    };
  }
  #assertIntakeOpen() {
    const readiness = this.intakeGate();
    if (readiness && readiness.ok === false) throw new AgentServiceError('operations_not_ready', 'New intake is paused. Preserve existing records and reconcile operational health.', 503);
  }
  async setPreferences(caseId, input) {
    await this.init();
    const stored = await this.preferences.put(caseId, input, { mode: this.getMode() });
    this.#activity('SYSTEM', 'EXPORTER_PREFERENCES_SET', null, {
      preferences: stored.preferences
    }, {
      caseId
    });
    return stored;
  }

  /** A review supplies corrected bytes and re-runs every deterministic check; it cannot waive a block. */
  async reviewDocuments(jobId, body) {
    await this.init();
    const original = this.ingest?.getJob(jobId);
    if (!original) throw new AgentServiceError('job_not_found', 'Unknown ingest job', 404);
    if (original.status !== 'DONE' || !original.review_required) throw new AgentServiceError('review_not_required', 'Only a completed HOLD job can receive corrected documents', 409);
    if (!body || typeof body.note !== 'string' || !body.note.trim() || body.note.length > 500) throw new AgentServiceError('review_note_required', 'A review note (1-500 characters) is required', 400);
    this.#assertIntakeOpen();
    const result = await this.ingest.accept({
      case_id: original.case_id,
      documents: body.documents
    }, {
      reviewOf: jobId,
      ownerId: original.owner_id,
      visibility: original.visibility
    });
    if (!result.created) return {
      job: result.job,
      idempotency_key: `event:review:${result.job.job_id}`
    };
    await this.ingest.updateJob(result.job.job_id, {
      reviewed_job_id: jobId
    });
    const accepted = await this.submitEvent({
      event_id: `review:${result.job.job_id}`,
      type: 'REVIEW_RESOLVED',
      case_id: original.case_id,
      source: 'admin',
      data: {
        job_id: result.job.job_id,
        document_ids: result.job.document_ids,
        reviewed_job_id: jobId,
        resolution: 'approve',
        note: body.note.trim(),
        ...(original.source_case_id ? {
          template_case_id: original.source_case_id
        } : {})
      }
    });
    return {
      job: this.ingest.getJob(result.job.job_id),
      idempotency_key: accepted.idempotency_key
    };
  }

  /** Wait until an event has been handled (or give up), and say what happened. For the Demo UI and tests. */
  async waitFor(idempotencyKey, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const entry = this.bus.get(idempotencyKey);
      if (!entry) return {
        status: 'UNKNOWN'
      };
      if (!['RECEIVED', 'PROCESSING'].includes(entry.status)) {
        return {
          status: entry.status,
          result: entry.result ?? null,
          error: entry.error ?? null,
          note: entry.note ?? null
        };
      }
      if (Date.now() >= deadline) return {
        status: entry.status,
        timed_out: true
      };
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  #onEventSettled(entry) {
    if (entry.status === 'DEAD') {
      this.#noteError(new Error(`event ${entry.event_id} dead-lettered: ${entry.error?.message}`));
      this.#activity('SYSTEM', 'EVENT_DEAD_LETTERED', null, {
        event_id: entry.event_id,
        type: entry.type,
        attempts: entry.attempts,
        error: entry.error?.message
      }, {
        caseId: entry.case_id
      });
    } else if (entry.status === 'STALE') {
      this.#activity('SYSTEM', 'EVENT_STALE', null, {
        event_id: entry.event_id,
        type: entry.type,
        note: entry.note
      }, {
        caseId: entry.case_id
      });
    }
  }

  /** Bus handler: one event → zero or more decisions. Idempotent by decision id. */
  async #handleEvent(event) {
    const mode = this.getMode();
    const generation = this.getGeneration();
    const run = this.tracer.startRun({
      name: 'agent.event',
      attributes: {
        event_type: event.type,
        case_id: event.case_id,
        source: event.source,
        mode
      }
    });
    try {
      if (event.runtime_mode !== undefined && (event.runtime_mode !== mode || event.runtime_generation !== generation)) {
        await run.end('ok');
        return {
          ignored: 'Runtime changed since the event was queued',
          decisions: []
        };
      }
      if (event.source === 'chain-watcher') {
        await run.end('ok');
        return {
          observed: true,
          decisions: []
        };
      }
      if (event.type === 'EMERGENCY_STOP_CHANGED') {
        await run.end('ok');
        return {
          ignored: 'handled at submission'
        };
      }
      await this.ensurePools();
      // Reconcile from the saved proposal, never re-price a replay against a pool changed by its first execution.
      const recorded = (await this.logger.list({
        case_id: event.case_id
      })).filter(decision => decision.event_id === event.event_id);
      if (recorded.length) {
        for (const decision of recorded) {
          if (decision.status === 'DECIDED') await this.#route(decision, event, null, run);
        }
        await run.end('ok');
        return {
          decisions: recorded.map(decision => decision.decision_id),
          recovered: true
        };
      }
      const pool = this.store.pools.get(event.pool_id ?? event.case_id) ?? this.#poolByCase(event.case_id);
      const documentEvent = event.type === 'DOCUMENTS_INGESTED' || event.type === 'REVIEW_RESOLVED' && event.data?.job_id;
      const proposed = documentEvent ? await this.#proposeFromUpload(event, pool, run) : await run.span('monitor_pipeline', async () => proposeFromEvent(event, {
        pool,
        mode,
        now: () => this.now().getTime()
      }), {
        event_type: event.type
      });
      if (mode !== this.getMode() || generation !== this.getGeneration()) throw new AgentServiceError('mode_changed', 'Runtime changed while processing this event', 409);
      if (proposed.proposals.length === 0) {
        this.#activity('SYSTEM', 'EVENT_IGNORED', null, {
          event_id: event.event_id,
          type: event.type,
          reason: proposed.ignored
        }, {
          caseId: event.case_id,
          poolId: pool?.poolId
        });
        await run.end('ok');
        return {
          ignored: proposed.ignored,
          decisions: []
        };
      }
      const decisions = [];
      for (const [index, proposal] of proposed.proposals.entries()) {
        const decision = await this.#decide(event, pool, proposal, index, run);
        decisions.push(decision.decision_id);
      }
      if (documentEvent) await this.#finishJob(event, {
        status: 'DONE',
        decision_ids: decisions
      });
      await run.end('ok');
      return {
        decisions
      };
    } catch (error) {
      if (event.type === 'DOCUMENTS_INGESTED' || event.type === 'REVIEW_RESOLVED' && event.data?.job_id) {
        await this.#finishJob(event, {
          status: 'FAILED',
          error: {
            code: error.code ?? 'ingest_failed',
            message: String(error.message ?? error).slice(0, 300)
          }
        });
      }
      await run.end('error');
      throw error;
    }
  }

  /** The ingest pipeline for a DOCUMENTS_INGESTED event: reports each step to the job, the feed and the trace. */
  async #proposeFromUpload(event, pool, run) {
    if (!this.ingest) return {
      proposals: [],
      ignored: 'This runtime has no document intake'
    };
    const jobId = event.data?.job_id;
    if (jobId) await this.ingest.updateJob(jobId, {
      status: 'RUNNING',
      started_at: this.now().toISOString()
    });
    this.#activity('PIPELINE', 'INGEST_STARTED', null, {
      job_id: jobId ?? null,
      documents: event.data?.document_ids?.length ?? 0
    }, {
      caseId: event.case_id,
      poolId: pool?.poolId
    });
    // A working copy of a public sample has no pool of its own yet: the sample's case is its template, never its pool.
    const templateId = event.data?.template_case_id;
    const template = pool ?? (templateId ? this.store.pools.get(templateId) ?? this.#poolByCase(templateId) : null);
    return run.span('ingest_pipeline', async () => proposeFromIngest(event, {
      ingest: this.ingest,
      orchestrator: this.orchestrator,
      preferences: this.preferences,
      pool: template,
      forceDeterministic: event.source === 'scenario' || !this.config.valuationLlm,
      valuation: {
        env: event.source === 'scenario' ? {} : this.env
      },
      worldRisk: {
        env: event.source === 'scenario' ? {} : this.env
      },
      parser: event.source === 'scenario' ? {} : this.documentParser,
      now: event.source === 'scenario' ? () => Date.parse(event.occurred_at) : () => this.now().getTime(),
      onStep: async step => {
        if (jobId) await this.ingest.recordStep(jobId, step);
        this.#activity('PIPELINE', 'PIPELINE_STEP', null, {
          job_id: jobId ?? null,
          ...step
        }, {
          caseId: event.case_id,
          poolId: pool?.poolId
        });
      }
    }), {
      event_type: event.type
    });
  }
  async #finishJob(event, patch) {
    const jobId = event.data?.job_id;
    if (!jobId || !this.ingest) return;
    await this.ingest.updateJob(jobId, {
      ...patch,
      finished_at: this.now().toISOString()
    });
    this.#activity('PIPELINE', 'INGEST_FINISHED', null, {
      job_id: jobId,
      status: patch.status
    }, {
      caseId: event.case_id
    });
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
    const generation = this.getGeneration();
    const evidenceNow = event.source === 'scenario' ? Date.parse(event.observed_at) : this.now().getTime();
    let freshness = proposal.freshness ?? eventFreshness(event, evidenceNow);
    if (mode === 'live' && event.source === 'world-risk-monitor' && freshness.source_status !== 'live') freshness = {
      ...freshness,
      fresh: false,
      source_status: 'stale'
    };
    const replay = proposal.replay ?? {
      schema: 'agent-replay-v1',
      kind: 'monitor',
      event: structuredClone(event),
      pool: pool ? structuredClone({
        poolId: pool.poolId,
        status: pool.status,
        caseData: pool.caseData,
        quote: pool.quote,
        subscribedUsd: pool.subscribedUsd,
        settlement: pool.settlement
      }) : null,
      mode,
      proposal_index: index,
      now_ms: evidenceNow
    };
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
    const policy = await run.span('policy', async () => evaluatePolicy({
      action: proposal.action,
      pool_id: poolId,
      findings: proposal.findings,
      llm_only: proposal.llm_only,
      price_move_bps: proposal.price_move_bps,
      new_issue_price_usd: proposal.new_issue_price_usd
    }, {
      mode,
      autonomy: autonomy.effective,
      protectedPool,
      emergencyStopped: await this.#emergencyStopped(),
      chainObservationUnavailable: Boolean(this.chainWatcher && this.chainSafetyUnknown),
      evidenceStale: !freshness.fresh || mode === 'live' && event.source === 'world-risk-monitor' && freshness.source_status !== 'live',
      recentActions: await this.#recentActions(poolId),
      now: this.now().getTime(),
      exporterPreferences: this.preferences.get(event.case_id),
      thresholds: {
        maxPriceMoveBps: this.config.maxPriceMoveBps,
        cooldownSec: this.config.cooldownSec,
        maxActionsPerPoolPerDay: this.config.maxActionsPerPoolPerDay,
        allowUnattendedIrreversible: this.config.allowUnattendedIrreversible
      }
    }));
    this.#assertCurrent({
      mode,
      generation
    });
    const policyStep = {
      step: 'policy',
      status: policy.verdict === 'REJECTED' ? 'FAIL' : 'PASS',
      duration_ms: Date.now() - policyStarted
    };
    if (mode === 'live' && event.data?.job_id) {
      await this.ingest?.recordStep(event.data.job_id, policyStep);
      this.#activity('PIPELINE', 'PIPELINE_STEP', null, policyStep, {
        caseId: event.case_id,
        poolId
      });
    }
    const action = policy.action_override ?? proposal.action;
    const record = await this.logger.record({
      ...core,
      agent_version: this.anchoring?.version,
      decision_id: decisionId,
      action,
      proposed_action: proposal.action,
      freshness,
      evidence_clock: event.source === 'scenario' && mode === 'demo' ? 'scenario' : 'wall',
      replay,
      replay_hash: hashSnapshot(replay),
      reasoning_summary: proposal.reasoning_summary,
      mode,
      generation,
      ...(event.data?.job_id ? {
        job_id: event.data.job_id
      } : {}),
      chain_pool_id: chainPoolId,
      pipeline: [...proposal.pipeline, policyStep],
      findings: proposal.findings,
      quote_hash: proposal.quote_hash,
      quote_snapshot: structuredClone(proposal.params?.quote ?? pool?.quote ?? null),
      proposal: {
        params: proposal.params,
        price_move_bps: proposal.price_move_bps ?? null,
        new_issue_price_usd: proposal.new_issue_price_usd ?? null
      },
      policy: {
        verdict: policy.verdict,
        reasons: policy.reasons,
        autonomy: policy.autonomy
      },
      status: 'DECIDED',
      trace_id: run.trace_id
    });
    this.#activity('DECISION', 'DECISION_MADE', record, {
      decision_action: record.action,
      verdict: policy.verdict,
      reasons: policy.reasons.map(reason => reason.rule),
      summary: record.reasoning_summary,
      event_type: event.type
    });
    return this.#route(record, event, pool, run);
  }
  async #emergencyStopped() {
    return this.emergencyStopped;
  }
  async #recentActions(poolId) {
    const records = await this.logger.list({
      pool_id: poolId
    });
    return records.filter(record => COUNTED_STATUSES.has(record.status) && record.mode === this.getMode()).map(record => ({
      action: record.action,
      at: record.created_at
    }));
  }
  async #route(decision, event, pool, run) {
    const verdict = decision.policy.verdict;
    if (verdict === 'REJECTED') return this.#finish(decision, 'REJECTED', {
      note: decision.policy.reasons[0]?.message
    });
    if (verdict === 'OBSERVE_ONLY') return this.#finish(decision, 'SKIPPED', {
      note: decision.policy.reasons[0]?.message
    });
    if (this.getMode() === 'live') return this.#finish(decision, 'SKIPPED', {
      note: 'Analysis recorded. Execute financing through the controlled wallet workflow.',
      execution: {
        mode: 'record',
        attempts: 0
      }
    });
    if (verdict === 'NEEDS_APPROVAL' && !INFORMATIONAL_ACTIONS.includes(decision.action)) return this.#requestApproval(decision, run);
    return this.mutex.run(decision.pool_id, () => this.#execute(decision, run));
  }
  async #finish(decision, status, extra = {}) {
    const updated = await this.logger.update(decision.decision_id, {
      status,
      ...extra
    });
    if (status === 'REJECTED' || status === 'SKIPPED') {
      this.#activity('DECISION', status === 'REJECTED' ? 'DECISION_REJECTED' : 'DECISION_RECORDED', updated, {
        decision_action: updated.action,
        note: extra.note ?? null
      });
    }
    return updated;
  }

  // ---------------------------------------------------------------- execution

  /** Which executor handles a decision in the current mode, or null when the server cannot (an operator signs). */
  async #executorFor() {
    return this.getMode() === 'demo' ? {
      kind: 'sim',
      executor: this.sim
    } : null;
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
      ...(SETTLEMENT_ACTIONS.includes(decision.action) ? {
        settlement_plan: this.approvals.list({
          decision_id: decision.decision_id
        })[0]?.plan
      } : {}),
      onSubmitted,
      assertCurrent: () => {
        this.#assertCurrent(decision);
        if (!INFORMATIONAL_ACTIONS.includes(decision.action) && decision.freshness && !assessFreshness(decision.freshness, this.#evidenceNow(decision)).fresh) {
          throw new AgentServiceError('evidence_expired', 'Evidence expired before broadcast; fresh evidence and a new proposal are required', 409);
        }
      }
    };
  }
  #isCurrent(decision) {
    return decision.mode === this.getMode() && (decision.generation === undefined || decision.generation === this.getGeneration());
  }
  #assertCurrent(decision) {
    if (!this.#isCurrent(decision)) throw new AgentServiceError('mode_changed', 'Runtime mode or generation changed since this proposal was made', 409);
  }
  #evidenceNow(decision) {
    return decision.evidence_clock === 'scenario' ? Date.parse(decision.freshness.evaluated_at) + Math.max(0, this.now().getTime() - Date.parse(decision.created_at)) : this.now().getTime();
  }
  async #execute(decision, run, approval = null) {
    if (!this.#isCurrent(decision)) return this.#fail(decision, {
      code: 'mode_changed',
      message: 'Runtime mode or generation changed before execution'
    }, approval);
    const informational = INFORMATIONAL_ACTIONS.includes(decision.action);
    if (!informational && decision.freshness && !assessFreshness(decision.freshness, this.#evidenceNow(decision)).fresh) {
      return this.#fail(decision, {
        code: 'evidence_expired',
        message: 'Evidence expired before execution; refresh it and create a new proposal.'
      }, approval);
    }
    const route = await this.#executorFor(decision);
    if (!this.#isCurrent(decision)) return this.#fail(decision, {
      code: 'mode_changed',
      message: 'Runtime changed while resolving the executor'
    }, approval);
    if (!route) {
      return this.#fail(decision, {
        code: this.getMode() === 'live' ? 'chain_unavailable' : 'no_executor',
        message: this.getMode() === 'live' ? 'The server cannot send this action (no signer for it, or the chain is unreachable)' : 'No executor is available for this action'
      }, approval);
    }
    await this.logger.update(decision.decision_id, {
      status: 'EXECUTING'
    });
    this.#activity('EXECUTION', 'EXECUTION_SUBMITTED', decision, {
      decision_action: decision.action,
      executor: route.kind
    });
    const started = Date.now();
    const ownRun = !run;
    const activeRun = run ?? this.tracer.startRun({
      decision_id: decision.decision_id,
      name: 'agent.execute'
    });
    try {
      const retried = await activeRun.span('execute', async () => executeWithRetry(() => route.executor.execute(this.#command(decision)), {
        maxAttempts: 3,
        baseDelayMs: 300,
        sleep: this.sleep,
        shouldRetry: error => error?.retryable === true
      }), {
        executor: route.kind
      });
      const result = retried.value;
      if (result.skipped) {
        return this.#finish(decision, 'SKIPPED', {
          note: result.note,
          execution: this.#executionRecord(result, retried.attempts, started)
        });
      }
      return this.#complete(decision, this.#executionRecord(result, retried.attempts, started), approval);
    } catch (thrown) {
      // executeWithRetry wraps whatever the executor threw; the executor's own error is what matters.
      const error = thrown?.name === 'RetryExhaustedError' && thrown.cause ? thrown.cause : thrown;
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
      ...(result.tx_hash ? {
        tx_hash: result.tx_hash
      } : {}),
      ...(result.explorer_url ? {
        explorer_url: result.explorer_url
      } : {}),
      ...(result.block_number !== undefined ? {
        block_number: result.block_number
      } : {}),
      ...(result.confirmed_events ? {
        confirmed_events: result.confirmed_events
      } : {}),
      ...(result.effects ? {
        effects: result.effects
      } : {}),
      ...(result.note ? {
        note: result.note
      } : {}),
      attempts: result.attempts ?? attempts,
      duration_ms: Date.now() - started
    };
  }
  async #complete(decision, execution, approval = null) {
    const current = await this.logger.get(decision.decision_id);
    const updated = await this.logger.update(decision.decision_id, {
      status: 'COMPLETED',
      execution,
      error: undefined,
      ...(approval ? {
        approval: {
          ...current.approval,
          status: 'EXECUTED'
        }
      } : {})
    });
    await this.#maybeProposeSettlement(updated).catch(error => this.#noteError(error));
    // A separate approval-store write must not turn a verified execution into a failure. A later
    // tick repairs this checkpoint from the completed decision if the process/write stops here.
    if (approval) await this.approvals.markExecuted(approval.approval_id, {
      reference: execution.reference,
      tx_hash: execution.tx_hash ?? null
    }).catch(error => this.#noteError(error));
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
    if (!this.#isCurrent(decision) || decision.mode !== 'demo') return;
    if (!['RECORD_PAYMENT', 'RECORD_ARRIVAL'].includes(decision.action)) return;
    const pool = this.store.pools.get(decision.pool_id) ?? this.#poolByCase(decision.case_id);
    const settlement = pool?.settlement;
    if (!settlement?.payment_proof || !settlement?.arrival_proof || settlement.settled_at) return;
    const event = normalizeEvent({
      event_id: `settlement-ready:demo:${pool.poolId}`,
      type: 'SETTLEMENT_READY',
      case_id: decision.case_id,
      pool_id: pool.poolId,
      source: 'agent',
      source_mode: decision.mode,
      data: {
        repayment_amount: settlement.repayment_amount,
        trigger_decision: decision.decision_id
      }
    }, {
      now: this.now,
      defaultMode: decision.mode
    });
    event.runtime_mode = decision.mode;
    event.runtime_generation = this.getGeneration();
    await this.bus.submit(event).catch(error => this.#noteError(error));
  }
  async #fail(decision, error, approval = null) {
    const failure = {
      code: error.code ?? error.name ?? 'error',
      message: String(error.message ?? error).slice(0, 500)
    };
    const current = await this.logger.get(decision.decision_id);
    const updated = await this.logger.update(decision.decision_id, {
      status: 'FAILED',
      error: failure,
      ...(approval ? {
        approval: {
          ...current.approval,
          status: 'FAILED'
        }
      } : {})
    });
    if (approval) await this.approvals.markFailed(approval.approval_id, failure).catch(() => {});
    this.#noteError(error);
    this.#activity('EXECUTION', 'EXECUTION_FAILED', updated, {
      decision_action: updated.action,
      ...failure
    });
    return updated;
  }

  /** Keep the offchain mirror of a Live pool in step with what just happened on-chain. Best effort. */

  // ---------------------------------------------------------------- approvals

  async #requestApproval(decision) {
    this.#assertCurrent(decision);
    if (this.getMode() !== 'demo') throw new AgentServiceError('controlled_wallet_required', 'Use the controlled wallet workflow', 409);
    const approval = await this.approvals.create({
      decision_id: decision.decision_id,
      route: 'sim',
      case_id: decision.case_id,
      pool_id: decision.pool_id,
      action: decision.action,
      mode: 'demo',
      summary: decision.reasoning_summary,
      plan: null,
      ttlSec: this.config.approvalTtlSec
    });
    const updated = await this.logger.update(decision.decision_id, {
      status: 'PENDING_APPROVAL',
      approval: {
        approval_id: approval.approval_id,
        status: approval.status,
        route: 'sim',
        expires_at: approval.expires_at
      }
    });
    this.#activity('APPROVAL', 'APPROVAL_REQUESTED', updated, {
      decision_action: updated.action,
      approval_id: approval.approval_id,
      route: 'sim',
      expires_at: approval.expires_at
    });
    return updated;
  }
  async approve(approvalId, {
    by = 'admin',
    note = null
  } = {}) {
    await this.init();
    const pending = this.approvals.get(approvalId);
    if (pending?.mode !== 'demo' || pending?.route !== 'sim') throw new AgentServiceError('controlled_wallet_required', 'Historical Agent signing routes are retired; use the controlled wallet workflow', 409);
    const decision = await this.logger.get(pending.decision_id);
    if (!decision) throw new AgentServiceError('decision_missing', 'Approval decision is missing', 409);
    this.#assertCurrent(decision);
    if (decision.freshness && !assessFreshness(decision.freshness, this.#evidenceNow(decision)).fresh) throw new AgentServiceError('evidence_expired', 'Fresh evidence and a new proposal are required', 409);
    const approval = await this.approvals.approve(approvalId, {
      by,
      note
    });
    this.#activity('APPROVAL', 'APPROVAL_GRANTED', decision, {
      approval_id: approvalId,
      by
    });
    await this.logger.update(decision.decision_id, {
      approval: {
        approval_id: approvalId,
        status: 'APPROVED',
        route: 'sim',
        decided_by: by,
        decided_at: approval.decided_at
      }
    });
    const executed = await this.mutex.run(decision.pool_id, () => this.#execute(decision, null, approval));
    return {
      approval: this.approvals.get(approvalId),
      decision: executed
    };
  }
  async reject(approvalId, {
    by = 'admin',
    note = null
  } = {}) {
    await this.init();
    const approval = await this.approvals.reject(approvalId, {
      by,
      note
    });
    const decision = await this.logger.update(approval.decision_id, {
      status: 'REJECTED',
      note: note ?? 'Rejected by an operator',
      approval: {
        approval_id: approvalId,
        status: 'REJECTED',
        route: approval.route,
        decided_by: by,
        decided_at: approval.decided_at
      }
    });
    this.#activity('APPROVAL', 'APPROVAL_REJECTED', decision, {
      decision_action: decision.action,
      approval_id: approvalId,
      by,
      note
    });
    return {
      approval: this.approvals.get(approvalId),
      decision
    };
  }
  /** Removed signing endpoint; existing transactions use controlled intents. */
  async attachTx() {
    throw new AgentServiceError('signing_route_retired', 'Use controlled transaction intents to reconcile wallet transactions', 410);
  }

  // ---------------------------------------------------------------- periodic work

  /** One scheduler tick: expire approvals, reconcile submitted transactions, poll the sources. */
  async tick() {
    await this.init();
    await this.chainWatcher?.poll(this);
    const expired = await this.approvals.expireStale();
    for (const approval of this.approvals.list({
      status: APPROVAL_STATUS.EXPIRED,
      limit: 2000
    })) {
      const decision = await this.logger.get(approval.decision_id);
      if (decision && ['PENDING_APPROVAL', 'AWAITING_OWNER_SIGNATURE'].includes(decision.status)) {
        const updated = await this.logger.update(decision.decision_id, {
          status: 'SKIPPED',
          note: 'The approval expired before anyone acted on it',
          approval: {
            ...decision.approval,
            status: 'EXPIRED'
          }
        });
        this.#activity('APPROVAL', 'APPROVAL_EXPIRED', updated, {
          decision_action: updated.action,
          approval_id: approval.approval_id
        });
      }
    }

    // Approval was durably granted but the process stopped before recording EXECUTING.
    for (const approval of this.approvals.list({
      status: APPROVAL_STATUS.APPROVED
    })) {
      const decision = await this.logger.get(approval.decision_id);
      if (decision?.status === 'COMPLETED') {
        await this.approvals.markExecuted(approval.approval_id, {
          reference: decision.execution?.reference ?? null,
          tx_hash: decision.execution?.tx_hash ?? null
        });
        await this.#maybeProposeSettlement(decision);
        continue;
      }
      if (decision?.status === 'FAILED') {
        await this.approvals.markFailed(approval.approval_id, decision.error ?? 'Execution failed before approval checkpoint');
        continue;
      }
      if (!decision || !['DECIDED', 'PENDING_APPROVAL'].includes(decision.status)) continue;
      if (!this.#isCurrent(decision)) {
        await this.#fail(decision, {
          code: 'mode_changed',
          message: 'Runtime changed before approved action recovery'
        }, approval);
      } else {
        await this.mutex.run(decision.pool_id, async () => {
          const current = await this.logger.get(decision.decision_id);
          if (['DECIDED', 'PENDING_APPROVAL'].includes(current.status)) await this.#execute(current, null, approval);
        });
      }
    }
    for (const source of this.sources) {
      try {
        const events = await source({
          service: this
        });
        for (const raw of events ?? []) await this.submitEvent(raw, {
          origin: 'internal'
        });
      } catch (error) {
        this.#noteError(error);
      }
    }
    await this.anchoring?.tick();
    await this.logger.prune({
      maxRecords: this.config.maxDecisions,
      olderThanMs: this.config.retentionDays * 24 * 3600 * 1000
    });
    const protectedDecisions = new Set((await this.logger.list()).filter(record => !['COMPLETED', 'FAILED', 'SKIPPED', 'REJECTED'].includes(record.status)).map(record => record.decision_id));
    const retention = {
      now: this.now().getTime(),
      retentionDays: this.config.retentionDays,
      maxRecords: this.config.maxDecisions,
      protectedDecisions
    };
    await this.bus.pruneRetention?.(retention);
    await this.approvals.pruneRetention?.(retention);
    await this.activity.prune?.(retention);
    await this.tracer.prune?.(retention);
    return {
      ok: true,
      expired: expired.length
    };
  }

  // ---------------------------------------------------------------- operator controls

  async control({
    action,
    autonomy,
    stopped,
    ...rest
  }) {
    await this.init();
    switch (action) {
      case 'start':
        return this.start();
      case 'stop':
        return this.stop();
      case 'tick':
        await this.scheduler.trigger();
        return this.status();
      case 'set_autonomy':
        {
          if (!['off', 'observe', 'propose', 'auto'].includes(autonomy)) throw new AgentServiceError('invalid_autonomy', 'autonomy must be off, observe, propose or auto');
          this.autonomyOverride = autonomy;
          if (this.anchoring) {
            this.anchoring.version = createAgentVersion({
              ...this.config,
              autonomy
            }, this.env);
            this.logger.agentVersion = this.anchoring.version;
          }
          const effective = this.autonomy();
          this.#activity('SYSTEM', 'AUTONOMY_CHANGED', null, {
            requested: autonomy,
            effective: effective.effective,
            downgraded: effective.downgraded
          });
          return this.status();
        }
      case 'emergency_stop':
        this.emergencyStopped = stopped !== false;
        this.#activity('SYSTEM', 'EMERGENCY_STOP_CHANGED', null, {
          stopped: this.emergencyStopped,
          ...(rest.reason ? {
            reason: String(rest.reason).slice(0, 200)
          } : {})
        });
        return this.status();
      default:
        throw new AgentServiceError('invalid_action', 'action must be start, stop, tick, set_autonomy or emergency_stop');
    }
  }

  // ---------------------------------------------------------------- Demo reset

  /** Clear everything the agent recorded in Demo mode. Live records are never touched. */
  async resetDemo() {
    await this.scenarios?.stopPlayback();
    await this.init();
    this.chainWatcher?.forgetDemoBackups();
    const removed = await this.logger.clearWhere(record => record.mode === 'demo');
    await this.anchoring?.resetDemo();
    await this.approvals.clearMode('demo');
    await this.bus.clearMode('demo');
    await this.activity.clearMode('demo');
    await this.registry.clearOffchain();
    this.sim.done.clear();
    // Live material and the research constraints that go with it stay together: neither is Demo state.
    const liveCases = await this.ingest?.liveCaseIds?.() ?? new Set();
    await this.ingest?.clear();
    await this.riskTracker?.clear();
    await this.scenarios?.stop();
    if (this.preferences.clearDemo) await this.preferences.clearDemo({ keep: liveCases });
    else await this.preferences.clear?.();
    this.emergencyStopped = false;
    await this.syncPools();
    return {
      removed_decisions: removed
    };
  }

  // ---------------------------------------------------------------- reads

  async listDecisions({
    case_id: caseId,
    pool_id: poolId,
    status,
    action,
    limit = 50,
    cursor,
    caseFilter
  } = {}) {
    const all = await this.logger.list();
    let items = all;
    if (caseFilter) items = items.filter(record => caseFilter(record.case_id, record));
    if (caseId) items = items.filter(record => record.case_id === caseId);
    if (poolId) items = items.filter(record => record.pool_id === poolId);
    if (status) items = items.filter(record => record.status === status);
    if (action) items = items.filter(record => record.action === action);
    // Newest first; records created in the same millisecond keep their insertion order (newest last-inserted first).
    const order = new Map(all.map((record, index) => [record.decision_id, index]));
    items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || order.get(b.decision_id) - order.get(a.decision_id));
    const start = cursor ? Math.max(0, items.findIndex(record => record.decision_id === cursor) + 1) : 0;
    const page = items.slice(start, start + limit);
    return {
      decisions: page.map(record => this.#publicDecision(record)),
      count: items.length,
      next_cursor: start + limit < items.length ? page.at(-1)?.decision_id : null
    };
  }
  #publicDecision(record) {
    if (!record) return null;
    return sanitizeAudit({
      ...record,
      ...(record.freshness ? {
        freshness_status: assessFreshness(record.freshness, this.#evidenceNow(record)).source_status
      } : {})
    });
  }
  async getDecision(id) {
    return this.#publicDecision(await this.logger.get(id));
  }
  async replayDecision(id) {
    const decision = await this.logger.get(id);
    if (!decision) throw new AgentServiceError('decision_not_found', 'Unknown decision', 404);
    return replayDecision(decision);
  }
  async getDecisionAnchor(id) {
    const decision = await this.logger.get(id);
    const result = await this.anchoring?.get(id, decision);
    if (!decision && !result?.available) throw new AgentServiceError('decision_not_found', 'Unknown decision', 404);
    return result ?? {
      available: false,
      state: 'DISABLED',
      decision_id: id
    };
  }
  async getTrace(id) {
    return this.tracer.getByDecision(id);
  }
}
