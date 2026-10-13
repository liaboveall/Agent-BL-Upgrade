import test from 'node:test';
import assert from 'node:assert/strict';
import { newContext } from '../src/copilot/context.js';
import { poolCandidate, exclusionReasons, bm25, retrieve, tokenize } from '../src/copilot/retrieval.js';
import { rankCandidates, diversify, recommendation } from '../src/copilot/ranking.js';
import { validNarrative, narrate, templateNarrative } from '../src/copilot/narrative.js';
import { pool } from './helpers/copilot.js';

const context = () => newContext({ id: 'x', now: 0, ttlSec: 60, mode: 'demo', generation: 1 });
const candidate = (options) => poolCandidate(pool('P', options), null, 0);

test('Copilot retrieval: every hard constraint excludes the candidate and gives a specific reason', () => {
  const c = candidate();
  const cases = [
    [{ risk_max: 'LOW' }, 'risk_max'], [{ yield_min_bps: 1200 }, 'yield_min_bps'],
    [{ tenor_days_max: 10 }, 'tenor_days_max'], [{ commodities_include: ['soybean'] }, 'commodities_include'],
    [{ commodities_exclude: ['copper'] }, 'commodities_exclude'], [{ regions_include: ['dubai'] }, 'regions_include'],
    [{ regions_exclude: ['singapore'] }, 'regions_exclude'], [{ chokepoints_avoid: ['singapore'] }, 'chokepoints_avoid'],
    [{ ticket_usd: 100001 }, 'ticket_usd'], [{ financing_max_usd: 50000 }, 'financing_max_usd'],
    [{ insurance_coverage_min: 1.2 }, 'insurance_coverage_min'], [{ payout_speed: 'FAST' }, 'payout_speed']
  ];
  for (const [constraints, reason] of cases) assert.ok(exclusionReasons(c, { ...context().constraints, ...constraints }).includes(reason), reason);
  assert.deepEqual(exclusionReasons(c, { ...context().constraints, risk_max: 'MEDIUM', yield_min_bps: 1000, tenor_days_max: 14, ticket_usd: 100000,
    financing_max_usd: 100000, insurance_coverage_min: 1.1, commodities_include: ['copper'], regions_include: ['china'] }), []);
});

test('Copilot retrieval: missing tenor/insurance/risk, closed pools, compliance blocks and Agent holds fail closed', () => {
  const c = candidate();
  for (const [changes, reason] of [[{ tenor_days: null }, 'tenor_days_max'], [{ insurance_coverage: null }, 'insurance_coverage_min'],
    [{ status: 'Repaid' }, 'inactive_pool'], [{ eligible: false }, 'compliance_block'], [{ decision: { action: 'HOLD_FOR_REVIEW' } }, 'agent_hold'],
    [{ quote: { ...c.quote, risk_level: 'unknown' } }, 'unknown_risk']]) {
    assert.ok(exclusionReasons({ ...c, ...changes }, { ...context().constraints, tenor_days_max: 30, insurance_coverage_min: 1 }).includes(reason));
  }
  const missing = candidate({ caseData: {} });
  assert.equal(missing.tenor_days, null);
  assert.equal(missing.insurance_coverage, null);
});

test('Copilot retrieval: BM25 handles Chinese synonyms and MMR diversifies commodities and routes', () => {
  const texts = ['Copper Cathodes Singapore Shanghai', 'Soybean Singapore Shanghai', 'Aluminium Foshan warehouse'];
  assert.ok(bm25('铜', texts)[0] > bm25('铜', texts)[1]);
  assert.ok(tokenize('铜精矿').includes('copper_concentrate'));
  assert.deepEqual(bm25('', []), []);
  const items = [pool('A'), pool('B'), pool('C', { commodity: 'Soybean' })].map((item) => poolCandidate(item, null, 0));
  const ranks = rankCandidates(items, context());
  assert.deepEqual(ranks.map((item) => item.pool_id), ['A', 'B', 'C']);
  assert.deepEqual(diversify(ranks, 2).map((item) => item.pool_id), ['A', 'C']);
  assert.equal(retrieve(items, { ...context(), constraints: { ...context().constraints, commodities_include: ['soybean'] } }, '大豆').included.length, 1);
});

test('Copilot ranking: latest quote/state and data quality change scores with auditable breakdowns', () => {
  const c = candidate();
  const normal = rankCandidates([c], context())[0];
  const paused = rankCandidates([{ ...c, status: 'Paused', stale: true, compliance: 'REVIEW', quote: { ...c.quote, risk_level: 'WARNING' } }], context())[0];
  assert.ok(paused.score < normal.score);
  assert.equal(paused.warnings.length, 4);
  assert.ok(Math.abs(paused.score - Object.values(paused.breakdown).reduce((a, b) => a + b, 0)) < 0.000002);
  const low = context(); low.constraints.risk_max = 'LOW'; low.soft.prefer_short_tenor = true;
  assert.ok(rankCandidates([c], low)[0].weights.risk > normal.weights.risk);
  const rec = recommendation({ ...normal, decision: { decision_id: 'D1', action: 'REPRICE' } }, 1, 'zh');
  assert.equal(rec.quote_hash, c.quote.quote_hash);
  assert.equal(rec.decision_id, 'D1');
  assert.ok(rec.evidence.some((item) => item.kind === 'decision'));
  assert.ok(rec.evidence.filter((item) => item.kind === 'risk_intel').every((item) => item.mode === 'fixture'));
  assert.equal(poolCandidate(pool('S'), null, 3600_001).stale, true);
});

test('Copilot narrative: numbers must be structured facts, never digits borrowed from an identifier', async () => {
  const result = { intent: 'EXPLAIN', context: context(), recommendations: [recommendation(rankCandidates([candidate()], context())[0], 1, 'en')], excluded_notable: [] };
  assert.equal(validNarrative('Price 0.8, gross yield 10%', result), true);
  assert.equal(validNarrative('Guaranteed return 999%', result), false);
  assert.equal(validNarrative('Profit 999', { ...result, context: { session_id: '999' } }), false);
  assert.equal(validNarrative('', result), false);
  assert.equal(validNarrative('<think>thinking</think>', result), false);
  const safe = await narrate(result, 'en', { llmConfigured: true, chatFn: async () => ({ content: 'Price 0.8, gross yield 10%' }) });
  assert.equal(safe.narrative_mode, 'llm');
  for (const chatFn of [async () => ({ content: 'Yield 999%' }), async () => { throw new Error('down'); }]) {
    assert.equal((await narrate(result, 'en', { llmConfigured: true, chatFn })).narrative_mode, 'template');
  }
  for (const intent of ['RESET', 'PORTFOLIO', 'OUT_OF_SCOPE', 'ACTION_SUBSCRIBE']) {
    assert.ok(templateNarrative({ ...result, intent }, 'zh'));
    assert.ok(templateNarrative({ ...result, intent }, 'en'));
  }
  assert.ok(templateNarrative({ ...result, recommendations: [] }, 'en').includes('No active'));
  assert.equal(templateNarrative({ ...result, clarifying_question: 'Which risk?' }, 'en'), 'Which risk?');
});
