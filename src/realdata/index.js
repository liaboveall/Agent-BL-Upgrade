// Real-world evidence for curated cases: market quotes and route risk from free public sources, with an
// offline snapshot of the same sources (data/real-data/snapshot.json, refreshed by
// `npm run realdata:snapshot`) when they are switched off or unreachable. Everything returned is
// labelled with where it came from and when, so stale data never passes for today's facts:
//
//   status 'live'     fetched from the source within its cache window
//   status 'stale'    the last good live value, because a refresh just failed
//   status 'offline'  the captured snapshot (its own capture date is shown)
//
// Mapping data to risk is deterministic and lives here, not in a model: transits through a chokepoint
// against the same week last year, wave height on the route, prediction-market odds on a named
// disruption, and the month's price move. Headlines are evidence for a person to read; they are never
// priced on their own (src/agent/worldRiskAgent.js caps them).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { realDataEnabled, sharedCache } from './http.js';
import {
  fetchChokepointTransits,
  fetchFuturesQuote,
  fetchNewsHeadlines,
  fetchPredictionMarkets,
  fetchSeaState
} from './sources.js';

const SNAPSHOT_URL = new URL('../../data/real-data/snapshot.json', import.meta.url);
const MINUTE = 60_000;
const LB_PER_MT = 2204.62262;
const BU_PER_MT_SOY = 36.7437;
const GAL_PER_BBL = 42;

/** Futures used to mark curated cargoes to market. Conversions give USD per metric tonne or per barrel. */
export const BENCHMARKS = Object.freeze({
  copper: { symbol: 'HG=F', label: 'COMEX copper futures (HG=F)', quoted: 'USD/lb', perMt: (price) => price * LB_PER_MT },
  aluminium: { symbol: 'ALI=F', label: 'COMEX aluminium futures (ALI=F)', quoted: 'USD/MT', perMt: (price) => price },
  brent: { symbol: 'BZ=F', label: 'ICE Brent crude futures (BZ=F)', quoted: 'USD/bbl', perBbl: (price) => price },
  gasoil: { symbol: 'HO=F', label: 'NYMEX ULSD futures (HO=F), gasoil proxy', quoted: 'USD/gal', perBbl: (price) => price * GAL_PER_BBL },
  soybeans: { symbol: 'ZS=F', label: 'CBOT soybean futures (ZS=F)', quoted: 'USc/bu', perMt: (price) => (price / 100) * BU_PER_MT_SOY }
});

let snapshotCache;
/** The captured offline snapshot (empty sections when the file is missing). */
export function loadSnapshot() {
  if (snapshotCache === undefined) {
    try {
      snapshotCache = JSON.parse(fs.readFileSync(fileURLToPath(SNAPSHOT_URL), 'utf8'));
    } catch {
      snapshotCache = null;
    }
  }
  return snapshotCache ?? { captured_at: null, prices: {}, chokepoints: {}, sea_state: {}, prediction_markets: {}, news: {} };
}

/** Test hook: forget the cached snapshot file and every cached live value. */
export function resetRealDataCaches() {
  snapshotCache = undefined;
  sharedCache.clear();
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function liveOrSnapshot(key, ttlMs, load, snapshotValue, options) {
  const snapshot = loadSnapshot();
  const offline = () => (snapshotValue === undefined || snapshotValue === null ? null
    : { value: snapshotValue, status: 'offline', fetched_at: snapshot.captured_at });
  if (!realDataEnabled(options.env)) return offline();
  try {
    const hit = await (options.cache ?? sharedCache).get(key, ttlMs, load);
    return { value: hit.value, status: hit.stale ? 'stale' : 'live', fetched_at: hit.fetched_at };
  } catch {
    return offline();
  }
}

function quoteFrom(key, raw) {
  const spec = BENCHMARKS[key];
  return {
    key,
    symbol: spec.symbol,
    benchmark: spec.label,
    quoted_price: raw.price,
    quoted_unit: spec.quoted,
    ...(spec.perMt ? { price_usd_per_mt: round(spec.perMt(raw.price)) } : {}),
    ...(spec.perBbl ? { price_usd_per_bbl: round(spec.perBbl(raw.price)) } : {}),
    change_1m: raw.change_1m === null || raw.change_1m === undefined ? null : round(raw.change_1m, 4),
    as_of: raw.as_of
  };
}

/** A benchmark quote, live or from the snapshot; null when neither has it. */
export async function getMarketQuote(key, options = {}) {
  const spec = BENCHMARKS[key];
  if (!spec) return null;
  const snap = loadSnapshot().prices?.[key];
  const got = await liveOrSnapshot(`price:${key}`, 30 * MINUTE, () => fetchFuturesQuote(spec.symbol, options), snap, options);
  if (!got) return null;
  return { ...quoteFrom(key, got.value), status: got.status, fetched_at: got.fetched_at, source: `Yahoo Finance · ${spec.label}` };
}

async function getChokepoints(names, options) {
  const snap = loadSnapshot().chokepoints ?? {};
  const out = {};
  if (names.length === 0) return out;
  const snapshotPart = Object.fromEntries(names.filter((name) => snap[name]).map((name) => [name, snap[name]]));
  const got = await liveOrSnapshot(`chokepoints:${[...names].sort().join('|')}`, 6 * 60 * MINUTE,
    () => fetchChokepointTransits(names, options), Object.keys(snapshotPart).length ? snapshotPart : null, options);
  for (const name of names) {
    const item = got?.value?.[name];
    if (item) out[name] = { ...item, status: got.status, fetched_at: got.fetched_at };
  }
  return out;
}

async function getSeaStates(points, options) {
  const snap = loadSnapshot().sea_state ?? {};
  const results = await Promise.all(points.map(async (point) => {
    const id = `${point.lat},${point.lon}`;
    const got = await liveOrSnapshot(`sea:${id}`, 60 * MINUTE, () => fetchSeaState(point, options), snap[id], options);
    return got ? { ...point, ...got.value, status: got.status, fetched_at: got.fetched_at } : null;
  }));
  return results.filter(Boolean);
}

/** Polymarket markets for a query, live or from the snapshot. */
export async function getPredictionMarkets(query, options = {}) {
  const got = await liveOrSnapshot(`pm:${query}`, 30 * MINUTE, () => fetchPredictionMarkets(query, options), loadSnapshot().prediction_markets?.[query], options);
  return got ? { items: got.value, status: got.status, fetched_at: got.fetched_at } : { items: [], status: 'unavailable', fetched_at: null };
}

/** Google News headlines for a query, live or from the snapshot. */
export async function getNews(query, options = {}) {
  const got = await liveOrSnapshot(`news:${query}`, 30 * MINUTE, () => fetchNewsHeadlines(query, options), loadSnapshot().news?.[query], options);
  return got ? { items: got.value, status: got.status, fetched_at: got.fetched_at } : { items: [], status: 'unavailable', fetched_at: null };
}

// --- route risk ---------------------------------------------------------------------------------

const DOWNGRADE = { critical: 'warning', warning: 'info', info: null };

/** Transits against the same week a year earlier → severity (null = normal traffic). */
export function chokepointSeverity(ratio) {
  if (!Number.isFinite(ratio)) return null;
  if (ratio < 0.35) return 'critical';
  if (ratio < 0.7) return 'warning';
  return null;
}

export function waveSeverity(heightM) {
  if (!Number.isFinite(heightM)) return null;
  if (heightM >= 6) return 'critical';
  if (heightM >= 4) return 'warning';
  return null;
}

/** Probability that a named disruption persists → severity. */
export function disruptionSeverity(prob) {
  if (!Number.isFinite(prob)) return null;
  if (prob >= 0.4) return 'critical';
  if (prob >= 0.2) return 'warning';
  return null;
}

export function volatilitySeverity(change) {
  if (!Number.isFinite(change)) return null;
  const size = Math.abs(change);
  if (size >= 0.25) return 'critical';
  if (size >= 0.12) return 'warning';
  return null;
}

function day(iso) {
  return typeof iso === 'string' ? iso.slice(0, 10) : null;
}

function pct(value) {
  return `${value >= 0 ? '+' : ''}${Math.round(value * 100)}%`;
}

/**
 * Pick the market that answers "is the disruption still on when this cargo needs the route": among
 * markets whose question matches, the one that resolves first on or after `horizon` (else the last).
 */
export function pickDisruptionMarket(items, spec, horizon) {
  const pattern = new RegExp(spec.match, 'iu');
  const matching = items.filter((item) => pattern.test(item.question ?? '') && item.end_date);
  if (matching.length === 0) return null;
  matching.sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)));
  const chosen = matching.find((item) => day(item.end_date) >= horizon) ?? matching.at(-1);
  const prob = spec.bad_outcome === 'no' ? 1 - chosen.implied_prob : chosen.implied_prob;
  return { ...chosen, disruption_prob: round(prob, 4) };
}

/**
 * Route-risk events for a case from its `route_profile` (chokepoints, waypoints, disruption markets)
 * and its market benchmark. Deterministic given the data; every event says where its data came from.
 * @returns {Promise<{events: object[], evidence: object, status: string}>}
 */
export async function routeRiskEvents(caseData, options = {}) {
  const profile = caseData?.route_profile ?? {};
  const transit = profile.chokepoints ?? [];
  const nearby = profile.nearby_chokepoints ?? [];
  const events = [];
  const statuses = new Set();
  const evidence = { chokepoints: [], sea_state: [], markets: [], price: null };

  const chokepoints = await getChokepoints([...transit, ...nearby], options);
  for (const name of [...transit, ...nearby]) {
    const item = chokepoints[name];
    if (!item) continue;
    statuses.add(item.status);
    const adjacent = !transit.includes(name);
    let severity = chokepointSeverity(item.ratio);
    if (severity && adjacent) severity = DOWNGRADE[severity];
    evidence.chokepoints.push({ name, adjacent, latest_date: item.latest_date, avg7: round(item.avg7, 1), baseline7: item.baseline7 === null || item.baseline7 === undefined ? null : round(item.baseline7, 1), ratio: item.ratio === null || item.ratio === undefined ? null : round(item.ratio, 3), status: item.status });
    if (!severity) continue;
    events.push({
      date: item.latest_date,
      type: 'chokepoint_disruption',
      region: adjacent ? `${name} (adjacent)` : name,
      severity,
      description: `IMF PortWatch: ${round(item.avg7, 1)} ship transits/day through ${name} over the 7 days to ${item.latest_date}, versus ${round(item.baseline7, 1)} a year earlier (${pct(item.ratio - 1)}).${adjacent ? ' The route does not transit it but loads next to it.' : ''}`,
      source: 'IMF PortWatch',
      data_status: item.status,
      evidence_url: 'https://portwatch.imf.org/pages/chokepoints'
    });
  }

  for (const spec of profile.disruption_markets ?? []) {
    const markets = await getPredictionMarkets(spec.query, options);
    if (markets.status === 'unavailable') continue;
    statuses.add(markets.status);
    const horizon = day(caseData?.bill_of_lading?.eta) ?? day(new Date().toISOString());
    const chosen = pickDisruptionMarket(markets.items, spec, horizon);
    if (!chosen) continue;
    const adjacent = spec.adjacent === true;
    let severity = disruptionSeverity(chosen.disruption_prob);
    if (severity && adjacent) severity = DOWNGRADE[severity];
    evidence.markets.push({ question: chosen.question, implied_prob: chosen.implied_prob, disruption_prob: chosen.disruption_prob, end_date: chosen.end_date, url: chosen.url, status: markets.status });
    if (!severity) continue;
    events.push({
      date: day(markets.fetched_at) ?? horizon,
      type: 'war_risk',
      region: adjacent ? `${spec.region} (adjacent)` : spec.region,
      severity,
      description: `Polymarket: "${chosen.question}" trades at ${Math.round(chosen.implied_prob * 100)}% YES, i.e. ${Math.round(chosen.disruption_prob * 100)}% that the disruption is still on.`,
      source: 'Polymarket',
      data_status: markets.status,
      evidence_url: chosen.url
    });
  }

  for (const point of await getSeaStates(profile.waypoints ?? [], options)) {
    statuses.add(point.status);
    evidence.sea_state.push({ name: point.name, max_wave_height_m: point.max_wave_height_m, on: point.on, status: point.status });
    const severity = waveSeverity(point.max_wave_height_m);
    if (!severity) continue;
    events.push({
      date: point.on ?? day(point.fetched_at),
      type: 'severe_weather',
      region: point.name,
      severity,
      description: `Open-Meteo Marine: waves up to ${point.max_wave_height_m} m forecast at ${point.name} on ${point.on}.`,
      source: 'Open-Meteo Marine',
      data_status: point.status,
      evidence_url: 'https://open-meteo.com/en/docs/marine-weather-api'
    });
  }

  const key = caseData?.market?.benchmark_key;
  if (key) {
    const quote = await getMarketQuote(key, options);
    if (quote) {
      statuses.add(quote.status);
      evidence.price = quote;
      const severity = volatilitySeverity(quote.change_1m);
      if (severity) {
        events.push({
          date: day(quote.as_of),
          type: 'commodity_volatility',
          region: 'Global',
          severity,
          description: `${quote.benchmark}: ${pct(quote.change_1m)} over the past month (Yahoo Finance).`,
          source: 'Yahoo Finance',
          data_status: quote.status,
          evidence_url: `https://finance.yahoo.com/quote/${encodeURIComponent(quote.symbol)}`
        });
      }
    }
  }

  const status = statuses.size === 0 ? 'unavailable' : statuses.size === 1 ? [...statuses][0] : 'mixed';
  return { events, evidence, status };
}

/** Mark a case's market block to a benchmark quote. Invoice, contract price and premiums are untouched. */
export function markToMarket(caseData, quote) {
  const market = caseData?.market;
  if (!market || !quote) return caseData;
  const next = { ...market };
  if (Number.isFinite(quote.price_usd_per_bbl) && (market.reference_price_usd_per_bbl !== undefined || market.price_unit === 'USD/bbl')) {
    const differential = Number(market.grade_differential_usd_per_bbl ?? 0);
    next.reference_price_usd_per_bbl = quote.price_usd_per_bbl;
    next.current_price_usd_per_bbl = quote.price_usd_per_bbl;
    if (market.landed_price_usd_per_bbl !== undefined) next.landed_price_usd_per_bbl = round(quote.price_usd_per_bbl + differential);
  } else if (Number.isFinite(quote.price_usd_per_bbl) && Number.isFinite(Number(market.bbl_per_mt))) {
    const perMt = round(quote.price_usd_per_bbl * Number(market.bbl_per_mt));
    const premium = Number(market.regional_premium_usd_per_mt ?? 0);
    next.reference_price_usd_per_mt = perMt;
    next.current_price_usd_per_mt = perMt;
    if (market.landed_price_usd_per_mt !== undefined) next.landed_price_usd_per_mt = round(perMt + premium);
  } else if (Number.isFinite(quote.price_usd_per_mt)) {
    // A concentrate is worth its payable metal: benchmark x factor (e.g. 28% Cu x 96.65% payable).
    const factor = Number.isFinite(Number(market.benchmark_factor)) ? Number(market.benchmark_factor) : 1;
    const premium = Number(market.regional_premium_usd_per_mt ?? 0);
    const perUnit = round(quote.price_usd_per_mt * factor);
    next.reference_price_usd_per_mt = perUnit;
    next.current_price_usd_per_mt = perUnit;
    if (market.landed_price_usd_per_mt !== undefined) next.landed_price_usd_per_mt = round(perUnit + premium);
  } else {
    return caseData;
  }
  next.as_of = day(quote.as_of) ?? market.as_of;
  next.source = quote.source;
  next.data_status = quote.status;
  return { ...caseData, market: next };
}

/**
 * Attach today's real-world evidence to a curated case: mark it to market and append route-risk events
 * (replacing the ones a previous call added). Cases without a benchmark or route profile pass through.
 */
export async function enrichCaseWithRealData(caseData, options = {}) {
  if (!caseData || (!caseData.market?.benchmark_key && !caseData.route_profile)) return caseData;
  let out = caseData;
  const quote = caseData.market?.benchmark_key ? await getMarketQuote(caseData.market.benchmark_key, options) : null;
  if (quote) out = markToMarket(out, quote);
  const risk = caseData.route_profile ? await routeRiskEvents(out, options) : { events: [], evidence: {}, status: quote?.status ?? 'unavailable' };
  const kept = (out.macro_risk_events ?? []).filter((event) => event.source_kind !== 'real-data');
  out = {
    ...out,
    macro_risk_events: [...kept, ...risk.events.map((event) => ({ ...event, source_kind: 'real-data' }))],
    real_data: {
      status: risk.status === 'unavailable' && quote ? quote.status : risk.status,
      snapshot_captured_at: loadSnapshot().captured_at,
      market: quote ? { benchmark: quote.benchmark, status: quote.status, as_of: quote.as_of, price_usd_per_mt: quote.price_usd_per_mt ?? null, price_usd_per_bbl: quote.price_usd_per_bbl ?? null, change_1m: quote.change_1m } : null,
      chokepoints: risk.evidence.chokepoints ?? [],
      sea_state: risk.evidence.sea_state ?? [],
      markets: risk.evidence.markets ?? []
    }
  };
  return out;
}
