// A quote belongs to the material it priced (application assessment 2026-10-29, C04): new material under the same case
// ID, mode and preferences is a new revision that is priced again, an answer for the old revision that arrives late
// never stands for the new one, and a failed repricing leaves the old quote shown but not issuable. The real
// controller and store with a synthetic transport, the way the browser calls them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { appStore, caseRevision, quoteCurrent, quoteStaleReason, selectedQuote } from '../web/src/state/app-store.js';
import { openWorkspaceCase, refreshWorkspaceCases, selectCase } from '../web/src/state/controller.js';

globalThis.window ??= new EventTarget();
if (typeof globalThis.sessionStorage === 'undefined') {
  const items = new Map();
  globalThis.sessionStorage = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, String(value)); }, removeItem: (key) => { items.delete(key); } };
}

const CASE = 'SYNTHETIC-PRIVATE-REVISION';
let declared = 1000, quoteCalls = 0, failQuote = false, hold = null;
globalThis.fetch = async (url, options) => {
  const route = String(url);
  let body = {};
  if (route === '/api/agent/workspace/cases') body = { cases: [{ case_id: CASE, mode: 'demo', bill_of_lading: { declared_value_usd: declared, cargo: 'Synthetic copper', bl_id: 'SYNTHETIC-BL' } }] };
  else if (route.includes('/preferences')) body = { preferences: {}, updated_at: null };
  else if (route === '/api/pricing/quote') {
    quoteCalls += 1;
    const value = JSON.parse(options.body).case.bill_of_lading.declared_value_usd;
    if (hold) await hold;
    if (failQuote) return new Response(JSON.stringify({ ok: false, error: 'Synthetic pricing outage' }), { status: 503 });
    body = { recommended_payout_speed: 'BALANCED', quotes: [{ case_id: CASE, payout_speed: 'BALANCED', final_issue_price_usd: 0.9, quote_hash: `0x${value}`,
      requested_cash_usd: value * 0.5, ai_verified_collateral_value_usd: value }] };
  }
  return new Response(JSON.stringify(body), { status: 200 });
};

function reset() {
  declared = 1000; quoteCalls = 0; failQuote = false; hold = null;
  appStore.set({ cases: [], workspaceCases: [], demoMode: true, modeGeneration: 1, marketComparisons: {}, preferencesByCase: {}, busy: false, caseId: null, caseData: null,
    comparison: null, comparisonKey: null, caseLoad: null, evidenceSelected: null, agentLogs: [] });
}

test('C04: a case revision depends on content, not on key order or object identity', () => {
  assert.equal(caseRevision({ a: 1, b: { c: [1, 2] } }), caseRevision({ b: { c: [1, 2] }, a: 1 }));
  assert.notEqual(caseRevision({ bill_of_lading: { declared_value_usd: 1000 } }), caseRevision({ bill_of_lading: { declared_value_usd: 2000 } }));
  assert.equal(caseRevision(null), null);
});

test('C04: reopening a case whose material changed prices the new revision; the old quote is never current for it', async () => {
  reset();
  await openWorkspaceCase(CASE);
  assert.equal(selectedQuote().ai_verified_collateral_value_usd, 1000);
  assert.equal(quoteCurrent(), true);
  assert.equal(quoteCalls, 1);

  declared = 2000;
  await openWorkspaceCase(CASE);
  const state = appStore.get();
  assert.equal(state.caseData.bill_of_lading.declared_value_usd, 2000);
  assert.equal(selectedQuote().ai_verified_collateral_value_usd, 2000, 'the collateral follows the new material');
  assert.equal(state.financingUsd, 1000);
  assert.equal(quoteCalls, 2, 'the cache never answers for a new revision');
  assert.equal(quoteCurrent(), true);
});

test('C04: staying on the case, a refresh that brings new material reprices it; a late answer for the old one is not current', async () => {
  reset();
  await openWorkspaceCase(CASE);
  // The material changes while the page stays on the case; the repricing answer is slow.
  declared = 3000;
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  const following = refreshWorkspaceCases();
  await new Promise((resolve) => setTimeout(resolve, 10));
  let state = appStore.get();
  assert.equal(state.caseData.bill_of_lading.declared_value_usd, 3000);
  assert.equal(quoteCurrent(state), false, 'the quote shown priced the old material');
  assert.equal(quoteStaleReason(state), 'material');
  assert.equal(selectedQuote(state).ai_verified_collateral_value_usd, 1000, 'still visible, for reference only');
  release(); hold = null;
  await following;
  state = appStore.get();
  assert.equal(selectedQuote(state).ai_verified_collateral_value_usd, 3000);
  assert.equal(quoteCurrent(state), true);
});

test('C04: when repricing the new material fails, the old quote stays visible, marked stale, and cannot be issued', async () => {
  reset();
  await openWorkspaceCase(CASE);
  declared = 4000;
  failQuote = true;
  await refreshWorkspaceCases();
  let state = appStore.get();
  assert.equal(state.caseLoad.step, 'quote');
  assert.equal(quoteCurrent(state), false);
  assert.equal(quoteStaleReason(state), 'material');

  // Switching away and back gives the same answer as staying.
  failQuote = false;
  appStore.set({ cases: [{ case_id: 'OTHER-SAMPLE', case: { case_id: 'OTHER-SAMPLE' } }] });
  await selectCase('OTHER-SAMPLE');
  await selectCase(CASE);
  state = appStore.get();
  assert.equal(selectedQuote(state).ai_verified_collateral_value_usd, 4000);
  assert.equal(quoteCurrent(state), true);
});
