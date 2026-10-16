import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { evaluateRetrieval, getRiskCorpus, retrieveByQuery, retrieveRiskIntel } from '../src/agent/riskIntel.js';

const copperCase = JSON.parse(
  await fs.readFile(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url), 'utf8')
);

test('AI-11: corpus loads from the risk-intel feed', () => {
  const corpus = getRiskCorpus();
  assert.ok(corpus.length >= 8);
  assert.ok(corpus.every((d) => d.id && d.type && d.text));
});

test('AI-11: copper case retrieves the Hormuz war + copper volatility intel', () => {
  // The events a Hormuz-exposed copper cargo gets from src/realdata at load time.
  const exposed = { ...copperCase, macro_risk_events: [
    { type: 'war_risk', region: 'Middle East / Strait of Hormuz', severity: 'critical' },
    { type: 'commodity_volatility', region: 'Global', severity: 'warning' }
  ] };
  const matches = retrieveRiskIntel(exposed, { k: 3 });
  const ids = matches.map((m) => m.id);
  assert.ok(ids.includes('MRI-HORMUZ-CLOSURE-2026-10'));
  assert.ok(ids.includes('MRI-COPPER-2026-10'));
  // scores are sorted descending and carry a source for citation
  assert.ok(matches[0].score >= matches[matches.length - 1].score);
  assert.ok(matches.every((m) => m.source));
});

test('AI-11: retrieval eval keeps precision@k high (>= 0.8 mean)', () => {
  const evalResult = evaluateRetrieval();
  assert.ok(evalResult.mean_precision >= 0.8, `mean precision ${evalResult.mean_precision}`);
  for (const c of evalResult.cases) {
    assert.ok(c.precision >= 0.66, `${c.name} precision ${c.precision}`);
  }
});

test('AI-11: free-text query surfaces policy notes for the Q&A assistant', () => {
  const matches = retrieveByQuery('is the target redemption guaranteed?');
  assert.ok(matches.some((m) => m.id === 'POL-TARGET-REDEMPTION-NOT-GUARANTEED'));
});

test('AI-11: a custom corpus can be supplied (no hidden global state)', () => {
  const corpus = [
    { id: 'X', type: 'war_risk', region: 'Test', commodity: 'copper', severity: 'critical', tags: ['copper'], text: 'copper war' }
  ];
  const matches = retrieveRiskIntel({ cargo: { commodity: 'Copper' }, macro_risk_events: [{ type: 'war_risk', region: 'Test' }] }, { corpus });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 'X');
});

test('case retrieval only cites intel that shares the commodity, a region or a global risk type', async () => {
  const read = async (name) => JSON.parse(await fs.readFile(new URL(`../data/cases/${name}.case.json`, import.meta.url), 'utf8'));
  // Jakarta fuel, Bangkok rubber and Pilbara ore share nothing with the copper/crude/Shanghai/Hormuz corpus.
  for (const name of ['refined-sg-jkt', 'rubber-bkk-qd', 'ironore-au-tj']) {
    assert.deepEqual(retrieveRiskIntel(await read(name)), [], name);
  }
  const copper = retrieveRiskIntel(await read('copper-sg-shanghai')).map((doc) => doc.id);
  assert.ok(copper.includes('MRI-COPPER-2026-10'));
  assert.ok(copper.includes('MRI-PORT-CONGESTION-SHA-2026'), 'the discharge port counts as a case region');
  assert.ok(!copper.includes('MRI-ASIA-FX-2026-10'), 'a crude-specific item never reaches a copper cargo');
});
