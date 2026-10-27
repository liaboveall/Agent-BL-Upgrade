// Real data (src/realdata) and demo dates (src/core/caseDates.js): the sources parse what they are
// given, map it to risk deterministically, fall back to the labelled snapshot, and curated dates move
// with today while their relative meaning stays.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { DEMO_DATE_ANCHOR, demoToday, rebaseCaseDates, rebaseDocumentText, shiftDatesInText, shiftDaysFor } from '../src/core/caseDates.js';
import { loadCuratedCase, loadCuratedDocument } from '../src/core/curatedCases.js';
import { quoteFromCase, tenorFromCase } from '../src/core/pricingEngine.js';
import { fetchJson, realDataEnabled, TtlCache } from '../src/realdata/http.js';
import {
  fetchChokepointTransits, fetchFuturesQuote, fetchNewsHeadlines, fetchPredictionMarkets, fetchSeaState
} from '../src/realdata/sources.js';
import {
  chokepointSeverity, disruptionSeverity, enrichCaseWithRealData, getMarketQuote, getNews, getPredictionMarkets, loadSnapshot,
  markToMarket, pickDisruptionMarket, resetRealDataCaches, routeRiskEvents, volatilitySeverity, waveSeverity
} from '../src/realdata/index.js';
import { assessWorldRisk } from '../src/agent/worldRiskAgent.js';
import { mergeWorldRiskIntoCase } from '../src/core/worldRiskPricing.js';

const readCase = async (name) => JSON.parse(await fs.readFile(new URL(`../data/cases/${name}.case.json`, import.meta.url), 'utf8'));
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 503, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// ---------------------------------------------------------------- dates

test('demo dates: every ISO date moves by the same number of days, other text does not', () => {
  assert.equal(shiftDatesInText('loaded 2026-10-13, ETA 2026-10-20T08:00:00Z', 3), 'loaded 2026-10-16, ETA 2026-10-23T08:00:00Z');
  assert.equal(shiftDatesInText('B/L SRT-INV-0517 / WH-FS-2026-05001 / 2026-13-40', 30), 'B/L SRT-INV-0517 / WH-FS-2026-05001 / 2026-13-40');
  assert.equal(shiftDatesInText('2026-12-30', 3), '2027-01-02');
  assert.equal(shiftDatesInText('2026-10-16', 0), '2026-10-16');
});

test('demo dates: today is pinned by AGENTBL_DEMO_TODAY, is the anchor under tests, else the clock', () => {
  assert.equal(demoToday({ env: { AGENTBL_DEMO_TODAY: '2027-01-05' } }), '2027-01-05');
  assert.equal(demoToday({ env: {} }), DEMO_DATE_ANCHOR, 'node --test sees the data as written');
  assert.equal(demoToday({ env: {}, now: Date.parse('2026-11-01T12:00:00Z') }), '2026-11-01');
  assert.equal(demoToday({ env: { AGENTBL_DEMO_TODAY: 'not-a-date' }, now: Date.parse('2026-11-01T00:00:00Z') }), '2026-11-01');
  assert.equal(shiftDaysFor(DEMO_DATE_ANCHOR, { env: { AGENTBL_DEMO_TODAY: '2026-12-01' } }), 46);
  assert.equal(shiftDaysFor('garbage', { env: { AGENTBL_DEMO_TODAY: '2026-12-01' } }), 0);
});

test('demo dates: a curated case keeps voyage, cover and tenor on any day; fixed facts keep their day', async () => {
  const raw = await readCase('rubber-bkk-qd');
  const later = rebaseCaseDates(raw, { env: { AGENTBL_DEMO_TODAY: '2027-03-01' } });
  assert.equal(later.date_shift_days, 136);
  assert.equal(later.date_anchor, DEMO_DATE_ANCHOR);
  const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
  assert.equal(days(later.bill_of_lading.shipped_on_board, later.bill_of_lading.eta), days(raw.bill_of_lading.shipped_on_board, raw.bill_of_lading.eta));
  assert.equal(days(later.bill_of_lading.eta, later.insurance.expires_at), days(raw.bill_of_lading.eta, raw.insurance.expires_at));
  assert.equal(tenorFromCase(later), tenorFromCase(raw));
  assert.equal(later.market.price_reference_date, raw.market.price_reference_date, 'a reference price keeps the day it was observed');
  assert.equal(later.shipment_events[0].date, '2027-02-23');
  // Today sits inside the voyage on every day.
  assert.ok(later.bill_of_lading.shipped_on_board < '2027-03-01' && '2027-03-01' < later.bill_of_lading.eta);
  // Data without an anchor (uploads, the archived pool #2 case) is untouched.
  const archived = { ...raw, date_anchor: undefined };
  assert.equal(rebaseCaseDates(archived, { env: { AGENTBL_DEMO_TODAY: '2027-03-01' } }), archived);
  assert.equal(rebaseCaseDates(null), null);
});

test('demo dates: documents move with their case', async () => {
  const text = await loadCuratedDocument(new URL('../data/uploads/copper-sg-shanghai/bill-of-lading.md', import.meta.url), { env: { AGENTBL_DEMO_TODAY: '2026-10-26' } });
  assert.match(text, /Shipped on Board \| \*\*2026-10-23\*\*/u);
  assert.match(text, /\| 2026-10-30 \|/u, 'the ETA moved by the same ten days');
  assert.equal(rebaseDocumentText('ETA 2026-10-20', { env: { AGENTBL_DEMO_TODAY: '2026-10-16' } }), 'ETA 2026-10-20');
});

// ---------------------------------------------------------------- plumbing

test('real data: on by default, off under tests unless asked, off when switched off', () => {
  assert.equal(realDataEnabled({}), false, 'node --test');
  assert.equal(realDataEnabled({ REAL_DATA: 'on' }), true);
  assert.equal(realDataEnabled({ REAL_DATA: 'off' }), false);
  assert.equal(realDataEnabled({ REAL_DATA: 'on', NODE_TEST_CONTEXT: 'x' }), true);
});

test('real data: the cache shares one request, keeps values for their window and serves the last good one on failure', async () => {
  let time = 0, calls = 0;
  const cache = new TtlCache({ now: () => time });
  const load = async () => { calls += 1; return calls; };
  const [a, b] = await Promise.all([cache.get('k', 100, load), cache.get('k', 100, load)]);
  assert.equal(a.value, 1); assert.equal(b.value, 1); assert.equal(calls, 1);
  time = 50; assert.equal((await cache.get('k', 100, load)).value, 1);
  time = 200;
  const stale = await cache.get('k', 100, async () => { throw new Error('down'); });
  assert.equal(stale.value, 1); assert.equal(stale.stale, true);
  time = 200 + 25 * 3_600_000;
  await assert.rejects(cache.get('k', 100, async () => { throw new Error('down'); }), /down/u);
  cache.clear();
});

test('real data: HTTP errors and non-JSON bodies are errors', async () => {
  await assert.rejects(fetchJson('https://example.test', { fetchImpl: async () => response('x', false) }), /HTTP 503/u);
  await assert.rejects(fetchJson('https://example.test', { fetchImpl: async () => response('<html>') }), /not JSON/u);
});

// ---------------------------------------------------------------- sources

test('sources: PortWatch transits become a 7-day average against the same week a year earlier', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(decodeURIComponent(String(url)).replaceAll('+', ' '));
    if (urls.length === 1) {
      return response({ features: Array.from({ length: 10 }, (_, i) => ({ attributes: { portname: 'Strait of Hormuz', date: `2026-10-${String(i + 2).padStart(2, '0')}`, n_total: i < 3 ? 60 : 4 } })) });
    }
    return response({ features: Array.from({ length: 7 }, (_, i) => ({ attributes: { portname: 'Strait of Hormuz', date: `2025-10-${String(i + 6).padStart(2, '0')}`, n_total: 80 } })) });
  };
  const out = await fetchChokepointTransits(['Strait of Hormuz', 'Nowhere Strait'], { now: Date.parse('2026-10-16T00:00:00Z'), fetchImpl });
  assert.equal(out['Strait of Hormuz'].latest_date, '2026-10-11');
  assert.equal(out['Strait of Hormuz'].avg7, 4);
  assert.equal(out['Strait of Hormuz'].baseline7, 80);
  assert.equal(out['Strait of Hormuz'].ratio, 0.05);
  assert.equal(out['Nowhere Strait'], undefined);
  assert.match(urls[0], /portname IN \('Strait of Hormuz','Nowhere Strait'\)/u);
  assert.match(urls[1], /date >= '2025-10-06' AND date <= '2025-10-12'/u);
  assert.deepEqual(await fetchChokepointTransits([]), {});
  await assert.rejects(fetchChokepointTransits(['X'], { fetchImpl: async () => response({ error: { message: 'bad query' } }) }), /bad query/u);
});

test('sources: an intermittent PortWatch error body is retried before the snapshot is used', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (calls === 1) return response({ error: { code: 400, message: 'Invalid URL' } });
    const baseline = decodeURIComponent(String(url)).includes('2025-');
    return response({ features: Array.from({ length: 7 }, (_, i) => ({ attributes: { portname: 'Malacca Strait', date: `${baseline ? '2025' : '2026'}-10-${String(i + 10).padStart(2, '0')}`, n_total: 200 } })) });
  };
  const out = await fetchChokepointTransits(['Malacca Strait'], { now: Date.parse('2026-10-27T00:00:00Z'), fetchImpl, retryDelayMs: 0 });
  assert.equal(out['Malacca Strait'].latest_date, '2026-10-16');
  assert.equal(calls, 3, 'one failed attempt, then the recent and baseline windows');
});

test('sources: a timed-out PortWatch request is retried with its own longer timeout', async () => {
  const timeouts = [];
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    timeouts.push(init.signal instanceof AbortSignal);
    const baseline = decodeURIComponent(String(url)).includes('2025-');
    return response({ features: [{ attributes: { portname: 'Dover Strait', date: baseline ? '2025-10-12' : '2026-10-18', n_total: 50 } }] });
  };
  const out = await fetchChokepointTransits(['Dover Strait'], { now: Date.parse('2026-10-27T00:00:00Z'), fetchImpl, retryDelayMs: 0, env: { REAL_DATA_TIMEOUT_MS: '600' } });
  assert.equal(out['Dover Strait'].latest_date, '2026-10-18');
  assert.equal(calls, 3);
  await assert.rejects(fetchChokepointTransits(['X'], { retryDelayMs: 0, fetchImpl: async () => { throw new Error('down'); } }), /down/u);
});

test('live: PortWatch counts stay current through its weekly release lag and go stale after two weeks', async (t) => {
  const caseData = { case_id: 'PW', route_profile: { chokepoints: ['Malacca Strait'] } };
  const fetchImpl = async (url) => {
    const text = decodeURIComponent(String(url));
    if (!text.includes('arcgis')) throw new Error('offline in this test');
    const year = text.includes('2025-') ? '2025' : '2026';
    return response({ features: Array.from({ length: 7 }, (_, i) => ({ attributes: { portname: 'Malacca Strait', date: `${year}-10-${String(i + 12).padStart(2, '0')}`, n_total: 200 } })) });
  };
  for (const [label, now, status] of [['nine days after the newest day', '2026-10-27T00:00:00Z', 'live'], ['fifteen days after', '2026-11-02T00:00:00Z', 'stale']]) {
    await t.test(label, async () => {
      const at = Date.parse(now);
      const risk = await routeRiskEvents(caseData, { env: { REAL_DATA: 'on' }, now: at, cache: new TtlCache({ now: () => at }), fetchImpl, retryDelayMs: 0 });
      assert.equal(risk.evidence.chokepoints[0].latest_date, '2026-10-18');
      assert.equal(risk.evidence.chokepoints[0].status, status);
    });
  }
});

test('sources: Google News RSS items keep title, outlet, time and link', async () => {
  const xml = `<rss><channel><item><title>Ships hit near Hormuz - Reuters</title><link>https://news.example/a</link><pubDate>Wed, 14 Oct 2026 12:49:00 GMT</pubDate><source url="x">Reuters</source></item>
    <item><title><![CDATA[Copper &amp; aluminium rally]]></title><link>https://news.example/b</link><pubDate>Thu, 15 Oct 2026 01:00:00 GMT</pubDate></item><item><title></title></item></channel></rss>`;
  const items = await fetchNewsHeadlines('hormuz', { fetchImpl: async () => response(xml) });
  assert.deepEqual(items.map((item) => item.title), ['Copper & aluminium rally', 'Ships hit near Hormuz']);
  assert.equal(items[1].source, 'Reuters');
  assert.equal(items[1].date, '2026-10-14T12:49:00.000Z');
});

test('sources: Polymarket keeps open YES/NO markets with their YES price', async () => {
  const body = { events: [{ slug: 'hormuz', title: 'Hormuz', markets: [
    { question: 'Hormuz normal by Nov 30?', outcomes: '["Yes","No"]', outcomePrices: '["0.045","0.955"]', endDate: '2026-12-01T04:59:00Z', volume: '836013' },
    { question: 'Closed one', closed: true, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' },
    { question: 'Multi', outcomes: '["A","B"]', outcomePrices: '["0.5","0.5"]' },
    { question: 'Broken', outcomes: 'not json', outcomePrices: [] }
  ] }] };
  const items = await fetchPredictionMarkets('hormuz', { fetchImpl: async () => response(body) });
  assert.deepEqual(items, [{ question: 'Hormuz normal by Nov 30?', implied_prob: 0.045, end_date: '2026-12-01T04:59:00Z', volume_usd: 836013, url: 'https://polymarket.com/event/hormuz', platform: 'Polymarket' }]);
});

test('sources: sea state is the highest forecast wave; futures quotes carry the month move', async () => {
  const sea = await fetchSeaState({ lat: 1, lon: 2 }, { fetchImpl: async () => response({ daily: { time: ['2026-10-16', '2026-10-17'], wave_height_max: [1.2, 4.6] } }) });
  assert.deepEqual(sea, { max_wave_height_m: 4.6, on: '2026-10-17' });
  await assert.rejects(fetchSeaState({ lat: 1, lon: 2 }, { fetchImpl: async () => response({ daily: {} }) }), /no wave heights/u);
  const quote = await fetchFuturesQuote('HG=F', { fetchImpl: async () => response({ chart: { result: [{ meta: { regularMarketPrice: 6.6, currency: 'USD', regularMarketTime: 1_792_116_900 }, indicators: { quote: [{ close: [6.0, null, 6.6] }] } }] } }) });
  assert.equal(quote.price, 6.6); assert.equal(Math.round(quote.change_1m * 100), 10); assert.equal(quote.as_of, '2026-10-16T02:15:00.000Z');
  await assert.rejects(fetchFuturesQuote('XX', { fetchImpl: async () => response({ chart: { error: { description: 'No data found' } } }) }), /No data found/u);
});

// ---------------------------------------------------------------- mapping

test('mapping: transits, waves, odds and price moves map to severities at fixed thresholds', () => {
  assert.deepEqual([0.06, 0.5, 0.83, Number.NaN].map(chokepointSeverity), ['critical', 'warning', null, null]);
  assert.deepEqual([6.5, 4.2, 3.2, undefined].map(waveSeverity), ['critical', 'warning', null, null]);
  assert.deepEqual([0.96, 0.3, 0.1, null].map(disruptionSeverity), ['critical', 'warning', null, null]);
  assert.deepEqual([-0.3, 0.13, -0.08, null].map(volatilitySeverity), ['critical', 'warning', null, null]);
});

test('mapping: the disruption market is the first to resolve after the cargo needs the route', () => {
  const items = [
    { question: 'Hormuz traffic returns to normal by October 31?', implied_prob: 0.005, end_date: '2026-11-01T03:59:00Z' },
    { question: 'Hormuz traffic returns to normal by December 31?', implied_prob: 0.115, end_date: '2027-01-01T04:59:00Z' },
    { question: 'Hormuz traffic returns to normal by November 30?', implied_prob: 0.045, end_date: '2026-12-01T04:59:00Z' },
    { question: 'Will fewer than 20 ships transit?', implied_prob: 0.2, end_date: '2026-10-19T03:59:00Z' }
  ];
  const spec = { match: 'returns to normal by', bad_outcome: 'no' };
  assert.equal(pickDisruptionMarket(items, spec, '2026-11-15').question, 'Hormuz traffic returns to normal by November 30?');
  assert.equal(pickDisruptionMarket(items, spec, '2026-11-15').disruption_prob, 0.955);
  assert.equal(pickDisruptionMarket(items, spec, '2027-06-01').question, 'Hormuz traffic returns to normal by December 31?');
  assert.equal(pickDisruptionMarket(items, { match: 'fewer than 20' }, '2026-10-01').disruption_prob, 0.2);
  assert.equal(pickDisruptionMarket(items, { match: 'nothing' }, '2026-10-01'), null);
});

test('mapping: marking to market moves only the market block, in the cargo\'s own unit', () => {
  const perMt = markToMarket({ market: { reference_price_usd_per_mt: 1, regional_premium_usd_per_mt: 85, landed_price_usd_per_mt: 86, as_of: 'old' }, commercial_invoice: { total_amount_usd: 7 } },
    { price_usd_per_mt: 14532, as_of: '2026-10-16T02:00:00Z', source: 'Yahoo', status: 'live' });
  assert.deepEqual(perMt.market, { reference_price_usd_per_mt: 14532, current_price_usd_per_mt: 14532, regional_premium_usd_per_mt: 85, landed_price_usd_per_mt: 14617, as_of: '2026-10-16', source: 'Yahoo', data_status: 'live' });
  assert.equal(perMt.commercial_invoice.total_amount_usd, 7);
  const concentrate = markToMarket({ market: { benchmark_factor: 0.27, reference_price_usd_per_mt: 1, landed_price_usd_per_mt: 1 } }, { price_usd_per_mt: 14000, status: 'offline' });
  assert.equal(concentrate.market.reference_price_usd_per_mt, 3780);
  const barrels = markToMarket({ market: { price_unit: 'USD/bbl', reference_price_usd_per_bbl: 1, grade_differential_usd_per_bbl: 2.1, landed_price_usd_per_bbl: 1 } }, { price_usd_per_bbl: 105.26, status: 'live' });
  assert.equal(barrels.market.landed_price_usd_per_bbl, 107.36);
  const productPerMt = markToMarket({ market: { bbl_per_mt: 7.45, reference_price_usd_per_mt: 1, regional_premium_usd_per_mt: -45, landed_price_usd_per_mt: 1 } }, { price_usd_per_bbl: 192, status: 'live' });
  assert.equal(productPerMt.market.landed_price_usd_per_mt, 1385.4);
  assert.equal(markToMarket({ market: {} }, { status: 'live' }).market.data_status, undefined, 'a quote without a usable price changes nothing');
  assert.equal(markToMarket({}, null).market, undefined);
});

// ---------------------------------------------------------------- the snapshot and the curated cases

test('snapshot: real values with their own dates, used whenever live data is off', async () => {
  resetRealDataCaches();
  const snapshot = loadSnapshot();
  assert.match(snapshot.captured_at, /^20\d\d-\d\d-\d\dT/u);
  assert.ok(snapshot.chokepoints['Strait of Hormuz'].ratio < 0.35, 'the snapshot records the Hormuz collapse it was taken in');
  const quote = await getMarketQuote('copper', { env: {} });
  assert.equal(quote.status, 'offline'); assert.ok(quote.price_usd_per_mt > 10_000); assert.match(quote.source, /Yahoo Finance/u);
  assert.equal(await getMarketQuote('unobtainium', { env: {} }), null);
  assert.equal((await getNews('no such query', { env: {} })).status, 'unavailable');
  assert.equal((await getPredictionMarkets('no such query', { env: {} })).items.length, 0);
});

test('live: a working source is labelled live; a failing one falls back to the labelled snapshot', async () => {
  // The source observation is fixed, so its clock and retrieval cache must be fixed too.
  const now = Date.parse('2026-10-16T03:00:00Z');
  const options = { env: { REAL_DATA: 'on' }, now, cache: new TtlCache({ now: () => now }) };
  const live = await getMarketQuote('aluminium', { ...options, fetchImpl: async () => response({ chart: { result: [{ meta: { regularMarketPrice: 2800, regularMarketTime: 1_792_116_900 }, indicators: { quote: [{ close: [3000, 2800] }] } }] } }) });
  assert.equal(live.status, 'live'); assert.equal(live.price_usd_per_mt, 2800);
  assert.equal(live.observed_at, '2026-10-16T02:15:00.000Z');
  assert.equal(live.fetched_at, '2026-10-16T03:00:00.000Z');
  options.cache.clear();
  const down = await getMarketQuote('aluminium', { ...options, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(down.status, 'offline'); assert.equal(down.fetched_at, loadSnapshot().captured_at);
});

test('live: a successful fetch cannot renew a quote past its 72-hour observation expiry', async (t) => {
  const expiresAt = '2026-10-19T02:15:00.000Z';
  const fetchImpl = async () => response({ chart: { result: [{ meta: { regularMarketPrice: 2800, regularMarketTime: 1_792_116_900 }, indicators: { quote: [{ close: [3000, 2800] }] } }] } });
  for (const [label, offsetMs, status] of [['before expiry', -1, 'live'], ['at expiry', 0, 'stale'], ['after expiry', 1, 'stale']]) {
    await t.test(label, async () => {
      const now = Date.parse(expiresAt) + offsetMs;
      const quote = await getMarketQuote('aluminium', { env: { REAL_DATA: 'on' }, now, cache: new TtlCache({ now: () => now }), fetchImpl });
      assert.equal(quote.status, status);
      assert.equal(quote.observed_at, '2026-10-16T02:15:00.000Z');
      assert.equal(quote.expires_at, expiresAt);
      assert.equal(quote.fetched_at, new Date(now).toISOString(), 'a fresh retrieval does not extend the source observation');
      assert.equal(quote.price_usd_per_mt, 2800);
    });
  }
});

test('curated cases: the Hormuz-transit cargo pauses on the snapshot; the adjacent one only warns; a clean route stays clean', async () => {
  const transit = await loadCuratedCase(new URL('../data/cases/alu-dxb-rtm.case.json', import.meta.url));
  const adjacent = await loadCuratedCase(new URL('../data/cases/crude-fuj-sin.case.json', import.meta.url));
  const clean = await loadCuratedCase(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url));
  assert.equal(transit.real_data.status, 'offline');
  assert.deepEqual(transit.macro_risk_events.map((e) => [e.type, e.region, e.severity, e.source]), [
    ['chokepoint_disruption', 'Strait of Hormuz', 'critical', 'IMF PortWatch'],
    ['war_risk', 'Strait of Hormuz', 'critical', 'Polymarket']
  ]);
  assert.equal(quoteFromCase(transit).pricing_action, 'PAUSE_OFFERING');
  assert.deepEqual(adjacent.macro_risk_events.map((e) => [e.region, e.severity]), [['Strait of Hormuz (adjacent)', 'warning'], ['Strait of Hormuz (adjacent)', 'warning']]);
  assert.equal(quoteFromCase(adjacent).pricing_action, 'OPEN_WITH_WARNING');
  assert.deepEqual(clean.macro_risk_events, []);
  assert.equal(quoteFromCase(clean).risk_level, 'LOW');
  assert.ok(clean.real_data.chokepoints.some((c) => c.name === 'Taiwan Strait' && c.ratio > 0.7));
  // Enriching twice replaces, never stacks, the real-data events.
  assert.equal((await enrichCaseWithRealData(transit)).macro_risk_events.length, 2);
  // A case without a benchmark or a route profile passes through.
  const plain = { case_id: 'X', market: {} };
  assert.equal(await enrichCaseWithRealData(plain), plain);
});

test('curated cases: invoice totals equal quantity x unit price and every margin funds its financing', async () => {
  for (const name of ['copper-sg-shanghai', 'crude-fuj-sin', 'refined-sg-jkt', 'rubber-bkk-qd', 'ironore-au-tj', 'alu-dxb-rtm', 'cuconc-anf-lyg', 'soybean-ssz-dlc']) {
    const data = await readCase(name);
    const invoice = data.commercial_invoice;
    const quantity = invoice.quantity_bbl ?? invoice.quantity_mt;
    const unit = invoice.unit_price_usd_per_bbl ?? invoice.unit_price_usd_per_mt;
    assert.ok(Math.abs(quantity * unit - invoice.total_amount_usd) < 1, `${name}: ${quantity} x ${unit} != ${invoice.total_amount_usd}`);
    assert.ok(data.trade_economics.gross_margin_pct > 0.02, `${name}: margin ${data.trade_economics.gross_margin_pct}`);
    const quote = quoteFromCase(data);
    assert.equal(quote.binding_constraint, 'TENOR_RATE', `${name} is priced by its tenor, not stuck at a cap`);
    assert.ok(data.insurance.expires_at > data.bill_of_lading.eta, `${name}: cover outlasts the voyage`);
    assert.equal(data.date_anchor, DEMO_DATE_ANCHOR);
  }
});

// ---------------------------------------------------------------- world risk from public sources

test('world risk: public sources replace fixtures; headlines are capped and never double a measured risk', async () => {
  const transit = await loadCuratedCase(new URL('../data/cases/alu-dxb-rtm.case.json', import.meta.url));
  const out = await assessWorldRisk(transit, { env: {} });
  assert.equal(out.provider, 'public-snapshot'); assert.equal(out.live, false); assert.equal(out.data_status, 'offline');
  assert.ok(out.signals.chokepoints.length >= 4);
  assert.ok(out.events.every((event) => event.source !== 'Google News' || event.severity !== 'critical'));
  assert.equal(out.events.filter((event) => event.type === 'war_risk').length, 1, 'a Polymarket reading supersedes war headlines');
  const merged = mergeWorldRiskIntoCase(transit, out.events);
  assert.equal(merged.macro_risk_events.length, transit.macro_risk_events.length, 'route data already on the case counts once');
  const higher = mergeWorldRiskIntoCase({ macro_risk_events: [{ type: 'war_risk', region: 'R', severity: 'info' }] }, [{ type: 'war_risk', region: 'R', severity: 'critical' }]);
  assert.equal(higher.macro_risk_events[0].severity, 'critical');
  const forced = await routeRiskEvents(transit, { env: { REAL_DATA: 'off' } });
  assert.equal(forced.status, 'offline');
});
