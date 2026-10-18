// World-risk monitor source. Each tick it assesses every pool
// the agent may act on and lets the RiskTracker decide whether anything CHANGED. With the offline
// fixtures that means: baseline once, then silence -- not a repeat of the same alert every poll.

import { ACTIVE_STATES } from '../poolRules.js';
import { evidenceMetadata, eventFreshness } from '../freshness.js';
import { assessWorldRisk } from '../../worldRiskAgent.js';

const WATCHED_STATES = new Set([...ACTIVE_STATES, 'Paused']);

/** Event id that is the same for the same change on the same case, and different for the next one. */
export function riskEventId(caseId, change) {
  return `risk:${caseId}:${change.sequence}:${change.type === 'RISK_CLEARED' ? 'clear' : change.data.signature}`;
}

/**
 * @param {object} options
 * @param {import('./riskTracker.js').RiskTracker} options.tracker
 * @param {Function} [options.assess]    (caseData, opts) => { events, live, provider, evidence_hash }
 * @param {() => NodeJS.ProcessEnv} [options.env]
 * @returns {(ctx: {service: object}) => Promise<object[]>}
 */
export function createWorldRiskMonitor({ tracker, assess = assessWorldRisk, env = () => process.env }) {
  return async function pollWorldRisk({ service }) {
    const out = [];
    const mode = service.getMode();
    await service.ensurePools();
    for (const pool of service.store.pools.values()) {
      if (pool.chainOnly) continue; // Chain metadata alone is insufficient for a risk/pricing assessment.
      if (!pool.caseData || !WATCHED_STATES.has(pool.status)) continue;
      const caseId = pool.caseData.case_id ?? pool.poolId;
      // Live: only pools that are mapped to a verified on-chain pool.
      if (mode === 'live' && !service.registry.get(caseId)?.chain) continue;

      const assessment = await assess(pool.caseData, { env: env() }).catch(() => null);
      if (!assessment) continue;
      const time = service.now?.().getTime() ?? Date.now();
      const metadata = evidenceMetadata(assessment, { now: time, mode: assessment.live ? 'live' : 'fixture' });
      const usable = eventFreshness({ ...metadata, data: { events: assessment.events ?? [] } }, time).fresh;
      // Unavailable or old data cannot count towards hysteresis or clear a real risk.
      if (!usable || mode === 'live' && (!assessment.live || assessment.review_required || pool.caseData.real_data?.provenance?.review_required)) continue;
      const change = await tracker.observe(caseId, assessment.events ?? []);
      if (!change) continue;
      out.push({
        event_id: riskEventId(caseId, change),
        type: change.type,
        case_id: caseId,
        pool_id: pool.poolId,
        source: 'world-risk-monitor',
        source_mode: assessment.live ? 'live' : 'fixture',
        ...metadata,
        data: change.data,
        ...(assessment.evidence_hash ? { evidence_hash: assessment.evidence_hash } : {})
      });
    }
    return out;
  };
}
