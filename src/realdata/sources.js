// Free, key-less public data sources. Each function fetches, normalises and returns plain data, or
// throws. None of them decides anything; src/realdata/index.js turns the data into labelled evidence.
//
//   IMF PortWatch     daily ship transits through 28 maritime chokepoints (ArcGIS feature service)
//   Google News RSS   recent headlines for a query (titles, outlet, time, link)
//   Polymarket        public prediction-market odds (gamma API)
//   Open-Meteo Marine wave-height forecast at a point
//   Yahoo Finance     futures quotes (unofficial chart endpoint; may change without notice)

import { fetchJson, fetchText } from './http.js';

const DAY_MS = 86_400_000;
const PORTWATCH_URL = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function sqlList(names) {
  return names.map((name) => `'${String(name).replace(/'/gu, "''")}'`).join(',');
}

async function portwatchRows(where, options) {
  const params = new URLSearchParams({ where, outFields: 'date,portname,n_total', orderByFields: 'date', resultRecordCount: '2000', f: 'json' });
  const json = await fetchJson(`${PORTWATCH_URL}?${params}`, options);
  if (!Array.isArray(json.features)) throw new Error(json.error?.message ?? 'PortWatch returned no features');
  return json.features.map((feature) => feature.attributes ?? {}).filter((row) => row.portname && row.date);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/**
 * 7-day average transits per chokepoint against the same 7 days one year earlier.
 * @returns {Promise<Record<string, {latest_date, avg7, baseline7, ratio, daily}>>}
 */
export async function fetchChokepointTransits(names, { now = Date.now(), ...options } = {}) {
  if (names.length === 0) return {};
  const recentFrom = isoDay(now - 30 * DAY_MS);
  const recent = await portwatchRows(`portname IN (${sqlList(names)}) AND date >= '${recentFrom}'`, options);
  const out = {};
  for (const name of names) {
    const rows = recent.filter((row) => row.portname === name).sort((a, b) => a.date.localeCompare(b.date));
    if (rows.length === 0) continue;
    const last7 = rows.slice(-7);
    const latest = last7.at(-1).date;
    out[name] = { latest_date: latest, avg7: mean(last7.map((row) => Number(row.n_total) || 0)), daily: last7.map((row) => ({ date: row.date, n_total: row.n_total })) };
  }
  // Baseline: the same 7-day window a year before each chokepoint's latest day.
  const windows = Object.entries(out).map(([name, item]) => {
    const end = Date.parse(`${item.latest_date}T00:00:00Z`) - 364 * DAY_MS;
    return { name, from: isoDay(end - 6 * DAY_MS), to: isoDay(end) };
  });
  if (windows.length) {
    const from = windows.reduce((min, w) => (w.from < min ? w.from : min), windows[0].from);
    const to = windows.reduce((max, w) => (w.to > max ? w.to : max), windows[0].to);
    const base = await portwatchRows(`portname IN (${sqlList(windows.map((w) => w.name))}) AND date >= '${from}' AND date <= '${to}'`, options);
    for (const w of windows) {
      const baseline = mean(base.filter((row) => row.portname === w.name && row.date >= w.from && row.date <= w.to).map((row) => Number(row.n_total) || 0));
      out[w.name].baseline7 = baseline;
      out[w.name].ratio = baseline ? out[w.name].avg7 / baseline : null;
    }
  }
  return out;
}

function decodeXml(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&amp;/gu, '&')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tag(block, name) {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'u').exec(block);
  return match ? decodeXml(match[1]) : null;
}

/** Recent Google News headlines for a query (English edition). */
export async function fetchNewsHeadlines(query, { days = 7, limit = 8, ...options } = {}) {
  const params = new URLSearchParams({ q: `${query} when:${days}d`, hl: 'en-US', gl: 'US', ceid: 'US:en' });
  const xml = await fetchText(`https://news.google.com/rss/search?${params}`, options);
  const items = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gu)) {
    const block = match[1];
    const rawTitle = tag(block, 'title') ?? '';
    const source = tag(block, 'source');
    const title = source && rawTitle.endsWith(` - ${source}`) ? rawTitle.slice(0, -(source.length + 3)) : rawTitle;
    const published = Date.parse(tag(block, 'pubDate') ?? '');
    if (!title) continue;
    items.push({ title, source, date: Number.isFinite(published) ? new Date(published).toISOString() : null, url: tag(block, 'link') });
  }
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return items.slice(0, limit);
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Open Polymarket markets matching a search, with the YES price as the implied probability. */
export async function fetchPredictionMarkets(query, options = {}) {
  const params = new URLSearchParams({ q: query, limit_per_type: '10', events_status: 'active' });
  const json = await fetchJson(`https://gamma-api.polymarket.com/public-search?${params}`, options);
  const out = [];
  for (const event of json.events ?? []) {
    for (const market of event.markets ?? []) {
      if (market.closed || market.active === false) continue;
      const outcomes = parseArray(market.outcomes);
      const prices = parseArray(market.outcomePrices).map(Number);
      const yes = outcomes.findIndex((name) => String(name).toLowerCase() === 'yes');
      if (yes < 0 || !Number.isFinite(prices[yes])) continue;
      out.push({
        question: market.question ?? event.title,
        implied_prob: prices[yes],
        end_date: market.endDate ?? event.endDate ?? null,
        volume_usd: Number(market.volume ?? event.volume) || null,
        url: event.slug ? `https://polymarket.com/event/${event.slug}` : null,
        platform: 'Polymarket'
      });
    }
  }
  return out;
}

/** Highest forecast significant wave height (m) over the next `days` days at a point. */
export async function fetchSeaState({ lat, lon }, { days = 3, ...options } = {}) {
  const params = new URLSearchParams({ latitude: String(lat), longitude: String(lon), daily: 'wave_height_max', forecast_days: String(days), timezone: 'UTC' });
  const json = await fetchJson(`https://marine-api.open-meteo.com/v1/marine?${params}`, options);
  const heights = (json.daily?.wave_height_max ?? []).map(Number).filter(Number.isFinite);
  if (heights.length === 0) throw new Error('Open-Meteo returned no wave heights');
  const max = Math.max(...heights);
  return { max_wave_height_m: max, on: json.daily.time?.[heights.indexOf(max)] ?? null };
}

/** Last price and ~1-month change of a Yahoo Finance symbol. */
export async function fetchFuturesQuote(symbol, options = {}) {
  const json = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`, options);
  const result = json.chart?.result?.[0];
  const price = Number(result?.meta?.regularMarketPrice);
  if (!Number.isFinite(price)) throw new Error(json.chart?.error?.description ?? `no quote for ${symbol}`);
  const closes = (result.indicators?.quote?.[0]?.close ?? []).map(Number).filter(Number.isFinite);
  const first = closes[0];
  return {
    symbol,
    price,
    currency: result.meta.currency ?? 'USD',
    as_of: Number.isFinite(result.meta.regularMarketTime) ? new Date(result.meta.regularMarketTime * 1000).toISOString() : null,
    change_1m: Number.isFinite(first) && first > 0 ? price / first - 1 : null
  };
}
