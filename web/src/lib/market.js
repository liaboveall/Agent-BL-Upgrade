// What the marketplace shows for each case, derived from the server's quotes and pools. Pure
// functions of the app state: every card, sort, summary and the detail panel go through them.
import * as f from './format.js';
import { t, tData } from './i18n.js';
import { subscriptionAvailability } from '../../../src/core/subscription.js';

export const PAUSED_ACTIONS = new Set(['PAUSE_OFFERING', 'FREEZE_POOL', 'TRIGGER_LIQUIDATION']);
// Pool states in which no new subscription is accepted (contract enum names plus the offchain 'Liquidated').
export const INACTIVE_POOL_STATES = new Set(['Funded', 'InTransit', 'Paused', 'Frozen', 'Liquidation', 'Liquidated', 'Repaid', 'Redeemed', 'Cancelled', 'Defaulted', 'LossSettled']);

/** Yield per year: what investors compare offerings of different lengths by. Older quotes fall back to gross. */
export function annualYieldText(quote, unavailable = '—') {
  if (!quote || PAUSED_ACTIONS.has(quote.pricing_action)) return unavailable;
  return f.bpsToPct(quote.annualized_yield_bps ?? quote.implied_gross_yield_bps);
}

export function potentialYieldText(quote, unavailable = '—') {
  if (!quote || PAUSED_ACTIONS.has(quote.pricing_action)) return unavailable;
  return f.bpsToPct(quote.implied_gross_yield_bps);
}

// Display order of the category chips; the toolbar adds 'all' and hides categories with no cases.
export const CATEGORIES = ['metal', 'energy', 'ore', 'agriculture', 'other'];

// One category per case; the first matching rule wins, so ores and concentrates are not counted as
// metals and vegetable oils stay agricultural. Cargo lines may be Chinese (e.g. "铝锭 AL99.70").
const CATEGORY_RULES = [
  ['ore', /\bores?\b|concentrate|矿/u],
  ['agriculture', /soy|grain|wheat|corn|maize|rice|sugar|coffee|cocoa|cotton|palm|rubber|大豆|谷物|小麦|玉米|橡胶|棉花|糖/u],
  ['energy', /crude|petroleum|gasoil|gasoline|diesel|kerosene|jet fuel|\bfuel\b|\boil\b|\blng\b|\blpg\b|\bcoal\b|原油|成品油|柴油|汽油|燃料油|煤/u],
  ['metal', /copper|alumin|steel|zinc|nickel|\biron\b|\btin\b|\blead\b|metal|cathode|ingot|p1020|adc12|铜|铝|钢|锌|镍|锭/u]
];

function categoryText(entry) {
  const data = entry?.case ?? {};
  return [data.cargo?.commodity, data.bill_of_lading?.cargo, entry?.cargo, entry?.case_id].filter(Boolean).join(' ').toLowerCase();
}

/** The single category a market case belongs to. */
export function caseCategory(entry) {
  const text = categoryText(entry);
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
}

/** Lower-case search terms, split on whitespace and punctuation. */
export function searchTerms(query) {
  return String(query ?? '').toLowerCase().split(/[\s,;/|·→()（）[\]]+/u).map((term) => term.trim()).filter(Boolean);
}

/** What a case can be found by: its data, the displayed translation and its category name. */
export function caseSearchFields(entry) {
  const data = entry?.case ?? {};
  const bl = data.bill_of_lading ?? {};
  const fields = [
    entry?.case_id, entry?.label, entry?.cargo, entry?.route, entry?.risk_hint,
    data.cargo?.commodity, data.cargo?.grade,
    bl.cargo, bl.bl_id, bl.bl_no, bl.vessel, bl.vessel_name, bl.voyage_no,
    bl.port_of_loading, bl.port_of_discharge, bl.shipper, bl.consignee, bl.carrier
  ].filter((value) => typeof value === 'string' && value.trim());
  const category = caseCategory(entry);
  return [...fields, ...fields.map((value) => tData(value)), category, t(`cat_${category}`)];
}

/** True when every search term appears somewhere in the fields; an empty query matches all. */
export function matchesSearch(fields, query) {
  const terms = searchTerms(query);
  if (!terms.length) return true;
  const haystack = fields.join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Cases after the keyword search or (when active) the Copilot match, before the category filter. */
export function searchedCases(state) {
  let cases = state.cases;
  if (state.aiMatchedIds) {
    cases = cases.filter((c) => state.aiMatchedIds.has(c.case_id));
    cases = [...cases].sort((a, b) => (state.aiRanks?.get(a.case_id) ?? 0) - (state.aiRanks?.get(b.case_id) ?? 0));
  } else if (state.searchQuery.trim()) {
    // The Copilot already understood the intent, so its match is not narrowed by the raw keywords.
    cases = cases.filter((c) => matchesSearch(caseSearchFields(c), state.searchQuery));
  }
  return cases;
}

/** Cases after the category filter, the keyword search and (when active) the Copilot match. */
export function visibleCases(state) {
  const cases = searchedCases(state);
  if (state.categoryFilter === 'all') return cases;
  return cases.filter((c) => caseCategory(c) === state.categoryFilter);
}

/** Category chips to show: 'all' plus every category some case belongs to, each with its match count. */
export function categoryOptions(state) {
  const present = new Set(state.cases.map(caseCategory));
  const searched = searchedCases(state);
  const count = (name) => (name === 'all' ? searched.length : searched.filter((c) => caseCategory(c) === name).length);
  return ['all', ...CATEGORIES.filter((name) => present.has(name))].map((name) => ({ name, count: count(name) }));
}

export function cachedComparison(state, caseId) {
  return state.marketComparisons[caseId]?.comparison ?? null;
}

export function recommendedQuote(comparison) {
  const quotes = comparison?.quotes ?? [];
  const speed = comparison?.recommended_payout_speed;
  return quotes.find((q) => q.payout_speed === speed) ?? quotes[0] ?? null;
}

/**
 * The terms a case is offered on before its pool has loaded: the payout speed the case names, as the server's pool
 * quotes it (BALANCED when it names none), so a card never shows a price that a subscription would not use.
 */
export function publishedQuote(comparison, entry) {
  const quotes = comparison?.quotes ?? [];
  const named = entry?.case?.financing?.payout_speed;
  return quotes.find((q) => q.payout_speed === named) ?? quotes.find((q) => q.payout_speed === 'BALANCED') ?? recommendedQuote(comparison);
}

export function defaultMarketSubscription(quote) {
  const target = Number(quote?.expected_cash_to_exporter_usd ?? quote?.requested_cash_usd ?? 0);
  if (!Number.isFinite(target) || target <= 0) return 100000;
  return Math.max(50000, Math.round((target * 0.08) / 10000) * 10000);
}

/**
 * What the market shows for one case: the agent's pool (status, quote and recorded subscriptions) when it
 * has one, otherwise the cached price comparison.
 */
export function marketView(state, entry) {
  const pool = state.evidencePools.get(entry.case_id) ?? null;
  const quote = pool?.quote ?? publishedQuote(cachedComparison(state, entry.case_id), entry);
  // A historical pool (kept only for its deployed testnet record) is never open for subscription.
  const availability = pool ? subscriptionAvailability({ ...pool, historical: entry.historical })
    : { can_subscribe: Boolean(quote && !entry.historical && !PAUSED_ACTIONS.has(quote.pricing_action)), remaining_usd: null };
  const canSubscribe = pool?.can_subscribe === false ? false : availability.can_subscribe;
  const paused = !canSubscribe;
  return { pool, quote, paused, canSubscribe, remainingUsd: pool?.remaining_usd ?? availability.remaining_usd };
}

/** Where a case's market price and route risk come from: live, offline snapshot, reference or historical. */
export function marketDataSource(entry) {
  if (entry.historical) return { tone: 'muted', text: t('src_historical') };
  const data = entry.case ?? {};
  const status = data.real_data?.status ?? data.market?.data_status ?? null;
  const captured = data.real_data?.snapshot_captured_at ? f.fmtDate(data.real_data.snapshot_captured_at.slice(0, 10)) : '—';
  if (status === 'live' && data.market?.data_status === 'reference') return { tone: 'ok', text: t('src_live_reference', { date: f.fmtDate(data.market.price_reference_date) }) };
  if (status === 'live') return { tone: 'ok', text: t('src_live') };
  if (status === 'stale') return { tone: 'warn', text: t('src_stale') };
  if (status === 'mixed') return { tone: 'warn', text: t('src_mixed') };
  if (status === 'offline') return { tone: 'muted', text: t('src_offline', { date: captured }) };
  if (status === 'reference') return { tone: 'muted', text: t('src_reference', { date: f.fmtDate(data.market?.price_reference_date) }) };
  return { tone: 'muted', text: t('src_none') };
}

/** A card-sized form of marketDataSource: what kind of price this is, so comparisons carry their basis. */
export function marketSourceShort(entry) {
  if (entry.historical) return { tone: 'muted', text: t('src_short_historical') };
  const data = entry.case ?? {}, status = data.real_data?.status ?? data.market?.data_status ?? null;
  const date = (value) => (value ? f.fmtDate(String(value).slice(0, 10)).slice(5) : '—');
  if (status === 'live') return { tone: 'ok', text: t('src_short_live') };
  if (status === 'stale') return { tone: 'warn', text: t('src_short_stale') };
  if (status === 'mixed') return { tone: 'warn', text: t('src_short_mixed') };
  if (status === 'offline') return { tone: 'muted', text: t('src_short_offline', { date: date(data.real_data?.snapshot_captured_at) }) };
  if (status === 'reference') return { tone: 'muted', text: t('src_short_reference', { date: date(data.market?.price_reference_date) }) };
  return { tone: 'muted', text: t('src_short_none') };
}

/** The trade document behind a case: an electronic bill of lading or a warehouse receipt. */
export function documentTypeLabel(entry) {
  const type = entry.case?.bill_of_lading?.bl_type ?? '';
  if (type === 'electronic_warehouse_receipt') return t('market_doc_ewr');
  return type ? t('market_doc_ebl') : t('market_doc_other');
}

/** The pool's recorded subscriptions against its target; null when the pool has no record. */
export function marketFunding(pool) {
  const raised = Number(pool?.subscribed_usd);
  const target = Number(pool?.target_usd);
  if (pool?.subscribed_usd == null || pool?.target_usd == null || !Number.isFinite(raised) || !Number.isFinite(target) || target <= 0) return null;
  const fill = pool.token_supply > 0 && pool.subscribed_shares != null ? pool.subscribed_shares / pool.token_supply : raised / target;
  return { raised, target, fill: Math.max(0, Math.min(1, fill)) };
}

export const MARKET_SORTS = ['recommended', 'yield_desc', 'risk_asc', 'funding_desc', 'eta_asc'];

export function sortMarketCases(state, cases) {
  const riskRank = { LOW: 0, MEDIUM: 1, WARNING: 2, CRITICAL: 3 };
  const etaOf = (c) => +(f.parseDate(c.case?.bill_of_lading?.eta) ?? 0) || Number.MAX_SAFE_INTEGER;
  const fundingOf = (c) => marketFunding(marketView(state, c).pool)?.fill ?? -1;
  const riskOf = (c) => riskRank[marketView(state, c).quote?.risk_level] ?? 9;
  const yieldOf = (c) => {
    const { quote, paused } = marketView(state, c);
    return quote && !paused ? quote.annualized_yield_bps ?? quote.implied_gross_yield_bps ?? -1 : -1;
  };
  return [...cases].sort((a, b) => {
    if (state.aiRanks) return (state.aiRanks.get(a.case_id) ?? 99) - (state.aiRanks.get(b.case_id) ?? 99);
    if (state.marketSort === 'yield_desc') return yieldOf(b) - yieldOf(a);
    if (state.marketSort === 'risk_asc') return riskOf(a) - riskOf(b) || etaOf(a) - etaOf(b);
    if (state.marketSort === 'funding_desc') return fundingOf(b) - fundingOf(a);
    if (state.marketSort === 'eta_asc') return etaOf(a) - etaOf(b);
    return (a.order ?? 99) - (b.order ?? 99) || a.case_id.localeCompare(b.case_id);
  });
}

/** The header figures: shown projects, financing target, average annual yield of the open ones, open/priced. */
export function marketStats(state, cases) {
  const views = cases.map((c) => marketView(state, c)).filter((view) => view.quote);
  const quotes = views.map((view) => view.quote);
  const open = views.filter((view) => !view.paused).map((view) => view.quote);
  const target = quotes.reduce((sum, q) => sum + Number(q.expected_cash_to_exporter_usd ?? q.requested_cash_usd ?? 0), 0);
  const avgYield = open.length ? open.reduce((sum, q) => sum + Number(q.annualized_yield_bps ?? q.implied_gross_yield_bps ?? 0), 0) / open.length : null;
  return { count: cases.length, target, avgYield, open: open.length, priced: quotes.length || cases.length };
}

export function cargoQuantity(bl) {
  if (bl.quantity_mt) return `${f.int(bl.quantity_mt)} MT`;
  if (bl.quantity_bbl) return `${f.int(bl.quantity_bbl)} bbl`;
  return bl.containers || '';
}

/** Share of the voyage done at `now`, from the bill of lading's departure and ETA; null when either is missing. */
export function marketVoyageProgress(caseData, now = Date.now()) {
  const bl = caseData?.bill_of_lading ?? {};
  const dep = f.parseDate(bl.shipped_on_board || bl.issue_date);
  const eta = f.parseDate(bl.eta);
  if (!dep || !eta || +eta <= +dep) return null;
  return f.voyageProgress(dep, eta, now);
}

/**
 * The moment a voyage is measured at. Demo figures are a snapshot, so the voyage is read as of the day it was
 * captured (the project dialog does the same); otherwise every Demo project would read "arrived" once the
 * calendar passes the fixtures' ETAs. Live always uses the real clock.
 */
export function marketClock(entry, demoMode, now = Date.now()) {
  if (!demoMode) return now;
  const captured = Date.parse(entry?.case?.real_data?.snapshot_captured_at ?? '');
  return Number.isFinite(captured) ? captured : now;
}

/** Case ids whose card would look the same as another one (same cargo and place); the card then adds its registry tail. */
export function duplicateLabelIds(cases) {
  const groups = new Map();
  for (const entry of cases) {
    const bl = entry.case?.bill_of_lading ?? {};
    const key = `${shortCargoName(tData(bl.cargo || entry.cargo || entry.case_id))}|${shortRoute(bl)}`;
    groups.set(key, [...(groups.get(key) ?? []), entry.case_id]);
  }
  return new Set([...groups.values()].filter((ids) => ids.length > 1).flat());
}

/** The short registry tail that tells two otherwise identical documents apart: "EWR-2026-FS-AL0-00013" -> "00013". */
export function registryTag(entry) {
  const id = String(entry.case?.bill_of_lading?.bl_id ?? entry.case_id ?? '');
  return id.split('-').pop();
}

export function marketVoyageNote(bl, progress) {
  const disch = tData(bl.port_of_discharge) || 'destination';
  if (progress === null) return t('market_voyage_unknown');
  if (progress >= 1) return t('market_arrived', { disch });
  return t('market_voyage_note', { pct: Math.round(progress * 100), disch, eta: f.fmtDate(bl.eta) });
}

/** Drop parenthetical detail, half- and full-width: "铝锭 AL99.70（P1020 级别…）" → "铝锭 AL99.70". */
export function stripParens(value) {
  return String(value ?? '').replace(/\s*[(（][^)）]*[)）]/gu, '').trim();
}

export function shortCargoName(value) {
  const text = stripParens(value || 'Trade case');
  return text.length > 34 ? text.slice(0, 31).trimEnd() + '…' : text;
}

/** The route as a card shows it: port names without terminal detail; one place when cargo stays put. */
export function shortRoute(bl) {
  const from = stripParens(tData(bl.port_of_loading)) || '?';
  const to = stripParens(tData(bl.port_of_discharge)) || '?';
  return from === to ? t('market_route_same', { place: from }) : `${from} → ${to}`;
}

export function shortLabel(entry) {
  const bl = entry.case?.bill_of_lading ?? {};
  const cargo = shortCargoName(tData(bl.cargo || entry.cargo || entry.case_id));
  const load = tData(bl.port_of_loading);
  const disch = tData(bl.port_of_discharge);
  return load && disch ? `${cargo} · ${load} → ${disch}` : cargo;
}

export function routeText(bl) {
  return `${tData(bl.port_of_loading) || '?'} → ${tData(bl.port_of_discharge) || '?'}`;
}

/** Option text: label plus the current quote's risk (the catalog hint is only a fallback before quotes load). */
export function caseOptionLabel(state, entry) {
  const level = marketView(state, entry).quote?.risk_level ?? entry.risk_hint;
  return shortLabel(entry) + (level ? ` · ${f.riskLabel(level)}` : '');
}

/** The cargo picture for a case id or cargo name. Every name returned here exists in public/img/cargo/. */
export function cargoType(value) {
  const text = String(value ?? '').toLowerCase();
  if (/cuconc|copper[ -]concentrate|铜精矿/u.test(text)) return 'copper-concentrate';
  if (/copper|-cu-|铜/u.test(text)) return 'copper';
  if (/refined|gasoil|diesel|成品油|柴油/u.test(text)) return 'diesel';
  if (/crude|-oil-|oil|petroleum|原油|油/u.test(text)) return 'oil';
  if (/ironore|iron|\bore\b|铁|矿/u.test(text)) return 'ore';
  if (/rubber|橡胶/u.test(text)) return 'rubber';
  if (/soybean|-soy-|soy|大豆/u.test(text)) return 'soybean';
  return 'alu';
}

export const CARGO_TYPES = ['copper', 'copper-concentrate', 'oil', 'diesel', 'ore', 'rubber', 'soybean', 'alu'];

const CASE_CARGO_IMAGES = {
  'CASE-EBL-2026-0001': 'copper-hamburg',
  'CASE-EBL-2026-CU-SG-SHA': 'copper-historical',
  'CASE-EBL-2026-ALU-FS-WH-00013': 'alu-fs-wh-00013',
  'CASE-EBL-2026-ALU-FS-WH-00014': 'alu-fs-wh-00014',
  'CASE-EBL-2026-ALU-FS-WH-00015': 'alu-fs-wh-00015'
};

/** Use the project's own image when available, otherwise the appropriate cargo photo. */
export function cargoImage(value, caseId = value) {
  const image = Object.hasOwn(CASE_CARGO_IMAGES, caseId) ? CASE_CARGO_IMAGES[caseId] : cargoType(value);
  return `/img/cargo/${image}.webp?v=2`;
}
