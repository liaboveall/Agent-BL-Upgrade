// Agent runtime configuration (docs/agent-implementation-plan.md §4.7). Only variables something reads
// today are here; the rest of §4.7 is added together with the work package
// that uses it.
//
// Everything is read from the environment in one place so tests can pass a plain object, and so the
// safety-relevant defaults (Live only ever proposes; irreversible actions never run unattended) live
// next to each other.

export const AUTONOMY_LEVELS = Object.freeze(['off', 'observe', 'propose', 'auto']);

function int(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function bool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/**
 * The autonomy that actually applies. D1: in Live the agent only proposes, so `auto` is treated as
 * `propose`; `off` and `observe` stay as configured. Demo defaults to `auto` (simulated execution).
 * @returns {{ effective: string, configured: string|null, downgraded: boolean }}
 */
export function effectiveAutonomy(mode, configured) {
  const requested = AUTONOMY_LEVELS.includes(String(configured ?? '').toLowerCase())
    ? String(configured).toLowerCase()
    : null;
  if (mode === 'live') {
    const base = requested ?? 'propose';
    return { effective: base === 'auto' ? 'propose' : base, configured: requested, downgraded: base === 'auto' };
  }
  return { effective: requested ?? 'auto', configured: requested, downgraded: false };
}

/** Parse `AGENT_PROTECTED_CHAIN_POOLS` ("2,5") into a sorted list of positive integers. */
export function parsePoolList(value) {
  return [...new Set(String(value ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b);
}

export function loadAgentConfig(env = process.env) {
  return {
    // The runtime is started by the server entry point unless it is switched off explicitly.
    enabled: bool(env.AGENT_ENABLED, true),
    autonomy: env.AGENT_AUTONOMY ?? null,
    allowUnattendedIrreversible: bool(env.AGENT_ALLOW_UNATTENDED_IRREVERSIBLE, false),
    protectedChainPools: env.AGENT_PROTECTED_CHAIN_POOLS === undefined
      ? [2]
      : parsePoolList(env.AGENT_PROTECTED_CHAIN_POOLS),
    monitorIntervalSec: int(env.AGENT_MONITOR_INTERVAL_SEC, 300, { min: 30 }),
    maxPriceMoveBps: int(env.AGENT_MAX_PRICE_MOVE_BPS, 1500, { min: 0 }),
    cooldownSec: int(env.AGENT_COOLDOWN_SEC, 600, { min: 0 }),
    maxActionsPerPoolPerDay: int(env.AGENT_MAX_ACTIONS_PER_POOL_PER_DAY, 12, { min: 1 }),
    chainConfirmations: int(env.AGENT_CHAIN_CONFIRMATIONS, 1, { min: 1 }),
    chainWatcherEnabled: bool(env.AGENT_CHAIN_WATCHER_ENABLED, true),
    chainPollSec: int(env.AGENT_CHAIN_POLL_SEC, 15, { min: 1, max: 3600 }),
    chainStartBlock: env.AGENT_CHAIN_START_BLOCK?.trim() ? Number(env.AGENT_CHAIN_START_BLOCK) : null,
    settlementRecipient: String(env.AGENT_SETTLEMENT_RECIPIENT ?? '').trim(),
    maxDecisions: int(env.AGENT_MAX_DECISIONS, 5000, { min: 100 }),
    retentionDays: int(env.AGENT_RETENTION_DAYS, 90, { min: 1 }),
    anchorEnabled: bool(env.AGENT_ANCHOR_ENABLED, false),
    anchorIntervalSec: int(env.AGENT_ANCHOR_INTERVAL_SEC, 3600, { min: 1, max: 86400 }),
    anchorMinBatch: int(env.AGENT_ANCHOR_MIN_BATCH, 1, { min: 1, max: 256 }),
    approvalTtlSec: int(env.AGENT_APPROVAL_TTL_SEC, 24 * 60 * 60, { min: 60 }),
    riskClearTicks: int(env.AGENT_RISK_CLEAR_TICKS, 2, { min: 1, max: 20 }),
    insuranceWarnDays: int(env.AGENT_INSURANCE_WARN_DAYS, 7, { min: 1, max: 365 }),
    scenarioSpeed: int(env.AGENT_SCENARIO_SPEED, 1, { min: 1, max: 1000 }),
    uploadMaxBytes: int(env.AGENT_UPLOAD_MAX_BYTES, 8_388_608, { min: 1024, max: 25_000_000 }),
    // Use the configured LLM for the valuation step of the ingest pipeline (it falls back to the
    // deterministic path when no LLM is configured or the call fails).
    valuationLlm: bool(env.AGENT_VALUATION_LLM, true),
    visionEnabled: bool(env.AGENT_VISION_ENABLED, false),
    documentLlm: bool(env.AGENT_DOCUMENT_LLM, false)
  };
}
