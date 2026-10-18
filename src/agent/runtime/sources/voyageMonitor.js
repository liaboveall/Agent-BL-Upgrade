// Insurance deadline monitor.
//
//   expires within `warnDays`            → INSURANCE_EXPIRING  (a warning, nothing changes)
//   already expired, pool still active   → INSURANCE_EXPIRED   (the pool should pause until cover is renewed)
//
// Only the insurance deadline is derived here. Departure and arrival need a PROOF (the contract wants
// a hash), so those events come from an operator or from a Demo scenario, never from a guess.
//
// The clock is a parameter: the Demo world is dated June 2026, so against the real clock every Demo
// policy would look expired. Demo therefore only checks insurance when a scenario supplies the clock.

import { ACTIVE_STATES } from '../poolRules.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Insurance events for one pool at time `nowMs`. Pure.
 * @returns {object[]} zero or one event (without `source`/`source_mode`, which the caller owns)
 */
export function insuranceEvents(pool, nowMs, { warnDays = 7 } = {}) {
  const expiresAt = pool?.caseData?.insurance?.expires_at;
  const caseId = pool?.caseData?.case_id ?? pool?.poolId;
  if (!expiresAt || !caseId) return [];
  const expiry = Date.parse(`${String(expiresAt).slice(0, 10)}T23:59:59Z`);
  if (!Number.isFinite(expiry)) return [];
  const day = String(expiresAt).slice(0, 10);

  if (nowMs > expiry) {
    // Cover that lapsed on a pool that is not active (not yet open, or already finished) is not urgent.
    if (!ACTIVE_STATES.includes(pool.status === 'Open' && pool.subscribedUsd > 0 ? 'Subscribed' : pool.status)) return [];
    return [{
      event_id: `insurance-expired:${caseId}:${day}`,
      type: 'INSURANCE_EXPIRED',
      case_id: caseId,
      pool_id: pool.poolId,
      data: { expired_at: new Date(expiry).toISOString() }
    }];
  }
  const daysLeft = Math.ceil((expiry - nowMs) / DAY_MS);
  if (daysLeft <= warnDays) {
    return [{
      event_id: `insurance-expiring:${caseId}:${day}`,
      type: 'INSURANCE_EXPIRING',
      case_id: caseId,
      pool_id: pool.poolId,
      data: { expires_at: new Date(expiry).toISOString(), days_left: daysLeft }
    }];
  }
  return [];
}

/**
 * Monitor source. In Live it uses the real clock for pools mapped to an on-chain pool; in Demo it
 * stays silent unless `getClock()` returns a scenario time.
 * @param {{getClock?: () => number|null}} [options]
 */
export function createVoyageMonitor({ getClock = () => null } = {}) {
  return async function pollInsurance({ service }) {
    const mode = service.getMode();
    const scenarioTime = getClock();
    if (mode === 'demo' && scenarioTime === null) return [];
    const nowMs = scenarioTime ?? service.now().getTime();
    const warnDays = service.config.insuranceWarnDays;
    await service.ensurePools();
    const out = [];
    for (const pool of service.store.pools.values()) {
      const caseId = pool.caseData?.case_id ?? pool.poolId;
      if (mode === 'live' && !service.registry.get(caseId)?.chain) continue;
      for (const event of insuranceEvents(pool, nowMs, { warnDays })) {
        out.push({ ...event, source: 'voyage-monitor', source_mode: mode === 'live' ? 'live' : 'demo' });
      }
    }
    return out;
  };
}
