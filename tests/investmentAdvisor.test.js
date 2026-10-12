import assert from 'node:assert/strict';
import test from 'node:test';
import { recommend } from '../src/agent/investmentAdvisor.js';

const mockCases = [
  { id: '1', caseEntry: { cargo: 'Copper' }, riskLevel: 'LOW', yieldBps: 400, riskBps: 100, score: 4.0, financingUsd: 1000000 },
  { id: '2', caseEntry: { cargo: 'Soybeans' }, riskLevel: 'MEDIUM', yieldBps: 800, riskBps: 300, score: 2.6, financingUsd: 500000 },
  { id: '3', caseEntry: { cargo: 'Copper' }, riskLevel: 'HIGH', yieldBps: 1200, riskBps: 600, score: 2.0, financingUsd: 2000000 },
  { id: '4', caseEntry: { cargo: 'Iron Ore' }, riskLevel: 'LOW', yieldBps: 350, riskBps: 80, score: 4.3, financingUsd: 800000 }
];

test('AI-19: deterministic fallback filters by low risk', async () => {
  // Pass an environment without LLM keys to force deterministic fallback
  const oldEnv = process.env;
  process.env = {}; 

  const res = await recommend('I want safe low risk investments', mockCases);
  
  assert.ok(res.recommendations.length > 0);
  assert.ok(res.recommendations.every(r => r.riskLevel === 'LOW'));
  assert.equal(res.criteria.risk_max, 'LOW');
  assert.equal(res.criteria.sort_by, 'risk_asc');
  
  process.env = oldEnv;
});

test('AI-19: deterministic fallback sorts by high yield', async () => {
  const oldEnv = process.env;
  process.env = {}; 
  const res = await recommend('Give me high yield', mockCases);
  
  assert.ok(res.recommendations.length > 0);
  assert.equal(res.recommendations[0].id, '3'); // 1200 bps
  assert.equal(res.criteria.sort_by, 'yield_desc');
  process.env = oldEnv;
});

test('AI-19: deterministic fallback filters by commodity', async () => {
  const oldEnv = process.env;
  process.env = {}; 
  const res = await recommend('I want copper', mockCases);
  
  assert.ok(res.recommendations.length > 0);
  assert.ok(res.recommendations.every(r => r.caseEntry.cargo.toLowerCase() === 'copper'));
  process.env = oldEnv;
});

// ---- WP0.2: risk vocabulary and LLM output validation ----
import { parseLlmCriteria, poolToAdvisorCase } from '../src/agent/investmentAdvisor.js';
import { handleRequest } from '../src/app/server.js';
import { resetStore, storeState } from '../src/app/store.js';
import { normalizeRiskLevel, riskLevelRank } from '../src/core/schema.js';
import { listenOnUsablePort } from '../scripts/lib/listen.mjs';
import http from 'node:http';

const llm = (payload) => ({ llmConfigured: true, chatFn: async () => ({ content: typeof payload === 'string' ? payload : JSON.stringify(payload) }) });

test('WP0.2: normalizeRiskLevel maps HIGH to WARNING and rejects unknown values', () => {
  assert.equal(normalizeRiskLevel('high'), 'WARNING');
  assert.equal(normalizeRiskLevel(' Warning '), 'WARNING');
  assert.equal(normalizeRiskLevel('CRITICAL'), 'CRITICAL');
  assert.equal(normalizeRiskLevel('EXTREME'), null);
  assert.equal(normalizeRiskLevel(2), null);
  assert.deepEqual(['LOW', 'MEDIUM', 'WARNING', 'CRITICAL'].map(riskLevelRank), [0, 1, 2, 3]);
  assert.equal(riskLevelRank('nope'), -1);
});

test('WP0.2: risk_max keeps WARNING cases when the ceiling is WARNING or CRITICAL', async () => {
  const cases = [
    { id: 'a', caseEntry: { cargo: 'x' }, riskLevel: 'LOW', yieldBps: 1, riskBps: 1, score: 1, financingUsd: 1 },
    { id: 'b', caseEntry: { cargo: 'x' }, riskLevel: 'WARNING', yieldBps: 1, riskBps: 1, score: 1, financingUsd: 1 },
    { id: 'c', caseEntry: { cargo: 'x' }, riskLevel: 'CRITICAL', yieldBps: 1, riskBps: 1, score: 1, financingUsd: 1 }
  ];
  const critical = await recommend('anything', cases, llm({ risk_max: 'CRITICAL' }));
  assert.deepEqual(critical.recommendations.map((r) => r.id).sort(), ['a', 'b', 'c']);
  // An LLM that still says HIGH means the engine's WARNING.
  const high = await recommend('anything', cases, llm({ risk_max: 'HIGH' }));
  assert.deepEqual(high.recommendations.map((r) => r.id).sort(), ['a', 'b']);
  assert.equal(high.criteria.risk_max, 'WARNING');
});

test('WP0.2: risk_max=CRITICAL keeps every market pool, including the WARNING ones', async () => {
  resetStore();
  const server = http.createServer(handleRequest);
  const port = await listenOnUsablePort(server);
  try {
    // The first market request materialises one pool per catalogue case.
    await fetch(`http://127.0.0.1:${port}/api/market/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preference: 'x' })
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const pools = [...storeState.pools.values()].filter((pool) => ['Open', 'Repriced'].includes(pool.status));
  const cases = pools.map(poolToAdvisorCase);
  assert.ok(cases.length >= 20, `expected the full catalogue, got ${cases.length}`);
  assert.ok(cases.some((c) => c.riskLevel === 'WARNING'), 'the catalogue contains WARNING pools');

  // `matched` is the number of cases that survive the filters (recommendations is only the top 3).
  const everything = await recommend('any risk', cases, llm({ risk_max: 'CRITICAL' }));
  assert.equal(everything.criteria.risk_max, 'CRITICAL');
  assert.equal(everything.matched, cases.length, 'a CRITICAL ceiling must not drop any pool');

  const warningCeiling = await recommend('up to warning', cases, llm({ risk_max: 'WARNING' }));
  assert.equal(warningCeiling.matched, cases.filter((c) => c.riskLevel !== 'CRITICAL').length);

  const lowOnly = await recommend('low', cases, llm({ risk_max: 'LOW' }));
  assert.equal(lowOnly.matched, cases.filter((c) => c.riskLevel === 'LOW').length);
  assert.ok(lowOnly.recommendations.every((r) => r.riskLevel === 'LOW'));
  resetStore();
});

test('WP0.2: LLM criteria are validated; unknown keys are dropped and invalid values fall back', async () => {
  assert.deepEqual(parseLlmCriteria({ risk_max: 'high', yield_min: 500, evil: 'x', __proto__: { a: 1 } }), { risk_max: 'WARNING', yield_min: 500 });
  assert.equal(parseLlmCriteria({ risk_max: 'EXTREME' }), null);
  assert.equal(parseLlmCriteria({ yield_min: -5 }), null);
  assert.equal(parseLlmCriteria({ yield_min: 1.5 }), null);
  assert.equal(parseLlmCriteria({ sort_by: 'DROP TABLE' }), null);
  assert.equal(parseLlmCriteria({ commodity: 'x'.repeat(500) }), null);
  assert.equal(parseLlmCriteria('not an object'), null);

  // A malformed answer must not leak into the criteria: it falls back to the deterministic parser.
  const res = await recommend('I want safe low risk investments', mockCases, llm({ risk_max: 'EXTREME', sort_by: 'DROP' }));
  assert.equal(res.criteria.risk_max, 'LOW');
  assert.equal(res.criteria.sort_by, 'risk_asc');
  assert.ok(!('evil' in res.criteria));

  const junk = await recommend('I want copper', mockCases, llm('this is not json'));
  assert.equal(junk.criteria.commodity, 'copper');
});
