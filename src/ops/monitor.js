import fs from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { appendJsonl, writeFileAtomic } from '../lib/jsonStore.js';

export async function storageProbe(directory, minFreeBytes = 64 * 1024 * 1024, io = fs) {
  await io.mkdir(directory, { recursive: true });
  const stat = await io.statfs(directory, { bigint: true });
  const available = stat.bavail * stat.bsize;
  if (available < BigInt(minFreeBytes)) throw Object.assign(new Error('Storage headroom below operating threshold'), { code: 'storage_low' });
  const file = path.join(directory, '.ops-write-probe');
  try { await writeFileAtomic(file, 'agentbl-storage-probe-v1', { durable: true, rename: io.rename }); }
  finally { await io.rm(file, { force: true }).catch(() => {}); }
  return { available_bytes: String(available) };
}
const positive = (v, fallback) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback;
export class OperationsMonitor {
  constructor({ directory, env = {}, getAgentStatus = async () => ({}), probeStorage, probeControls = async () => ({ enabled: false }),
    probeMaterials = async () => ({ enabled: false }), alertSink = null, now = () => Date.now() }) {
    Object.assign(this, { directory, env, getAgentStatus, probeControls, probeMaterials, alertSink, now });
    this.probeStorage = probeStorage ?? (() => storageProbe(directory, positive(env.AGENTBL_MIN_FREE_BYTES, 64 * 1024 * 1024)));
    this.intervalMs = positive(env.AGENTBL_OPS_INTERVAL_MS, 10000);
    this.maxSampleAgeMs = this.intervalMs * 3;
    this.snapshot = { schema: 'agentbl-operations-v1', ready: false, status: 'starting', checks: [], observed_at: null };
    this.requests = { total: 0, failed: 0, inflight: 0, max_ms: 0 };
    this.alertSignature = null; this.startupError = false; this.stopping = false;
  }
  recordRequest(response) {
    const started = this.now(); this.requests.inflight++; let done = false;
    const finish = () => {
      if (done) return; done = true; this.requests.total++; this.requests.inflight--;
      if (response.statusCode >= 500) this.requests.failed++;
      this.requests.max_ms = Math.max(this.requests.max_ms, this.now() - started);
    };
    response.once('finish', finish); response.once('close', finish);
  }
  failStartup() { this.startupError = true; }
  readiness() {
    const stale = !this.snapshot.observed_at || this.now() - Date.parse(this.snapshot.observed_at) > this.maxSampleAgeMs;
    return { ok: this.snapshot.ready && !stale && !this.stopping, status: this.stopping ? 'stopping' : stale ? 'unknown' : this.snapshot.status,
      scope: 'research_test_assets_only', business_enabled: false, revision: this.env.AGENTBL_RELEASE_REVISION ?? 'UNRECORDED' };
  }
  details() { return { ...this.snapshot, readiness: this.readiness(), requests: { ...this.requests }, memory_rss_bytes: process.memoryUsage().rss,
    event_loop_p99_ms: this.loop ? Number((this.loop.percentile(99) / 1e6).toFixed(2)) : null }; }
  async sample() {
    if (this.pending) return this.pending;
    if (this.stopping) return this.details();
    this.pending = this.#sample().finally(() => { this.pending = null; });
    return this.pending;
  }
  async #sample() {
    const checks = [];
    const check = (name, ok, code, details = {}) => checks.push({ name, ok: Boolean(ok), code: ok ? 'ok' : code, ...details });
    // A warning is alerted with the role that clears it but leaves the service ready: the chain refuses what it blocks.
    const warn = (name, ok, code, details) => checks.push({ name, ok: Boolean(ok), code: ok ? 'ok' : code, ...(ok ? {} : { warning: true }), ...details });
    check('startup', !this.startupError, 'startup_failed');
    for (const [name, probe] of [['storage', this.probeStorage], ['control_plane', this.probeControls], ['materials', this.probeMaterials]]) {
      try {
        const value = await probe(); check(name, !value?.intake_stopped, 'controlled_intake_stopped', { observation: value });
        // Source screening is one instance-wide window (at most 24 hours): when it lapses every new subscription and draw
        // stops, so the compliance role is told before that rather than when an investor meets the revert.
        if (name === 'control_plane' && value?.screening_valid_until != null && value?.block_timestamp != null) {
          const remaining = Number(value.screening_valid_until) - Number(value.block_timestamp);
          warn('screening_window', remaining > positive(this.env.AGENTBL_SCREENING_WARN_SECONDS, 4 * 3600), remaining <= 0 ? 'screening_expired' : 'screening_expiring',
            { observation: { valid_until: String(value.screening_valid_until), remaining_seconds: remaining, owner: 'compliance', action: 'refresh_screening' } });
        }
      } catch (error) { check(name, false, name === 'storage' && error.code === 'storage_low' ? 'storage_low' : `${name}_unavailable`); }
    }
    try {
      const agent = await this.getAgentStatus(), live = agent.mode === 'live';
      check('agent', !agent.enabled || agent.running, 'agent_not_running');
      check('chain_confirmation', !live || !agent.emergency_stop_sources?.chain_unknown, 'chain_reconciliation_required');
      check('emergency_stop', !agent.emergency_stop, 'intake_stopped');
      check('queue', (agent.queue?.queued ?? 0) <= positive(this.env.AGENTBL_MAX_QUEUE, 100) && !(agent.queue?.dead > 0), 'queue_backlog',
        { queued: agent.queue?.queued ?? 0, dead: agent.queue?.dead ?? 0, pending_approvals: agent.pending_approvals ?? 0 });
      check('audit', !agent.activity?.persist_error, 'audit_persistence_failed');
      check('source_freshness', !live || !(agent.sources?.expired_live > 0 || agent.sources?.unavailable > 0), 'source_refresh_required', { observation: agent.sources ?? { observed: false } });
      const anchoring = agent.anchoring;
      check('evidence_coverage', !anchoring?.coverage?.missing && !anchoring?.last_error, 'evidence_capture_incomplete');
      if (live) check('live_configuration', /^[a-fA-F0-9]{64}$/u.test(this.env.AGENTBL_RIGHTS_KEY ?? '') && Boolean(this.env.AGENTBL_RIGHTS_CONFIG), 'live_controls_required');
      if (agent.chain_watcher?.enabled) check('chain_lag', !live || agent.chain_watcher.state === 'healthy', 'chain_watcher_not_caught_up');
    } catch { check('agent', false, 'agent_status_unavailable'); }
    const ready = checks.every((item) => item.ok || item.warning), signature = checks.filter((item) => !item.ok).map((item) => item.code).sort().join('|') || 'recovered';
    this.snapshot = { schema: 'agentbl-operations-v1', ready, status: ready ? 'ready' : 'degraded', observed_at: new Date(this.now()).toISOString(), checks };
    if (signature !== this.alertSignature) {
      const warned = checks.filter((item) => item.warning);
      const alert = { schema: 'agentbl-operations-alert-v1', at: this.snapshot.observed_at, severity: !ready ? 'critical' : warned.length ? 'warning' : 'recovery', codes: checks.filter((item) => !item.ok).map((item) => item.code),
        action: !ready ? 'stop_new_intake_and_reconcile' : warned.length ? warned.map((item) => item.observation?.action ?? item.code).join(',') : 'resume_after_reconciliation',
        ...(warned.length ? { owners: [...new Set(warned.map((item) => item.observation?.owner).filter(Boolean))] } : {}), revision: this.env.AGENTBL_RELEASE_REVISION ?? 'UNRECORDED' };
      try {
        if (this.directory) await appendJsonl(path.join(this.directory, 'ops-alerts.jsonl'), alert, { durable: true, maxBytes: Infinity });
        if (this.alertSink) await this.alertSink(alert);
        this.alertSignature = signature;
      } catch { this.snapshot.ready = false; this.snapshot.status = 'degraded'; this.snapshot.checks.push({ name: 'alert_delivery', ok: false, code: 'alert_delivery_failed' }); }
    }
    return this.details();
  }
  async start() {
    await this.sample();
    if (this.stopping) return;
    this.loop = monitorEventLoopDelay({ resolution: 20 }); this.loop.enable();
    this.timer = setInterval(() => this.sample().catch(() => {}), this.intervalMs); this.timer.unref();
  }
  async stop() { this.stopping = true; clearInterval(this.timer); this.loop?.disable(); await this.pending; }
  metrics() {
    const d = this.details();
    return [`agentbl_ready ${Number(d.readiness.ok)}`, `agentbl_http_requests_total ${d.requests.total}`, `agentbl_http_errors_total ${d.requests.failed}`,
      `agentbl_http_inflight ${d.requests.inflight}`, `agentbl_http_max_duration_ms ${d.requests.max_ms}`, `agentbl_memory_rss_bytes ${d.memory_rss_bytes}`,
      ...d.checks.map((c) => `agentbl_check_ok{check="${c.name}"} ${Number(c.ok)}`)].join('\n') + '\n';
  }
}
