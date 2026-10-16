// Capture the offline snapshot of the free public data sources (data/real-data/snapshot.json).
//
//   npm run realdata:snapshot            fetch everything the curated cases need and write the file
//   npm run realdata:snapshot -- --check only report what would be fetched
//
// The snapshot is what the server shows, clearly labelled "offline", when REAL_DATA=off, under tests,
// or when a source is unreachable. It holds real values with their real dates; nothing is invented.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCHMARKS } from '../src/realdata/index.js';
import { fetchChokepointTransits, fetchFuturesQuote, fetchNewsHeadlines, fetchPredictionMarkets, fetchSeaState } from '../src/realdata/sources.js';
import { buildQueryProfile } from '../src/agent/worldRiskAgent.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'data/real-data/snapshot.json');
const env = { ...process.env, REAL_DATA: 'on', REAL_DATA_TIMEOUT_MS: process.env.REAL_DATA_TIMEOUT_MS ?? '15000' };
const options = { env };

async function curatedCases() {
  const files = [path.join(root, 'data/demo-case.json')];
  for (const name of (await fs.readdir(path.join(root, 'data/cases'))).sort()) {
    if (name.endsWith('.case.json')) files.push(path.join(root, 'data/cases', name));
  }
  return Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(file, 'utf8'))));
}

const cases = await curatedCases();
const chokepoints = new Set();
const waypoints = new Map();
const marketQueries = new Set();
const newsQueries = new Set();
const benchmarks = new Set();
for (const item of cases) {
  const profile = item.route_profile ?? {};
  for (const name of [...(profile.chokepoints ?? []), ...(profile.nearby_chokepoints ?? [])]) chokepoints.add(name);
  for (const point of profile.waypoints ?? []) waypoints.set(`${point.lat},${point.lon}`, point);
  for (const spec of profile.disruption_markets ?? []) marketQueries.add(spec.query);
  if (item.market?.benchmark_key) benchmarks.add(item.market.benchmark_key);
  if (item.route_profile) for (const query of buildQueryProfile(item).newsQueries) newsQueries.add(query);
}

console.log(`chokepoints ${chokepoints.size}, waypoints ${waypoints.size}, markets ${marketQueries.size}, news ${newsQueries.size}, benchmarks ${benchmarks.size}`);
if (process.argv.includes('--check')) process.exit(0);

const failures = [];
async function attempt(label, task) {
  try {
    return await task();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    return null;
  }
}

const snapshot = {
  captured_at: new Date().toISOString(),
  note: 'Offline snapshot of free public sources (IMF PortWatch, Polymarket, Open-Meteo Marine, Yahoo Finance, Google News headlines). Real values with their own dates, captured by `npm run realdata:snapshot`; shown as offline data whenever live fetching is off or fails.',
  prices: {},
  chokepoints: await attempt('portwatch', () => fetchChokepointTransits([...chokepoints], options)) ?? {},
  sea_state: {},
  prediction_markets: {},
  news: {}
};
for (const key of benchmarks) {
  const quote = await attempt(`price ${key}`, () => fetchFuturesQuote(BENCHMARKS[key].symbol, options));
  if (quote) snapshot.prices[key] = quote;
}
for (const [id, point] of waypoints) {
  const sea = await attempt(`sea ${point.name}`, () => fetchSeaState(point, options));
  if (sea) snapshot.sea_state[id] = sea;
}
for (const query of marketQueries) {
  const markets = await attempt(`polymarket ${query}`, () => fetchPredictionMarkets(query, options));
  if (markets) snapshot.prediction_markets[query] = markets;
}
for (const query of newsQueries) {
  const news = await attempt(`news ${query}`, () => fetchNewsHeadlines(query, options));
  if (news) snapshot.news[query] = news;
}

await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);

// The xAPI tools fall back to data/world-intel/feed.json when xAPI fails; keep it the same real snapshot
// (headlines and market odds only: no invented posts or accounts).
const seen = new Set();
const feedNews = [];
for (const [query, items] of Object.entries(snapshot.news)) {
  for (const item of items) {
    if (seen.has(item.title)) continue;
    seen.add(item.title);
    feedNews.push({ title: item.title, source: item.source, date: item.date, link: item.url, snippet: '', tags: query.toLowerCase().match(/[a-z]{4,}/gu) ?? [] });
  }
}
const feedMarkets = Object.values(snapshot.prediction_markets).flat()
  .filter((item) => /returns to normal by/iu.test(item.question))
  .map((item) => ({
    market: `NOT: ${item.question}`,
    platform: 'Polymarket (snapshot)',
    question: `Derived as 1 - YES of "${item.question}"`,
    implied_prob: Math.round((1 - item.implied_prob) * 10000) / 10000,
    volume_usd: item.volume_usd,
    resolution_date: item.end_date,
    link: item.url,
    tags: ['hormuz', 'closure', 'strait']
  }));
const feedFile = path.join(root, 'data/world-intel/feed.json');
await fs.writeFile(feedFile, `${JSON.stringify({
  feed_version: snapshot.captured_at.slice(0, 10),
  note: `OFFLINE SNAPSHOT for the optional xAPI world-risk tools (src/agent/tools/worldRiskTools.js), used only when an XAPI_KEY is set but a call fails. Real Google News headlines and Polymarket odds captured ${snapshot.captured_at} by npm run realdata:snapshot; no posts or accounts are invented, so the tweet sections are empty.`,
  tweets: [],
  official_tweets: {},
  news: feedNews,
  prediction_markets: feedMarkets
}, null, 2)}\n`);
console.log(`wrote ${path.relative(root, out)}: ${Object.keys(snapshot.prices).length} prices, ${Object.keys(snapshot.chokepoints).length} chokepoints, ${Object.keys(snapshot.sea_state).length} sea points, ${Object.keys(snapshot.prediction_markets).length} market queries, ${Object.keys(snapshot.news).length} news queries`);
if (failures.length) {
  console.log(`not captured (${failures.length}):\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
}
