// The market's category chips and keyword search are pure functions of the case catalog. Keep every
// shipped case in exactly one category and keep multi-word searches working across the case data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CATEGORIES, caseCategory, caseSearchFields, categoryOptions, matchesSearch, searchTerms, visibleCases } from '../web/src/lib/market.js';

const casesDir = path.join(import.meta.dirname, '..', 'data', 'cases');
// Entries shaped like /api/cases returns them: { case_id, cargo, case }.
const entries = fs.readdirSync(casesDir).filter((name) => name.endsWith('.case.json')).sort().map((name) => {
  const data = JSON.parse(fs.readFileSync(path.join(casesDir, name), 'utf8'));
  return { case_id: data.case_id, cargo: data.bill_of_lading?.cargo ?? null, case: data };
});
const byId = (id) => entries.find((entry) => entry.case_id === id);
const found = (query) => entries.filter((entry) => matchesSearch(caseSearchFields(entry), query)).map((e) => e.case_id);
const baseState = { cases: entries, searchQuery: '', aiMatchedIds: null, aiRanks: null, categoryFilter: 'all' };

test('every shipped case falls into exactly one known category', () => {
  const counts = {};
  for (const entry of entries) {
    const category = caseCategory(entry);
    assert.ok(CATEGORIES.includes(category), `${entry.case_id} -> ${category}`);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  assert.equal(entries.length, 11);
  assert.deepEqual(counts, { metal: 5, energy: 2, ore: 2, agriculture: 2 });
});

test('ores and concentrates are not metals; rubber and soy are agriculture; gasoil is energy', () => {
  assert.equal(caseCategory(byId('CASE-EBL-IRONORE-PHE-TSN')), 'ore');
  assert.equal(caseCategory(byId('CASE-EBL-CUCONC-ANF-LYG')), 'ore');
  assert.equal(caseCategory(byId('CASE-EBL-RUBBER-LCB-TAO')), 'agriculture');
  assert.equal(caseCategory(byId('CASE-EBL-SOY-SSZ-DLC')), 'agriculture');
  assert.equal(caseCategory(byId('CASE-EBL-GASOIL-SIN-JKT')), 'energy');
});

test('aluminium ingots with a Chinese cargo line are metals, unknown cargo is other', () => {
  const ingot = byId('CASE-EBL-2026-ALU-FS-WH-00013');
  assert.match(ingot.cargo, /铝锭/u);
  assert.equal(caseCategory(ingot), 'metal');
  assert.equal(caseCategory({ case_id: 'CASE-X', cargo: 'Industrial widgets', case: {} }), 'other');
});

test('search needs every term, ignores case and punctuation, and reaches commodity and ports', () => {
  assert.deepEqual(searchTerms('  Copper, Shanghai  '), ['copper', 'shanghai']);
  assert.equal(found('').length, entries.length);
  assert.deepEqual(found('alumin').sort(), [
    'CASE-EBL-2026-ALU-FS-WH-00013', 'CASE-EBL-2026-ALU-FS-WH-00014', 'CASE-EBL-2026-ALU-FS-WH-00015', 'CASE-EBL-ALU-JEA-RTM'
  ]);
  assert.deepEqual(found('iron pilbara'), ['CASE-EBL-IRONORE-PHE-TSN']);
  assert.deepEqual(found('copper concentrate'), ['CASE-EBL-CUCONC-ANF-LYG']);
  assert.deepEqual(found('no-such-cargo'), []);
});

test('category chips carry match counts and follow the search', () => {
  const all = categoryOptions(baseState);
  assert.deepEqual(all.map((o) => o.name), ['all', 'metal', 'energy', 'ore', 'agriculture']);
  assert.deepEqual(all.map((o) => o.count), [11, 5, 2, 2, 2]);
  const searched = categoryOptions({ ...baseState, searchQuery: 'copper' });
  assert.deepEqual(Object.fromEntries(searched.map((o) => [o.name, o.count])), { all: 2, metal: 1, energy: 0, ore: 1, agriculture: 0 });
  assert.deepEqual(visibleCases({ ...baseState, searchQuery: 'copper', categoryFilter: 'ore' }).map((c) => c.case_id), ['CASE-EBL-CUCONC-ANF-LYG']);
});
