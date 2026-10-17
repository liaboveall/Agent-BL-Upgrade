// Wire live world-risk events into the AI pricing engine.
//
// The world-risk agent (src/agent/worldRiskAgent.js) produces macro_risk_events
// in the exact shape scoreRisk consumes. These helpers append those events to a
// case and re-run the deterministic pricing engine, so we can show the issue
// price move BEFORE vs AFTER folding in live real-world risk (or trip PAUSE).
//
// Kept separate from pricingWorkflow.js so the stable workflow path is untouched.

import { quoteFromCase } from './pricingEngine.js';

/** A live world event only needs the fields scoreRisk reads; keep it clean. */
function toMacroEvent(event = {}) {
  return {
    date: event.date,
    type: event.type,
    region: event.region,
    severity: event.severity,
    description: event.description,
    source: event.source ?? 'xAPI/world-intel',
    ...(event.data_status ? { data_status: event.data_status } : {}),
    ...(event.event_id ? { event_id: event.event_id } : {}),
    ...(event.observed_at ? { observed_at: event.observed_at } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.source_status ? { source_status: event.source_status } : {})
  };
}

/**
 * Return a shallow clone of the case with live world-risk events appended to
 * macro_risk_events. Original case is not mutated.
 */
export function mergeWorldRiskIntoCase(caseData, events = []) {
  if (!Array.isArray(events) || events.length === 0) return caseData;
  // The same risk on the same region counts once: a curated case already carries the route data
  // (src/realdata), so the world-risk read only adds what is new or more severe.
  const merged = [...(caseData.macro_risk_events ?? [])];
  const history = [...(caseData.risk_event_history ?? [])];
  for (const event of events.map(toMacroEvent)) {
    if (['unavailable', 'stale', 'offline'].includes(event.data_status ?? event.source_status)) continue;
    const at = merged.findIndex((item) => item.type === event.type && item.region === event.region
      && (item.source ?? 'xAPI/world-intel') === event.source && (!event.event_id || item.event_id === event.event_id));
    if (at < 0) merged.push(event);
    else {
      const old = merged[at];
      const observed = Date.parse(event.observed_at ?? event.date), previous = Date.parse(old.observed_at ?? old.date);
      // A newer observation from the SAME source may downgrade/resolve an alert. Older or
      // undated observations can only add caution; an empty/unavailable feed never clears it.
      if (Number.isFinite(observed) && Number.isFinite(previous) && observed < previous) continue;
      if (Number.isFinite(observed) && (!Number.isFinite(previous) || observed > previous)
          || (SEVERITY_RANK[event.severity] ?? 0) > (SEVERITY_RANK[old.severity] ?? 0)) {
        history.push(old);
        merged[at] = event;
      }
    }
  }
  return { ...caseData, risk_event_history: history, macro_risk_events: merged.filter((event) => event.status !== 'resolved') };
}

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Quote the case before and after folding in live world-risk events.
 * @param {object} caseData
 * @param {Array} events macro_risk_events from the world-risk agent
 * @param {object} [opts] { payout_speed, requested_cash_usd } — passed to quoteFromCase
 * @returns {{ before, after, delta }}
 */
export function repriceWithWorldRisk(caseData, events = [], opts = {}) {
  const before = quoteFromCase(caseData, opts);
  const merged = mergeWorldRiskIntoCase(caseData, events);
  const after = quoteFromCase(merged, opts);

  return {
    before,
    after,
    delta: {
      issue_price_usd: round(after.final_issue_price_usd - before.final_issue_price_usd),
      risk_score_bps: after.risk_score_bps - before.risk_score_bps,
      risk_level_changed: before.risk_level !== after.risk_level,
      action_changed: before.pricing_action !== after.pricing_action,
      from: { risk_level: before.risk_level, pricing_action: before.pricing_action, issue_price_usd: before.final_issue_price_usd },
      to: { risk_level: after.risk_level, pricing_action: after.pricing_action, issue_price_usd: after.final_issue_price_usd }
    }
  };
}
