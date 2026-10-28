// A preference only takes effect once the server kept it (application review F6): the real controller with a stubbed
// transport, the same way the browser calls it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { appStore } from '../web/src/state/app-store.js';
import { commitMinPrice, commitSpeedPreference, discardPreferenceDraft, retryPreferences, setPreferenceDraft } from '../web/src/state/controller.js';

const CASE = 'PREF-CASE';
function transport(handler) {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const request = { url: String(url), method: options?.method ?? 'GET', body: options?.body ? JSON.parse(options.body) : null };
    requests.push(request);
    const reply = await handler(request);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}
const quoteReply = { body: { quotes: [{ payout_speed: 'BALANCED', final_issue_price_usd: 0.99 }, { payout_speed: 'FAST', final_issue_price_usd: 0.97 }], recommended_payout_speed: 'BALANCED' } };
function reset(extra = {}) {
  appStore.set({ busy: false, caseId: CASE, workspaceCaseId: `WS-0000000000-${CASE}`, cases: [{ case_id: CASE, case: { case_id: CASE } }],
    preferences: { minPrice: '0.75', speed: '' }, preferencesByCase: { [CASE]: { minPrice: '0.75', speed: '' } }, preferencesError: null, preferencesUnsaved: null,
    marketComparisons: {}, comparison: null, agentLogs: [], modeGeneration: 1, ...extra });
}
const logs = () => appStore.get().agentLogs.map((entry) => entry.text).join('\n');

test('a failed save keeps the saved floor in force, marks the form unsaved and asks for no quote', async () => {
  reset();
  const net = transport((request) => request.url.includes('/preferences') ? { status: 503, body: { error: 'Synthetic persistence failure' } } : quoteReply);
  try {
    setPreferenceDraft({ minPrice: '0.99' });
    assert.equal(await commitMinPrice(), false);
    assert.deepEqual(net.requests.map((request) => request.method), ['PUT'], 'no quote is requested on unsaved preferences');
    assert.equal(net.requests[0].url, `/api/agent/cases/WS-0000000000-${CASE}/preferences`, 'the working copy is written, never the sample');
    const state = appStore.get();
    assert.equal(state.preferences.minPrice, '0.99', 'the draft stays visible');
    assert.equal(state.preferencesByCase[CASE].minPrice, '0.75', 'the saved value is still the one in force');
    assert.match(state.preferencesUnsaved, /Synthetic persistence failure/u);
    assert.equal(state.busy, false);
    assert.doesNotMatch(logs(), /0\.99/u, 'nothing claims the constraint changed');
  } finally { net.restore(); }

  // Retrying saves the draft, then reprices with it.
  const ok = transport((request) => request.url.includes('/preferences') ? { body: { ok: true } } : quoteReply);
  try {
    assert.equal(await retryPreferences(), true);
    assert.deepEqual(ok.requests.map((request) => request.method), ['PUT', 'POST']);
    assert.equal(ok.requests[1].body.min_acceptable_issue_price, 0.99);
    assert.equal(appStore.get().preferencesUnsaved, null);
    assert.equal(appStore.get().preferencesByCase[CASE].minPrice, '0.99');
  } finally { ok.restore(); }
});

test('undo puts the form back to the saved values', () => {
  reset({ preferences: { minPrice: '0.99', speed: 'FAST' }, preferencesUnsaved: 'not saved' });
  discardPreferenceDraft();
  assert.deepEqual(appStore.get().preferences, { minPrice: '0.75', speed: '' });
  assert.equal(appStore.get().preferencesUnsaved, null);
});

test('a speed choice is selected only after it was saved', async () => {
  reset({ speed: 'BALANCED', comparison: quoteReply.body });
  const net = transport((request) => request.url.includes('/preferences') ? { status: 401, body: { error: 'A valid admin token is required', code: 'admin_token_required' } } : quoteReply);
  try {
    await commitSpeedPreference('FAST');
    assert.equal(appStore.get().speed, 'BALANCED');
    assert.equal(appStore.get().preferences.speed, 'FAST');
    assert.ok(appStore.get().preferencesUnsaved);
  } finally { net.restore(); }
});

test('a public sample answers with this browser’s copy, and the save lands there', async () => {
  reset({ workspaceCaseId: CASE });
  const copy = `WS-1111111111-${CASE}`;
  const net = transport((request) => request.url.includes(`/cases/${CASE}/preferences`) ? { status: 409, body: { code: 'public_case_read_only', error: 'read-only', details: { workspace_case_id: copy } } }
    : request.url.includes('/preferences') ? { body: { ok: true } } : quoteReply);
  try {
    setPreferenceDraft({ minPrice: '0.8' });
    assert.equal(await commitMinPrice(), true);
    assert.equal(net.requests[1].url, `/api/agent/cases/${copy}/preferences`);
    assert.equal(appStore.get().workspaceCaseId, copy);
  } finally { net.restore(); }
});

test('a reply that arrives after the case changed is ignored', async () => {
  reset();
  let release;
  const net = transport((request) => request.url.includes('/preferences') ? new Promise((resolve) => { release = () => resolve({ status: 503, body: { error: 'late failure' } }); }) : quoteReply);
  try {
    setPreferenceDraft({ minPrice: '0.9' });
    const pending = commitMinPrice();
    await new Promise((resolve) => setImmediate(resolve));
    appStore.set({ caseId: 'ANOTHER-CASE', preferences: { minPrice: '', speed: '' } });
    release();
    assert.equal(await pending, false);
    assert.equal(appStore.get().preferencesUnsaved, null, 'the other case is not marked unsaved');
  } finally { net.restore(); }
});
