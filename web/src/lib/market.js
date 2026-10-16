// What the marketplace shows for each case, derived from the server's quotes and pools. Pure
// functions of the app state: every card, sort, summary and the detail panel go through them.
import * as f from './format.js';
import { t, tData } from './i18n.js';

export const PAUSED_ACTIONS = new Set(['PAUSE_OFFERING', 'FREEZE_POOL', 'TRIGGER_LIQUIDATION']);
// Pool states in which no new subscription is accepted (contract enum names plus the offchain 'Liquidated').
export const INACTIVE_POOL_STATES = new Set(['Paused', 'Frozen', 'Liquidation', 'Liquidated', 'Repaid', 'Redeemed', 'Cancelled']);

/** Yield per year: what investors compare offerings of different lengths by. Older quotes fall back to gross. */
export function annualYieldText(quote, unavailable = '--') {
  if (!quote || PAUSED_ACTIONS.has(quote.pricing_action)) return unavailable;
  return f.bpsToPct(quote.annualized_yield_bps ?? quote.implied_gross_yield_bps);
}

export function potentialYieldText(quote, unavailable = '--') {
  if (!quote || PAUSED_ACTIONS.has(quote.pricing_action)) return unavailable;
  return f.bpsToPct(quote.implied_gross_yield_bps);
}

const CATEGORY_MAP = {
  energy_chemical: ['crude', 'oil', 'refined', 'rubber', 'petroleum', 'chemical'],
  metal: ['copper', 'iron', 'aluminum', 'aluminium', 'steel'],
  ore: ['ore', 'concentrate']
};
export const CATEGORIES = ['all', 'energy_chemical', 'metal', 'ore'];

export function caseCategories(entry) {
  const cargo = (entry.case?.bill_of_lading?.cargo || entry.cargo || '').toLowerCase();
  const cats = [];
  for (const cat of ['ore', 'metal', 'energy_chemical']) if (CATEGORY_MAP[cat].some((k) => cargo.includes(k))) cats.push(cat);
  return cats.length ? cats : ['all'];
}

/** Cases after the category filter, the keyword search and (when active) the Copilot match. */
export function visibleCases(state) {
  let cases = state.cases;
  if (state.aiMatchedIds) {
    cases = cases.filter((c) => state.aiMatchedIds.has(c.case_id));
    cases = [...cases].sort((a, b) => (state.aiRanks?.get(a.case_id) ?? 0) - (state.aiRanks?.get(b.case_id) ?? 0));
  }
  if (state.categoryFilter !== 'all') cases = cases.filter((c) => caseCategories(c).includes(state.categoryFilter));
  // The Copilot already understood the intent, so its match is not narrowed by the raw keywords.
  if (!state.aiMatchedIds && state.searchQuery.trim()) {
    const q = state.searchQuery.trim().toLowerCase();
    cases = cases.filter((c) => {
      const bl = c.case?.bill_of_lading ?? {};
      return [c.label, c.cargo, c.route, c.risk_hint, c.case_id, bl.cargo, bl.port_of_loading, bl.port_of_discharge, bl.bl_id, bl.vessel_name]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }
  return cases;
}

export function cachedComparison(state, caseId) {
  return state.marketComparisons[caseId]?.comparison ?? null;
}

export function recommendedQuote(comparison) {
  const quotes = comparison?.quotes ?? [];
  const speed = comparison?.recommended_payout_speed;
  return quotes.find((q) => q.payout_speed === speed) ?? quotes[0] ?? null;
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
  const quote = pool?.quote ?? recommendedQuote(cachedComparison(state, entry.case_id));
  // A historical pool (kept only for its deployed testnet record) is never open for subscription.
  const paused = entry.historical === true || (pool ? INACTIVE_POOL_STATES.has(pool.status) : Boolean(quote && PAUSED_ACTIONS.has(quote.pricing_action)));
  return { pool, quote, paused };
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

/** The pool's recorded subscriptions against its target; null when the pool has no record. */
export function marketFunding(pool) {
  const raised = Number(pool?.subscribed_usd);
  const target = Number(pool?.target_usd);
  if (pool?.subscribed_usd == null || pool?.target_usd == null || !Number.isFinite(raised) || !Number.isFinite(target) || target <= 0) return null;
  return { raised, target, fill: Math.max(0, Math.min(1, raised / target)) };
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
  if (/copper|cuconc|-cu-|铜/u.test(text)) return 'copper';
  if (/crude|refined|-oil-|oil|petroleum|原油|成品油|油/u.test(text)) return 'oil';
  if (/ironore|iron|\bore\b|铁|矿/u.test(text)) return 'ore';
  if (/rubber|橡胶/u.test(text)) return 'rubber';
  if (/soybean|-soy-|soy|大豆/u.test(text)) return 'soybean';
  return 'alu';
}

export const CARGO_TYPES = ['copper', 'oil', 'ore', 'rubber', 'soybean', 'alu'];

export function cargoImage(value) {
  return `/img/cargo/${cargoType(value)}.webp`;
}
