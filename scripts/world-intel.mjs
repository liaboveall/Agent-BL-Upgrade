// CLI: run the world-risk agent on a trade case, then re-price with the signals folded in.
// Default case: aluminium Jebel Ali -> Rotterdam, which must transit the Strait of Hormuz.
//
//   npm run intel                                   # free public sources (or their offline snapshot)
//   node scripts/world-intel.mjs data/cases/copper-sg-shanghai.case.json
//   REAL_DATA=off npm run intel                     # offline snapshot only
//
// Without a key the signals come from free public sources (IMF PortWatch, Polymarket, Open-Meteo Marine,
// Yahoo Finance, Google News; see src/realdata). Set XAPI_KEY in .env to use xAPI (Twitter/X + Google News
// + prediction markets) instead: `npx xapi-to register`, then `npx xapi-to oauth bind --provider twitter`.

import fs from 'node:fs';
import { assessWorldRisk } from '../src/agent/worldRiskAgent.js';
import { repriceWithWorldRisk } from '../src/core/worldRiskPricing.js';
import { isXapiConfigured } from '../src/agent/xapi/xapiClient.js';
import { loadCuratedCase } from '../src/core/curatedCases.js';

// --- tiny .env loader (no dependency), same as scripts/agent-valuation.mjs ---
function loadEnv(path = '.env') {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

const caseFile = process.argv[2] ?? 'data/cases/alu-dxb-rtm.case.json';
const caseData = await loadCuratedCase(caseFile);

console.log('\nAgentBL · world-risk intelligence');
console.log('='.repeat(52));
console.log(`Case     : ${caseData.case_id}  (${caseFile})`);
console.log(`Sources  : ${isXapiConfigured() ? 'xAPI (XAPI_KEY set)' : 'free public sources (no key needed)'}`);
console.log(`Data     : ${caseData.real_data?.status ?? 'n/a'}${caseData.real_data?.status === 'offline' ? ` (snapshot captured ${caseData.real_data.snapshot_captured_at})` : ''}`);

const attached = (caseData.macro_risk_events ?? []).filter((event) => event.source_kind === 'real-data');
console.log('');
console.log('Route evidence already on the case (priced)');
for (const event of attached) console.log(`  [${event.severity.toUpperCase().padEnd(8)}] ${event.type.padEnd(22)} ${event.region}  · ${event.source} (${event.data_status})`);
if (attached.length === 0) console.log('  (none)');

const assessment = await assessWorldRisk(caseData);

console.log('');
console.log(`Signals  (provider: ${assessment.provider}, live: ${assessment.live})`);
for (const item of assessment.signals.chokepoints ?? []) {
  console.log(`  ⛴ ${item.name}${item.adjacent ? ' (adjacent)' : ''}: ${item.avg7}/day vs ${item.baseline7} a year earlier (ratio ${item.ratio})`);
}
for (const t of [...assessment.signals.tweets, ...assessment.signals.officials].slice(0, 2)) {
  console.log(`  @${t.author ?? '?'}: ${(t.text ?? '').replace(/\s+/g, ' ').slice(0, 110)}`);
}
for (const n of assessment.signals.news.slice(0, 3)) console.log(`  • ${n.title}  (${n.source ?? 'n/a'})`);
for (const m of assessment.signals.prediction_markets.slice(0, 3)) {
  console.log(`  ⌁ ${Math.round((m.implied_prob ?? 0) * 100)}%  ${m.market}`);
}
for (const s of assessment.signals.sea_state ?? []) console.log(`  ≈ ${s.name}: waves up to ${s.max_wave_height_m} m (${s.on})`);

console.log('');
console.log('Derived macro_risk_events');
for (const e of assessment.events) {
  console.log(`  [${e.severity.toUpperCase().padEnd(8)}] ${e.type.padEnd(22)} ${e.region}   (${e.source ?? 'world-intel'})`);
  for (const ev of (e.evidence ?? [e.description]).slice(0, 1)) console.log(`        ↳ ${ev}`);
}
if (assessment.events.length === 0) console.log('  (none — no elevated signals)');

const { before, after, delta } = repriceWithWorldRisk(caseData, assessment.events);
console.log('');
console.log('Re-pricing with the new signals folded in (route evidence already on the case counts once)');
console.log(`  BEFORE : issue $${before.final_issue_price_usd.toFixed(4)}  · risk ${before.risk_score_bps}bps ${before.risk_level}  · ${before.pricing_action}`);
console.log(`  AFTER  : issue $${after.final_issue_price_usd.toFixed(4)}  · risk ${after.risk_score_bps}bps ${after.risk_level}  · ${after.pricing_action}`);
console.log(`  Δ      : price ${delta.issue_price_usd >= 0 ? '+' : ''}${delta.issue_price_usd.toFixed(4)}  · risk +${delta.risk_score_bps}bps`
  + `${delta.action_changed ? `  · action ${delta.from.pricing_action} → ${delta.to.pricing_action}` : ''}`);

console.log('');
console.log('Summary');
console.log(`  ${assessment.summary}`);
console.log(`\nevidence_hash: ${assessment.evidence_hash}`);
