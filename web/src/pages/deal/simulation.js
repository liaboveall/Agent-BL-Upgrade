// In-transit simulation for the selected case: the demo incidents the user toggles and the live
// world-risk events folded into pricing. Both feed /api/offering/simulate; the repriced quote is
// what the voyage tab shows (appStore.voyageOffering → liveQuote()).
import { createStore } from '../../state/store.js';
import { appStore } from '../../state/app-store.js';
import * as api from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { toast } from '../../lib/toast.js';

// In-transit event presets. Descriptions are built at use time so they follow the language;
// risk type and severity drive the AI reprice.
export const EVENTS = [
  { key: 'typhoon', tone: 'warn', labelKey: 'ev_typhoon_label', build: () => [
    { category: 'macro', type: 'severe_weather', region: 'East China Sea', severity: 'warning',
      description: t('ev_typhoon_desc'), source: 'mock-weather-feed (typhoon advisory)' }
  ] },
  { key: 'hormuz', tone: 'crit', labelKey: 'ev_hormuz_label', build: () => [
    { category: 'macro', type: 'war_risk', region: 'Middle East / Strait of Hormuz', severity: 'critical',
      description: t('ev_hormuz_desc1'), source: 'mock-geopolitical-feed (GDELT-style)' },
    { category: 'macro', type: 'commodity_volatility', region: 'Global', severity: 'critical',
      description: t('ev_hormuz_desc2'), source: 'mock-LME-desk' }
  ] },
  { key: 'deviation', tone: 'warn', labelKey: 'ev_deviation_label', build: () => [
    { category: 'shipment', type: 'route_deviation', severity: 'warning',
      description: t('ev_deviation_desc'), source: 'carrier ops bulletin (demo)' }
  ] },
  { key: 'insurance', tone: 'crit', labelKey: 'ev_insurance_label', build: () => [
    { category: 'shipment', type: 'insurance_invalid', severity: 'critical',
      description: t('ev_insurance_desc'), source: 'mock-marine-underwriting-bulletin' }
  ] }
];

export const simStore = createStore({
  key: null,
  applied: [], // event keys
  worldRiskApplied: false,
  worldRiskEvents: [],
  worldRisk: {}, // caseId -> assessment
  worldRiskLoading: false,
  worldRiskError: null,
  pending: false
});

const caches = { baseline: new Map(), sweep: new Map() };

/** Reset the simulation when the dialog shows another case or payout speed (both reset the quote). */
export function syncSimulationCase(caseId, speed) {
  const key = `${caseId}|${speed}`;
  if (simStore.get().key === key) return;
  simStore.set({ key, applied: [], worldRiskApplied: false, worldRiskEvents: [], worldRiskError: null });
}

function rebuildEvents() {
  const { applied, worldRiskApplied, worldRiskEvents } = simStore.get();
  const events = [];
  for (const key of applied) events.push(...(EVENTS.find((event) => event.key === key)?.build() ?? []));
  if (worldRiskApplied && worldRiskEvents.length) events.push(...worldRiskEvents);
  appStore.set({ voyageEvents: events, voyageInjected: events.length > 0 });
  return events;
}

/** Refresh the injected events' descriptions after a language change (pricing uses type/severity only). */
export function relocalizeEvents() {
  if (simStore.get().applied.length || simStore.get().worldRiskApplied) rebuildEvents();
}

async function reprice() {
  const { caseData, speed } = appStore.get();
  const events = rebuildEvents();
  const offering = events.length ? await api.simulateOffering(caseData, { payout_speed: speed, events }) : null;
  appStore.set({ voyageOffering: offering });
}

export async function toggleEvent(key) {
  const applied = simStore.get().applied;
  const next = applied.includes(key) ? applied.filter((item) => item !== key) : [...applied, key];
  simStore.set({ applied: next, pending: true });
  try {
    await reprice();
  } catch (error) {
    simStore.set({ applied });
    rebuildEvents();
    toast(t('t_reprice_fail', { msg: error.message }), true);
  } finally {
    simStore.set({ pending: false });
  }
}

export function resetVoyage() {
  simStore.set({ applied: [], worldRiskApplied: false, worldRiskEvents: [] });
  appStore.set({ voyageEvents: [], voyageInjected: false, voyageOffering: null });
}

/** The baseline lifecycle (no injected events) is cached per case and speed. */
export async function getOffering() {
  const { voyageInjected, voyageOffering, caseId, speed, caseData } = appStore.get();
  if (voyageInjected && voyageOffering) return voyageOffering;
  const key = `${caseId}|${speed}`;
  if (caches.baseline.has(key)) return caches.baseline.get(key);
  const offering = await api.simulateOffering(caseData, { payout_speed: speed });
  caches.baseline.set(key, offering);
  return offering;
}

export async function getRiskSweep() {
  const { caseId, caseData } = appStore.get();
  if (caches.sweep.has(caseId)) return caches.sweep.get(caseId);
  try {
    const res = await api.riskSweep(caseData);
    const sweep = Object.values(res.results ?? {}).flat();
    caches.sweep.set(caseId, sweep);
    return sweep;
  } catch {
    return [];
  }
}

export async function fetchWorldRisk(force = false) {
  const { caseId, caseData } = appStore.get();
  if (!caseData) return;
  if (!force && simStore.get().worldRisk[caseId]) return;
  simStore.set({ worldRiskLoading: true, worldRiskError: null });
  try {
    const res = await api.worldRisk(caseData);
    simStore.set((state) => ({ worldRisk: { ...state.worldRisk, [caseId]: res } }));
  } catch (error) {
    if (appStore.get().caseId === caseId) simStore.set({ worldRiskError: error.message });
  } finally {
    simStore.set({ worldRiskLoading: false });
  }
}

export async function applyWorldRisk() {
  const { caseId, caseData } = appStore.get();
  const assessment = simStore.get().worldRisk[caseId];
  if (!assessment?.events?.length) return;
  // The curated case already carries its route data; only add what it does not have yet.
  const known = new Set((caseData?.macro_risk_events ?? []).map((event) => `${event.type}|${event.region}`));
  const worldRiskEvents = assessment.events.filter((event) => !known.has(`${event.type}|${event.region}`)).map((event) => ({
    category: 'macro', type: event.type, severity: event.severity, region: event.region,
    description: event.description, source: event.source || 'xAPI/world-intel'
  }));
  simStore.set({ worldRiskApplied: true, worldRiskEvents, pending: true });
  try {
    await reprice();
  } catch (error) {
    simStore.set({ worldRiskApplied: false });
    rebuildEvents();
    toast(t('t_reprice_fail', { msg: error.message }), true);
  } finally {
    simStore.set({ pending: false });
  }
}
