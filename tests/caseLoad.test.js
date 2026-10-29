// Loading the selected case on the pricing page (application audit 2026-10-29, B06): a failed step -- the working copy,
// the saved constraints or the first quote -- stays on the page with a retry that resumes at that step, and the upload
// card never waits for a quote. The real controller with a stubbed transport, the way the browser calls it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { appStore, selectedQuote } from '../web/src/state/app-store.js';
import { noteIntakeJobs, retryCaseLoad, selectCase } from '../web/src/state/controller.js';

const SAMPLE = 'LOAD-SAMPLE';
const COPY = `WS-0000000000-${SAMPLE}`;
// The controller announces a case change on `window`; Node has no window, so give it an event target.
globalThis.window ??= new EventTarget();
if (typeof globalThis.sessionStorage === 'undefined') {
  const items = new Map();
  globalThis.sessionStorage = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, String(value)); }, removeItem: (key) => { items.delete(key); } };
}

let failing = new Set();
const requests = [];
globalThis.fetch = async (url) => {
  const path = String(url);
  requests.push(path);
  const part = path.includes('/workspace/copies/') ? 'workspace' : path.includes('/preferences') ? 'preferences' : path.includes('/api/pricing/') ? 'quote' : 'other';
  if (failing.has(part)) return new Response(JSON.stringify({ ok: false, error: `Synthetic ${part} outage` }), { status: 503 });
  const body = part === 'workspace' ? { ok: true, case_id: COPY, source_case_id: SAMPLE }
    : part === 'preferences' ? { ok: true, preferences: { min_acceptable_issue_price: 0.8 }, updated_at: '2026-10-29T00:00:00.000Z' }
      : part === 'quote' ? { quotes: [{ case_id: SAMPLE, payout_speed: 'BALANCED', final_issue_price_usd: 0.99, requested_cash_usd: 1000 }], recommended_payout_speed: 'BALANCED' } : {};
  return new Response(JSON.stringify(body), { status: 200 });
};

function reset() {
  failing = new Set();
  requests.length = 0;
  appStore.set({ busy: false, caseId: null, cases: [{ case_id: SAMPLE, case: { case_id: SAMPLE } }], workspaceCases: [], marketComparisons: {}, comparison: null,
    preferencesByCase: {}, caseLoad: null, intakeHeld: 0, modeGeneration: 1, agentLogs: [], evidenceSelected: null });
}

test('a first quote that fails stays on the page with its reason; the upload target is known and a retry resumes at the quote', async () => {
  reset();
  failing = new Set(['quote']);
  await selectCase(SAMPLE);
  let state = appStore.get();
  assert.deepEqual(state.caseLoad, { step: 'quote', message: 'Synthetic quote outage' });
  assert.equal(state.workspaceCaseId, COPY, 'uploads and jobs do not wait for the quote');
  assert.equal(state.preferencesByCase[SAMPLE].minPrice, '0.8');
  assert.equal(selectedQuote(state), null);
  assert.equal(state.busy, false);

  failing = new Set();
  requests.length = 0;
  await retryCaseLoad();
  state = appStore.get();
  assert.equal(state.caseLoad, null);
  assert.equal(selectedQuote(state).final_issue_price_usd, 0.99);
  assert.ok(requests.every((path) => path.includes('/api/pricing/')), 'the copy and the constraints are not asked for again');
});

test('a working copy or saved constraints that cannot be read stop there, and a retry continues from that step', async () => {
  reset();
  failing = new Set(['workspace']);
  await selectCase(SAMPLE);
  let state = appStore.get();
  assert.equal(state.caseLoad.step, 'workspace');
  assert.equal(state.workspaceCaseId, null, 'the public sample is never used as this browser’s copy');
  assert.ok(!requests.some((path) => path.includes('/preferences') || path.includes('/api/pricing/')));

  failing = new Set(['preferences']);
  await retryCaseLoad();
  state = appStore.get();
  assert.equal(state.caseLoad.step, 'preferences');
  assert.match(state.caseLoad.message, /Synthetic preferences outage/u);
  assert.equal(state.workspaceCaseId, COPY);
  assert.ok(state.preferencesError);

  failing = new Set();
  await retryCaseLoad();
  state = appStore.get();
  assert.equal(state.caseLoad, null);
  assert.equal(state.preferencesError, null);
  assert.ok(selectedQuote(state));
});

test('the held-review count is the server’s count for the selected case, not the length of a page', () => {
  reset();
  appStore.set({ workspaceCaseId: COPY });
  noteIntakeJobs(COPY, 9);
  assert.equal(appStore.get().intakeHeld, 9);
  noteIntakeJobs('ANOTHER-CASE', 2);
  assert.equal(appStore.get().intakeHeld, 9, 'a reply about a case no longer selected is ignored');
  noteIntakeJobs(COPY, undefined);
  assert.equal(appStore.get().intakeHeld, 0);
});
