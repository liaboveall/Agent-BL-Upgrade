// A preference only takes effect once the server kept it (application review F6), it is saved with this tab's admin
// token in Live (audit A09), and a quote priced before it can be shown but not issued (audit A07): the real controller
// with a stubbed transport, the same way the browser calls it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { appStore, quoteCurrent } from '../web/src/state/app-store.js';
import { commitMinPrice, commitSpeedPreference, discardPreferenceDraft, mint, requote, retryPreferences, setPreferenceDraft } from '../web/src/state/controller.js';
import { answerDialog, dialogStore } from '../web/src/lib/dialogs.js';

const CASE = 'PREF-CASE';
function transport(handler) {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const request = { url: String(url), method: options?.method ?? 'GET', body: options?.body ? JSON.parse(options.body) : null, authorization: options?.headers?.Authorization ?? null };
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
async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(predicate(), 'the condition was reached');
}
const TOKEN_KEY = 'agentbl.adminToken';

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

test('a speed choice is selected only after it was saved; a cancelled admin token prompt saves nothing', async () => {
  reset({ speed: 'BALANCED', comparison: quoteReply.body });
  const net = transport((request) => request.url.includes('/preferences') ? { status: 401, body: { error: 'A valid admin token is required', code: 'admin_token_required' } } : quoteReply);
  try {
    const pending = commitSpeedPreference('FAST');
    await until(() => dialogStore.get().request);
    answerDialog(null);
    await pending;
    assert.equal(net.requests.filter((request) => request.method === 'PUT').length, 1, 'cancelling sends nothing more');
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

test('Live: the tab’s admin token goes with the save, and a rejected one is asked for again and remembered (A09)', async () => {
  reset();
  sessionStorage.setItem(TOKEN_KEY, 'fictional-stale-token');
  const net = transport((request) => !request.url.includes('/preferences') ? quoteReply
    : request.authorization === 'Bearer fictional-operator-token' ? { body: { ok: true } } : { status: 401, body: { code: 'admin_token_required', error: 'A valid admin token is required' } });
  try {
    setPreferenceDraft({ minPrice: '0.8' });
    const pending = commitMinPrice();
    await until(() => dialogStore.get().request);
    answerDialog('fictional-operator-token');
    assert.equal(await pending, true);
    assert.deepEqual(net.requests.filter((request) => request.method === 'PUT').map((request) => request.authorization),
      ['Bearer fictional-stale-token', 'Bearer fictional-operator-token']);
    assert.equal(sessionStorage.getItem(TOKEN_KEY), 'fictional-operator-token');
    setPreferenceDraft({ minPrice: '0.81' });
    assert.equal(await commitMinPrice(), true, 'the remembered token saves without another prompt');
    assert.equal(net.requests.filter((request) => request.method === 'PUT').at(-1).authorization, 'Bearer fictional-operator-token');
  } finally { net.restore(); sessionStorage.removeItem(TOKEN_KEY); answerDialog(null); }
});

test('saved constraints with a failed reprice leave the old quote for reference only: it cannot be issued (A07)', async () => {
  const quote = (price) => ({ body: { quotes: [{ case_id: CASE, payout_speed: 'BALANCED', final_issue_price_usd: price, pricing_action: 'OPEN', quote_hash: `0x${price}` }], recommended_payout_speed: 'BALANCED' } });
  reset({ demoMode: true, speed: 'BALANCED', financingUsd: 1000, mint: null });
  let quoteFails = false;
  const net = transport((request) => request.url.includes('/preferences') ? { body: { ok: true } }
    : quoteFails ? { status: 503, body: { error: 'Synthetic pricing outage' } } : quote(0.9927));
  try {
    assert.equal(await requote(), true);
    assert.equal(quoteCurrent(), true, 'a quote of the saved constraints is current');
    quoteFails = true;
    setPreferenceDraft({ minPrice: '0.999' });
    assert.equal(await commitMinPrice(), true, 'the constraint itself was saved');
    const state = appStore.get();
    assert.equal(state.preferencesByCase[CASE].minPrice, '0.999');
    assert.equal(state.comparison.quotes[0].final_issue_price_usd, 0.9927, 'the old quote stays visible');
    assert.equal(quoteCurrent(state), false, 'but it no longer prices the saved constraints');
    assert.match(state.quoteError, /Synthetic pricing outage/u);
    assert.equal(state.busy, false);
    await mint();
    assert.equal(appStore.get().mint, null, 'nothing is issued from the old quote');
    quoteFails = false;
    assert.equal(await requote(), true);
    assert.equal(quoteCurrent(), true);
    assert.equal(appStore.get().quoteError, null);
    assert.equal(net.requests.at(-1).body.min_acceptable_issue_price, 0.999, 'the new quote prices the saved floor');
  } finally { net.restore(); }
});
