// The dashboard controller: loading the catalog and quotes, selecting a case, the runtime mode,
// subscriptions, minting, the wallet, the Copilot search and the agent activity stream. Components
// call these functions and read the results from appStore; nothing here touches the DOM.
//
// Every async path checks that the case, the runtime generation and the wallet it started with are
// still current before it writes, so a slow reply never overwrites a newer selection.

import { appStore, selectedQuote, findCase, quoteKey, quoteCurrent, caseRevision } from './app-store.js';
import * as api from '../lib/api.js';
import * as web3 from '../lib/web3.js';
import * as f from '../lib/format.js';
import { agent } from '../lib/agent-api.js';
import { t } from '../lib/i18n.js';
import { toast } from '../lib/toast.js';
import { askText } from '../lib/dialogs.js';
import { copilotQuery, resetCopilotSession } from '../lib/copilot-api.js';
import { defaultMarketSubscription, marketView, PAUSED_ACTIONS, visibleCases } from '../lib/market.js';
import { scrollBehavior } from '../lib/accessibility.js';
import { agentStore } from '../pages/agent/agent-store.js';
import { actionLabel } from '../lib/agent-format.js';

const get = () => appStore.get();
const set = (patch) => appStore.set(patch);
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

const versions = { evidence: 0, selection: 0, caseVersion: 0, search: 0, preference: 0 };
// Decision verbs worth a toast when the agent emits them.
const NOTIFY_DECISION_ACTIONS = new Set(['REPRICE', 'PAUSE', 'RESUME', 'FREEZE', 'LIQUIDATE', 'SETTLE']);
const DEMO_WALLET = '0xDemoWallet';
const walletAddress = () => get().wallet?.address || DEMO_WALLET;

// ---------------------------------------------------------------------------------------------
// Agent decisions linked to cases (the five evidence surfaces)
// ---------------------------------------------------------------------------------------------

export function evidenceFor(state, caseId) {
  return state.evidenceSelected?.case_id === caseId ? state.evidenceSelected : state.evidenceLatest.get(caseId);
}

export async function refreshEvidence() {
  const version = ++versions.evidence, generation = get().modeGeneration;
  try {
    const data = await agent.references();
    if (version !== versions.evidence || generation !== get().modeGeneration || data.generation !== generation) return;
    set({
      evidenceLatest: new Map(data.decisions.map((decision) => [decision.case_id, decision])),
      evidencePools: new Map((data.pools ?? []).map((pool) => [pool.case_id, pool]))
    });
    refreshPortfolio();
  } catch { /* the decision timeline reports runtime errors */ }
}

// The activity stream replays recent decisions when it connects, and a busy agent emits several in a burst; each one
// needs the same fresh reference list, so ask once after the burst instead of once per event.
let evidenceTimer = null;
function scheduleEvidenceRefresh() {
  clearTimeout(evidenceTimer);
  evidenceTimer = setTimeout(() => { evidenceTimer = null; refreshEvidence(); }, 250);
}

export function clearEvidenceSelection() {
  versions.selection += 1;
  set({ evidenceSelected: null });
}

function resetEvidence() {
  clearEvidenceSelection();
  set({ evidenceLatest: new Map(), evidencePools: new Map() });
  refreshEvidence();
}

function selectDecisionEvidence(decision) {
  const state = get();
  if (decision.mode !== (state.demoMode ? 'demo' : 'live') || decision.generation !== undefined && decision.generation !== state.modeGeneration) return false;
  set({ evidenceSelected: decision, categoryFilter: 'all', searchQuery: '', aiMatchedIds: null, aiRanks: null, aiResult: null });
  return true;
}

export async function selectLinkedDecision(decision) {
  const version = ++versions.selection;
  if (!selectDecisionEvidence(decision)) return false;
  if (get().caseId !== decision.case_id) await selectCase(decision.case_id);
  if (version !== versions.selection) return false;
  return selectDecisionEvidence(decision);
}

// ---------------------------------------------------------------------------------------------
// Boot + runtime mode
// ---------------------------------------------------------------------------------------------

let booted = false;
export async function boot() {
  if (booted) return;
  booted = true;
  const initialView = viewFromHash(window.location.hash);
  if (initialView) set({ view: initialView });
  // Give the landing entry an address too, so Back from the next page has somewhere to return to.
  else window.history.replaceState(null, '', `#/${get().view}`);
  wireWindowEvents();
  // The runtime mode, the chain configuration and the catalog do not depend on each other: ask for them together.
  const chain = (async () => {
    await refreshNetworks();
    await reflectChainStatus();
    await restoreWalletIfSaved();
  })();
  const catalog = api.getCases().then((cases) => ({ cases }), (error) => ({ error }));
  const modeLoaded = await loadDemoRuntimeMode();
  await chain;
  const loaded = await catalog;
  if (loaded.error) {
    set({ casesError: loaded.error.message });
    toast(t('t_load_cases_fail', { msg: loaded.error.message }), true);
    return;
  }
  set({ cases: loaded.cases, casesError: null });
  // A working case this tab had selected comes back after a reload (it is private, so it is not in the catalog).
  await refreshWorkspaceCases();
  const remembered = rememberedWorkspaceCase();
  await selectCase(remembered && get().view !== 'market' && findCase(get(), remembered) ? remembered : get().cases[0]?.case_id);
  // Quotes for the other projects are requested by the market page when it is shown. The evidence and the portfolio
  // were requested with the mode; ask again only when that failed or a saved wallet came back after the first read.
  if (!modeLoaded) refreshEvidence();
  if (!modeLoaded || get().wallet) refreshPortfolio();
}

/** @returns {Promise<boolean>} whether the server answered; the page still starts in Demo when it did not. */
async function loadDemoRuntimeMode() {
  try {
    const response = await fetch('/api/demo/mode');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load runtime mode');
    set({ demoMode: data.demoMode, liveAvailable: data.liveAvailable, modeGeneration: data.generation });
    resetEvidence();
    return true;
  } catch {
    set({ demoMode: true, liveAvailable: false });
    return false;
  }
}

// Switching Demo <-> Live is an admin operation: the server asks for AGENTBL_ADMIN_TOKEN.
// The token is kept for this tab session only (sessionStorage), never in localStorage.
const ADMIN_TOKEN_KEY = 'agentbl.adminToken';

function storedAdminToken() {
  try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
}

function rememberAdminToken(token) {
  try {
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch { /* storage unavailable: the prompt simply reappears next time */ }
}

async function postAdmin(url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, data: await response.json() };
}

/** POST an admin operation; on 401 ask for the token once, retry, and remember it only if it worked. */
async function postWithAdminToken(url, body) {
  let { response, data } = await postAdmin(url, body, storedAdminToken());
  if (response.status === 401) {
    const entered = (await askText({ title: t('admin_token_title'), label: t('admin_token_prompt'), hint: t('admin_token_hint'), secret: true }) || '').trim();
    if (!entered) throw new Error(t('admin_token_cancelled'));
    ({ response, data } = await postAdmin(url, body, entered));
    rememberAdminToken(response.ok ? entered : '');
  }
  return { response, data };
}

export async function toggleRuntimeMode() {
  const target = get().demoMode ? 'live' : 'demo';
  try {
    const { response, data } = await postWithAdminToken('/api/demo/mode', { mode: target });
    if (!response.ok) throw new Error(data.error || `Could not switch to ${target}`);
    versions.caseVersion++;
    set({ demoMode: data.demoMode, liveAvailable: data.liveAvailable, modeGeneration: data.generation, comparison: null, comparisonKey: null, quoteError: null,
      marketComparisons: {}, preferencesByCase: {}, mint: null, financingUsd: null, marketSubscriptionResult: null });
    resetEvidence();
    resetCopilotUi();
    // Demo and Live working cases never share a list: a case of the other mode is not selectable after the switch.
    await refreshWorkspaceCases();
    await selectCase(findCase(get(), get().caseId) ? get().caseId : get().cases[0]?.case_id);
    warmMarketQuotes();
    toast(t(target === 'live' ? 'mode_switched_live' : 'mode_switched_demo'));
  } catch (error) {
    toast(error.message, true);
  }
}

export async function resetDemo() {
  try {
    const { response, data } = await postWithAdminToken('/api/demo/reset');
    if (!response.ok) throw new Error(data.error || 'Demo reset failed');
    set({
      modeGeneration: data.generation, marketComparisons: {}, marketSubscriptionResult: null,
      preferencesByCase: {},
      mint: null, poolId: null, voyageInjected: false, voyageOffering: null, voyageEvents: []
    });
    resetEvidence();
    resetCopilotUi();
    await refreshWorkspaceCases();
    await selectCase(get().cases[0]?.case_id);
    warmMarketQuotes();
    toast(t('demo_reset_done'));
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

export const VIEWS = ['finance', 'market', 'mint', 'agent', 'discover'];

/**
 * Show a page. `history` says how the address bar follows: 'push' (default) adds an entry so the browser's Back
 * button returns to the previous page, 'replace' rewrites the current entry (arrow-key tab moves, the first load),
 * 'none' when the address already changed (Back/Forward, a typed hash).
 */
export function setView(name, { history = 'push' } = {}) {
  if (!VIEWS.includes(name)) return;
  set({ view: name });
  // The market is the public research shelf: a private working case is priced on the Mint page only.
  if (name === 'market' && findCase(get())?.private) {
    const source = findCase(get())?.source_case_id;
    selectCase(get().cases.some((entry) => entry.case_id === source) ? source : get().cases[0]?.case_id);
  }
  // A decision drawer belongs to the Agent console it was opened in.
  if (name !== 'agent') agentStore.set({ openDecisionId: null });
  if (name === 'market') refreshPortfolio();
  if (typeof window !== 'undefined') {
    if (history !== 'none' && window.location.hash !== `#/${name}`) window.history[history === 'replace' ? 'replaceState' : 'pushState'](null, '', `#/${name}`);
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  }
}

export function viewFromHash(hash) {
  // A funding pool's own address (#/finance/pool/7) belongs to the finance page; the panel opens that pool.
  const name = String(hash ?? '').replace(/^#\/?/u, '').replace(/^finance\/pool\/[1-9]\d{0,8}$/u, 'finance');
  return VIEWS.includes(name) ? name : null;
}

export async function openDeal(caseId) {
  if (caseId && caseId !== get().caseId) await selectCase(caseId);
  set({ dealOpen: true });
}

export function closeDeal() {
  set({ dealOpen: false });
}

// ---------------------------------------------------------------------------------------------
// Case selection + quotes
// ---------------------------------------------------------------------------------------------

/** Preferences from the form, in the shape the server stores. Empty fields are left out. */
function exporterPreferencesOf({ minPrice, speed }) {
  const preferences = {};
  const floor = minPrice !== '' ? Number(minPrice) : NaN;
  if (Number.isFinite(floor) && floor >= 0 && floor <= 1) preferences.min_acceptable_issue_price = floor;
  if (speed) preferences.payout_speed_preference = speed;
  return preferences;
}

// ---------------------------------------------------------------------------------------------
// This browser's own working cases (what its uploads produced). They are private: listed only for the workspace
// that owns them, never added to the public catalog, and remembered for this tab so a reload returns to them.
// ---------------------------------------------------------------------------------------------

const WORKSPACE_SELECTION_KEY = 'agentbl.workspaceCase';

function rememberedWorkspaceCase() {
  try { return sessionStorage.getItem(WORKSPACE_SELECTION_KEY) || null; } catch { return null; }
}

function rememberWorkspaceCase(caseId) {
  try {
    if (caseId) sessionStorage.setItem(WORKSPACE_SELECTION_KEY, caseId);
    else sessionStorage.removeItem(WORKSPACE_SELECTION_KEY);
  } catch { /* storage unavailable: a reload starts from the first sample */ }
}

function workspaceEntry(data) {
  const bl = data.bill_of_lading ?? {};
  return { case_id: data.case_id, label: `${bl.cargo ?? 'Trade case'} · ${bl.port_of_loading ?? '?'} → ${bl.port_of_discharge ?? '?'}`,
    route: `${bl.port_of_loading ?? '?'} → ${bl.port_of_discharge ?? '?'}`, cargo: bl.cargo ?? null, risk_hint: null,
    private: true, source_case_id: data.source_case_id ?? null, case: data };
}

/**
 * The working cases of the current mode; Demo and Live material never appear in one list. When the selected working
 * case comes back with other material (an upload or a review changed it under the same ID), the page follows the new
 * revision and reprices it: the old comparison stays visible, marked stale and not issuable, until the new one is in.
 */
export async function refreshWorkspaceCases({ follow = true } = {}) {
  const generation = get().modeGeneration, mode = get().demoMode ? 'demo' : 'live';
  try {
    const cases = await api.getWorkspaceCases();
    if (generation !== get().modeGeneration) return;
    set({ workspaceCases: cases.filter((data) => (data.mode ?? 'demo') === mode).map(workspaceEntry) });
  } catch { return; /* the public samples still work; the list is asked for again after the next upload */ }
  const state = get(), entry = findCase(state);
  if (!follow || !entry?.private || !state.caseData || caseRevision(entry.case) === caseRevision(state.caseData)) return;
  const version = ++versions.caseVersion;
  set({ caseData: entry.case, mint: null, marketSubscriptionResult: null });
  await loadSelectedCase(entry, 'quote', version, state.modeGeneration);
}

/** Switch the page to the case an upload produced, so the quote, the preferences and the evidence are about it. */
export async function openWorkspaceCase(caseId) {
  // selectCase loads the newest revision itself; following it here as well would price it twice.
  await refreshWorkspaceCases({ follow: false });
  if (!findCase(get(), caseId)) { toast(t('t_pricing_fail', { msg: caseId }), true); return false; }
  await selectCase(caseId);
  return true;
}

/**
 * The server case this browser writes for a catalog case: its own working copy of a public sample. A failure is
 * thrown: guessing the sample itself would list its public jobs and preferences as if they were this browser's.
 */
async function resolveWorkspaceCase(entry) {
  if (entry.private) return entry.case_id;
  return (await api.getWorkspaceCopy(entry.case_id))?.case_id ?? entry.case_id;
}

/**
 * WP2.8: the agent enforces these, so the server must hold them, not just this browser tab. A failure is thrown to
 * the caller: nothing may act on preferences the server did not keep.
 */
async function persistExporterPreferences(caseId, draft) {
  const target = (get().caseId === caseId && get().workspaceCaseId) || caseId;
  try {
    await api.saveExporterPreferences(target, exporterPreferencesOf(draft));
  } catch (error) {
    // A public sample is read-only; the server names this browser's own copy.
    const copy = error.status === 409 && error.details?.workspace_case_id;
    if (!copy) throw error;
    await api.saveExporterPreferences(copy, exporterPreferencesOf(draft));
    if (get().caseId === caseId) set({ workspaceCaseId: copy });
  }
  agentLog(t('pref_saved'), 'muted', 'pref_saved');
}

/** Show what the agent already holds for a case instead of whatever the previous case left in the form. */
async function loadExporterPreferences(caseId, version, generation) {
  try {
    const workspaceCaseId = get().workspaceCaseId ?? caseId;
    let stored = await api.getExporterPreferences(workspaceCaseId);
    // A copy that saved nothing yet starts from what the sample itself holds.
    if (workspaceCaseId !== caseId && !stored?.updated_at) stored = await api.getExporterPreferences(caseId);
    if (get().caseId !== caseId || version !== versions.caseVersion || generation !== get().modeGeneration) return;
    const values = stored?.preferences ?? {};
    const preferences = {
      minPrice: Number.isFinite(values.min_acceptable_issue_price) ? String(values.min_acceptable_issue_price) : '',
      speed: values.payout_speed_preference ?? ''
    };
    set((state) => ({ preferences, preferencesError: null, preferencesUnsaved: null, preferencesByCase: { ...state.preferencesByCase, [caseId]: preferences } }));
  } catch (error) {
    if (version === versions.caseVersion && generation === get().modeGeneration) set({ preferencesError: t('pref_load_failed') });
    // The page names the step; the reason is what the server or the network said.
    throw new Error(error?.message || t('pref_load_failed'), { cause: error });
  }
}

/** Edit the form only. Quotes and the agent keep using the saved preferences until a save succeeds. */
export function setPreferenceDraft(patch) {
  if (get().busy || get().preferencesError) return;
  set((state) => ({ preferences: { ...state.preferences, ...patch } }));
}

/**
 * Save the form. Only after the server kept it do the new values become the ones quotes use, and only then is the
 * change logged. A failure leaves the saved values in force and marks the form unsaved, with retry and undo.
 * A later save, a case switch or a mode change makes an earlier reply irrelevant.
 */
async function commitPreferences(logLine) {
  if (get().busy || get().preferencesError) return false;
  const { caseId, preferences } = get();
  const entry = findCase(get(), caseId);
  if (!entry) return false;
  const save = ++versions.preference, version = versions.caseVersion, generation = get().modeGeneration;
  const current = () => save === versions.preference && get().caseId === caseId && version === versions.caseVersion && generation === get().modeGeneration;
  set({ busy: true });
  try {
    await persistExporterPreferences(caseId, preferences);
  } catch (error) {
    if (current()) set({ busy: false, preferencesUnsaved: t('pref_unsaved', { msg: error.message }) });
    toast(t('pref_save_failed', { msg: error.message }), true);
    return false;
  }
  if (!current()) return false;
  // From here the comparison on screen prices the previous constraints: quoteCurrent() is false, so nothing can be
  // issued from it, until repricing with the saved ones succeeds. A failure keeps it visible for reference only.
  set((state) => ({ preferencesUnsaved: null, quoteError: null, preferencesByCase: { ...state.preferencesByCase, [caseId]: preferences } }));
  if (logLine) agentLog(logLine);
  const key = quoteKey(get(), caseId, entry.case);
  try {
    const comparison = await getCaseComparison(entry, true);
    if (current()) set({ comparison, comparisonKey: key });
  } catch (error) {
    if (current()) set({ quoteError: error.message });
    toast(t('t_reprice_fail', { msg: error.message }), true);
  } finally {
    if (current()) set({ busy: false });
  }
  return true;
}

/** The price floor was committed (blur / Enter): store it for the agent and reprice. */
export function commitMinPrice() {
  return commitPreferences(t('pref_price_updated', { value: get().preferences.minPrice }));
}

export async function commitSpeedPreference(value) {
  if (get().busy || get().preferencesError) return;
  setPreferenceDraft({ speed: value });
  const saved = await commitPreferences(t('pref_speed_updated', { value: value ? f.SPEED_META[value]?.label ?? value : t('pref_ai_recommended') }));
  if (saved) selectSpeed(value || (get().comparison?.recommended_payout_speed ?? 'BALANCED'));
}

/** Retry the unsaved form as it stands. */
export function retryPreferences() {
  return commitPreferences(t('pref_retried'));
}

/** Ask again for the quote of the saved constraints (after repricing with them failed). */
export async function requote() {
  const state = get(), entry = findCase(state);
  if (state.busy || !entry) return false;
  const caseId = state.caseId, version = versions.caseVersion, generation = state.modeGeneration, key = quoteKey(state, caseId, entry.case);
  const current = () => get().caseId === caseId && version === versions.caseVersion && generation === get().modeGeneration && key === quoteKey(get());
  set({ busy: true });
  try {
    const comparison = await getCaseComparison(entry, true);
    if (current()) set({ comparison, comparisonKey: key, quoteError: null });
    return true;
  } catch (error) {
    if (current()) set({ quoteError: error.message });
    toast(t('t_reprice_fail', { msg: error.message }), true);
    return false;
  } finally {
    if (version === versions.caseVersion) set({ busy: false });
  }
}

/** Put the form back to what the server saved. */
export function discardPreferenceDraft() {
  const { caseId, preferencesByCase } = get();
  set({ preferences: preferencesByCase[caseId] ?? { minPrice: '', speed: '' }, preferencesUnsaved: null });
}

export function getCaseComparison(entry, forceUpdate = false) {
  if (!entry?.case_id) return Promise.reject(new Error('Missing case id'));
  const cached = get().marketComparisons[entry.case_id];
  const generation = get().modeGeneration;
  const preference = get().preferencesByCase[entry.case_id];
  const floor = preference?.minPrice === '' || preference?.minPrice === undefined ? NaN : Number(preference.minPrice);
  // New material under the same ID is a new revision: it never reuses the comparison of the old one.
  const cacheKey = JSON.stringify([generation, preference ?? null, caseRevision(entry.case)]);
  if (!forceUpdate && cached?.cacheKey === cacheKey && cached?.comparison) return Promise.resolve(cached.comparison);
  if (!forceUpdate && cached?.cacheKey === cacheKey && cached?.promise) return cached.promise;
  const requestId = Symbol();
  const putComparison = (value, initial = false) => {
    if (generation !== get().modeGeneration || !initial && get().marketComparisons[entry.case_id]?.requestId !== requestId) return;
    set((state) => ({ marketComparisons: { ...state.marketComparisons, [entry.case_id]: { ...value, cacheKey, requestId } } }));
  };
  const promise = api.compareSpeeds(entry.case, { min_acceptable_issue_price: Number.isFinite(floor) ? floor : undefined })
    .then((comparison) => { putComparison({ comparison }); return comparison; })
    .catch((error) => { putComparison({ error }); throw error; });
  putComparison({ promise }, true);
  return promise;
}

/** Make sure every listed case has a quote (or is loading one). */
export function ensureComparisons(cases) {
  const missing = cases.filter((entry) => !get().marketComparisons[entry.case_id]);
  if (!missing.length) return;
  set({ marketLoading: true });
  Promise.allSettled(missing.map((entry) => getCaseComparison(entry))).finally(() => set({ marketLoading: false }));
}

export function warmMarketQuotes() {
  const { cases } = get();
  if (!cases.length) return;
  set({ marketLoading: true });
  Promise.allSettled(cases.map((entry) => getCaseComparison(entry))).finally(() => set({ marketLoading: false }));
}

export async function selectCase(caseId) {
  const entry = findCase(get(), caseId);
  if (!entry) return;
  const version = ++versions.caseVersion, generation = get().modeGeneration;
  if (get().evidenceSelected?.case_id !== caseId) clearEvidenceSelection();
  rememberWorkspaceCase(entry.private ? caseId : null);
  set({ caseId, caseData: entry.case, comparison: null, comparisonKey: null, quoteError: null, busy: true, preferences: { minPrice: '', speed: '' }, preferencesError: null, preferencesUnsaved: null,
    workspaceCaseId: null, caseLoad: null, intakeHeld: 0, financingUsd: null, mint: null, poolId: null, voyageInjected: false, voyageOffering: null, voyageEvents: [], marketSubscriptionResult: null });
  emit('agentbl:casechange', { case_id: caseId });
  subscribeToAgentActivity(caseId);
  await loadSelectedCase(entry, 'workspace', version, generation);
}

const LOAD_STEPS = ['workspace', 'preferences', 'quote'];

/**
 * Load the selected case from `from` on: this browser's working copy, then the constraints saved for it, then its
 * quote (each needs the one before). A failure stops at its step and stays on the page with a retry that resumes there;
 * the upload card only needs the first step, so materials stay reachable while pricing is down.
 */
async function loadSelectedCase(entry, from, version, generation) {
  const caseId = entry.case_id;
  const current = () => version === versions.caseVersion && generation === get().modeGeneration && get().caseId === caseId;
  let step = from;
  set({ busy: true, caseLoad: null });
  try {
    if (LOAD_STEPS.indexOf(from) <= 0) {
      const workspaceCaseId = await resolveWorkspaceCase(entry);
      if (!current()) return;
      set({ workspaceCaseId });
    }
    if (LOAD_STEPS.indexOf(from) <= 1) {
      step = 'preferences';
      await loadExporterPreferences(caseId, version, generation);
      if (!current()) return;
    }
    step = 'quote';
    const key = quoteKey(get(), caseId, entry.case);
    const comparison = await getCaseComparison(entry);
    if (!current()) return;
    const speed = get().preferences.speed || comparison.recommended_payout_speed || comparison.quotes?.[0]?.payout_speed || 'BALANCED';
    set({ comparison, comparisonKey: key, speed, quoteError: null });
    const quote = selectedQuote();
    set({
      financingUsd: Math.round(quote?.requested_cash_usd ?? quote?.expected_cash_to_exporter_usd ?? 0),
      marketSubscriptionUsd: defaultMarketSubscription(quote),
      marketSubscriptionResult: null
    });
  } catch (error) {
    if (current()) set({ caseLoad: { step, message: error.message || t('case_load_unknown') } });
  } finally {
    if (version === versions.caseVersion) set({ busy: false });
  }
}

/** Resume loading the selected case at the step that failed, without leaving the page. */
export function retryCaseLoad() {
  const state = get(), entry = findCase(state);
  if (!entry || state.busy || !state.caseLoad) return Promise.resolve();
  return loadSelectedCase(entry, state.caseLoad.step, versions.caseVersion, state.modeGeneration);
}

/**
 * The Documents card reports how many of the selected case's jobs wait for corrected documents: the server's count of
 * every such job, not how many of them one page happens to show.
 */
export function noteIntakeJobs(caseId, held) {
  if (get().workspaceCaseId !== caseId) return;
  const count = Math.max(0, Number(held) || 0);
  if (count !== get().intakeHeld) set({ intakeHeld: count });
}

export function selectSpeed(speed) {
  if (!get().comparison?.quotes?.some((quote) => quote.payout_speed === speed)) return;
  clearEvidenceSelection();
  set({ speed, voyageInjected: false, voyageOffering: null, voyageEvents: [] });
}

/** After a filter or search-language change the selection must stay among the visible cases. */
export function keepSelectionVisible() {
  const visible = visibleCases(get());
  if (visible.length && !visible.some((c) => c.case_id === get().caseId)) selectCase(visible[0].case_id);
}

export function setCategory(category) {
  set({ categoryFilter: category });
  keepSelectionVisible();
}

/** Drop the category, the keyword and any Copilot match so the whole shelf is visible again. */
export function resetMarketFilters() {
  resetCopilotSession('search');
  versions.search += 1;
  searchAbort?.abort();
  set({ categoryFilter: 'all', searchQuery: '', aiMatchedIds: null, aiRanks: null, aiResult: null, aiSearching: false });
  keepSelectionVisible();
}

export function setMarketSort(sort) {
  set({ marketSort: sort || 'recommended' });
}

// ---------------------------------------------------------------------------------------------
// Copilot search (the same server Copilot as the floating assistant)
// ---------------------------------------------------------------------------------------------

let searchAbort = null;

export function resetCopilotUi() {
  resetCopilotSession();
  versions.search += 1;
  searchAbort?.abort();
  set({ aiMatchedIds: null, aiRanks: null, aiResult: null, aiSearching: false });
  emit('agentbl:runtimechange');
}

/** Typing replaces any Copilot match with the plain keyword filter (debounced by the caller). */
export function setSearchQuery(query) {
  resetCopilotSession('search');
  versions.search += 1;
  searchAbort?.abort();
  set({ searchQuery: query, aiMatchedIds: null, aiRanks: null, aiResult: null, aiSearching: false });
  keepSelectionVisible();
}

function applySearchResult(result) {
  set({
    aiMatchedIds: new Set(result.recommendations.map((item) => item.case_id)),
    aiRanks: new Map(result.recommendations.map((item) => [item.case_id, item.rank])),
    aiResult: result
  });
  // The detail panel must follow the matches, otherwise it keeps showing (and selling) a hidden project.
  keepSelectionVisible();
}

export async function runAiSearch(query) {
  const text = String(query ?? '').trim();
  if (!text) { toast(t('ai_empty_query'), true); return; }
  resetCopilotSession('search');
  searchAbort?.abort();
  searchAbort = new AbortController();
  const requestGeneration = ++versions.search, modeGeneration = get().modeGeneration;
  set({ aiSearching: true });
  const current = () => requestGeneration === versions.search && modeGeneration === get().modeGeneration;
  const apply = (result) => {
    if (!current()) return;
    set({ searchQuery: text });
    applySearchResult(result);
  };
  try {
    const result = await copilotQuery(text, { scope: 'search', limit: 10, signal: searchAbort.signal, onResult: apply });
    apply(result);
    if (current()) toast(result.clarifying_question || t('cp_found', { n: result.recommendations.length }));
  } catch (error) {
    if (error.name !== 'AbortError' && requestGeneration === versions.search) {
      set({ aiMatchedIds: null, aiRanks: null, aiResult: null });
      toast(t('ai_error', { msg: error.message }), true);
    }
  } finally {
    if (requestGeneration === versions.search) set({ aiSearching: false });
  }
}

/** The search result card's own refresh (an action form re-asked the Copilot). */
export function replaceSearchResult(result) {
  if (get().modeGeneration !== result.generation) return;
  applySearchResult(result);
}

export function clearAiSearch() {
  setSearchQuery('');
}

// ---------------------------------------------------------------------------------------------
// Marketplace subscription (Demo: recorded by the server, no transaction)
// ---------------------------------------------------------------------------------------------

export function setSubscriptionAmount(value) {
  set({ marketSubscriptionUsd: value, marketSubscriptionResult: null });
}

export async function subscribeSelected() {
  const state = get();
  const entry = state.cases.find((c) => c.case_id === state.caseId);
  const quote = state.evidencePools.get(state.caseId)?.quote ?? selectedQuote(state);
  if (state.busy || state.marketSubscribing || !state.demoMode || !entry || !marketView(state, entry).canSubscribe || !quote || quote.case_id !== state.caseId) return;
  const amount = Number(state.marketSubscriptionUsd) || 0;
  if (amount <= 0) { toast(t('market_need_amount'), true); return; }
  const caseId = state.caseId, modeGeneration = state.modeGeneration, wallet = walletAddress();
  set({ marketSubscribing: true });
  try {
    const result = await api.subscribePool({ pool_id: caseId, amount_usd: amount, wallet_address: wallet });
    if (get().caseId !== caseId || get().modeGeneration !== modeGeneration || wallet !== walletAddress()) return;
    set({ marketSubscriptionResult: { ...result.investment, final_state: result.poolStatus } });
    await refreshPortfolio();
    refreshEvidence();
    toast(t('market_subscribed_toast'));
  } catch (error) {
    toast(t('market_subscribe_fail', { msg: error.message || error }), true);
  } finally {
    set({ marketSubscribing: false });
  }
}

let portfolioRequest = 0;
export async function refreshPortfolio() {
  const wallet = walletAddress(), modeGeneration = get().modeGeneration;
  const requestVersion = ++portfolioRequest;
  if (get().portfolio.wallet !== wallet || get().portfolio.generation !== modeGeneration) set({ portfolio: { wallet, generation: modeGeneration, investments: [], positions: [], summary: null, error: null } });
  try {
    const response = await fetch('/api/investors/portfolio?wallet_address=' + encodeURIComponent(wallet));
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error);
    const positions = /^0x[0-9a-f]{40}$/iu.test(wallet) ? await api.getPositions(wallet) : { positions: [] };
    if (requestVersion !== portfolioRequest || wallet !== walletAddress() || modeGeneration !== get().modeGeneration) return;
    set({ portfolio: { wallet, generation: modeGeneration, investments: data.investments, positions: positions.positions, warning: positions.warning, summary: data.summary, error: null } });
  } catch (error) {
    if (requestVersion === portfolioRequest && wallet === walletAddress() && modeGeneration === get().modeGeneration) set((state) => ({ portfolio: { ...state.portfolio, error: error.message } }));
  }
}

// ---------------------------------------------------------------------------------------------
// Mint (View ①): a real testnet transaction when a wallet and the contracts are there, else a labelled simulation
// ---------------------------------------------------------------------------------------------

export function setFinancing(value) {
  set({ financingUsd: value });
}



export async function mint() {
  const state=get(), quote=selectedQuote(state);
  if (state.busy || state.minting || state.preferencesError || !quote || quote.case_id !== state.caseId || PAUSED_ACTIONS.has(quote.pricing_action)) return;
  // A quote computed before the constraints now saved can be shown, never issued.
  if (!quoteCurrent(state)) { toast(t('quote_stale_blocked'), true); return; }
  if (!state.demoMode) { toast(t('controlled_issuance_required'), true); return; }
  const financing=Number(state.financingUsd)||0;
  if(financing<=0){toast(t('t_need_financing'),true);return;}
  const caseId=state.caseId,generation=state.modeGeneration,hash=quote.quote_hash;
  set({minting:true});
  try {
    const result=await web3.simulatedMint(caseId,quote,financing);
    if(get().caseId===caseId && get().modeGeneration===generation && selectedQuote()?.quote_hash===hash && quoteCurrent()) {set({mint:result});toast(t('t_minted_sim',{n:f.int(result.mintedAmount)}));}
  } finally {set({minting:false});}
}

// ---------------------------------------------------------------------------------------------
// Wallet + network
// ---------------------------------------------------------------------------------------------

export const WALLET_LABELS = { metamask: 'MetaMask', keplr: 'Keplr', leap: 'Leap' };
const NETWORK_LABELS = { injective_testnet: 'Injective Testnet', injective_mainnet: 'Injective Mainnet' };

async function networkName() {
  try {
    const cfg = await web3.loadChainConfig();
    return cfg?.displayName || NETWORK_LABELS[cfg?.network] || cfg?.network || 'Injective Testnet';
  } catch { return 'Injective Testnet'; }
}

async function reflectChainStatus() {
  set({ chainReal: await web3.isRealChainConfigured(), networkName: await networkName() });
}

async function refreshNetworks() {
  const current = await web3.loadChainConfig();
  const networks = await web3.configuredNetworks();
  set({ networks, networkKey: current?.key ?? current?.defaultNetwork ?? 'injective-testnet' });
}

export async function changeNetwork(key) {
  try {
    await web3.selectNetwork(key);
    set({ networkKey: key });
    await reflectChainStatus();
  } catch (error) {
    toast(error.message, true);
    const cfg = await web3.loadChainConfig();
    set({ networkKey: cfg?.key ?? 'injective-testnet' });
  }
}

async function restoreWalletIfSaved() {
  try {
    const restored = await web3.restoreWalletSession();
    if (restored) set({ wallet: restored });
  } catch { /* silent reconnect is best-effort */ }
}

export async function connectWallet(walletType = 'metamask') {
  const { address, kind } = await web3.connectWallet(walletType);
  set({ wallet: { address, walletType, kind }, portfolio: { investments: [], positions: [], summary: null, error: null } });
  toast(t('wallet_connected_toast', { wallet: WALLET_LABELS[walletType] ?? walletType, network: get().networkName }));
  refreshPortfolio();
  return address;
}

export async function chooseWallet(walletType) {
  try {
    await connectWallet(walletType);
    return true;
  } catch (error) {
    if (error.code === 'NO_WALLET') toast(t('wallet_missing_toast', { wallet: WALLET_LABELS[walletType] ?? walletType }), true);
    else if (error.code === 'REJECTED') toast(t('t_connect_cancel'), true);
    else toast(t('t_connect_fail', { msg: error.message || error }), true);
    return false;
  }
}

export async function disconnectWallet() {
  try {
    const { revoked } = await web3.disconnect();
    set({ wallet: null, portfolio: { investments: [], positions: [], summary: null, error: null } });
    toast(t(revoked ? 't_wallet_disconnected' : 't_wallet_disconnected_local'));
    refreshPortfolio();
  } catch (error) {
    toast(t('t_connect_fail', { msg: error.message || error }), true);
  }
}

export async function copyWalletAddress() {
  const address = web3.connectedAddress();
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    toast(t('t_wallet_copied'));
  } catch {
    toast(t('t_wallet_copy_fail'), true);
  }
}

export async function walletExplorerUrl(address) {
  let base = 'https://testnet.blockscout.injective.network';
  try { base = (await web3.loadChainConfig())?.explorerBase || base; } catch { /* default */ }
  return address.startsWith('inj')
    ? `https://testnet.explorer.injective.network/account/${address}`
    : `${base.replace(/\/$/u, '')}/address/${address}`;
}

// ---------------------------------------------------------------------------------------------
// Agent activity for the selected case (SSE)
// ---------------------------------------------------------------------------------------------

const LOG_LIMIT = 200;

// `text` is plain text and is rendered as a text node: log lines carry values that originate on
// the server (SSE events), in wallets and in error messages.
export function agentLog(text, tone = 'muted', key = null) {
  const entry = { id: `${Date.now()}-${Math.round(performance.now() * 1000)}`, time: new Date().toISOString().split('T')[1].slice(0, 8), text, tone, key };
  set((state) => ({ agentLogs: [...state.agentLogs, entry].slice(-LOG_LIMIT) }));
}

const activityStream = { source: null, retryTimer: null, retries: 0 };

export function subscribeToAgentActivity(caseId, { retry = false } = {}) {
  // A pending reconnect belongs to the previous subscription: drop it, otherwise switching case
  // would later be overridden by the old case's retry.
  clearTimeout(activityStream.retryTimer);
  if (!retry) activityStream.retries = 0;
  activityStream.source?.close();
  activityStream.source = null;
  if (!caseId || typeof EventSource === 'undefined') return;

  const source = new EventSource(`/api/agent/activity/stream?case_id=${encodeURIComponent(caseId)}`);
  activityStream.source = source;
  source.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'connected') {
      activityStream.retries = 0;
      agentLog(t('agent_stream_connected'), 'ok', 'agent_stream_connected');
    } else if (data.type === 'activity') {
      agentLog(`Agent: ${actionLabel(data.action)}${data.details?.price ? ` → $${data.details.price}` : ''}`, 'accent');
      set((state) => ({ agentActivities: [{ ...data, id: data.id ?? `ui-${Date.now()}`, timestamp: data.timestamp ?? new Date().toISOString() }, ...state.agentActivities].slice(0, 100) }));
      if (data.decision_id) scheduleEvidenceRefresh();
      // Decision records carry the agent's decision verb in details.decision_action.
      const decisionAction = data.details?.decision_action ?? data.action;
      if (NOTIFY_DECISION_ACTIONS.has(decisionAction)) toast(t('agent_decision_toast', { action: actionLabel(decisionAction) }));
    }
  };
  source.onerror = () => {
    agentLog(t('agent_stream_reconnecting'), 'warn', 'agent_stream_reconnecting');
    source.close();
    if (activityStream.source === source) activityStream.source = null;
    // Back off (3s, 6s, ... up to 30s) so a full or restarting server is not hammered.
    const delay = Math.min(30_000, 3_000 * 2 ** activityStream.retries);
    activityStream.retries += 1;
    activityStream.retryTimer = setTimeout(() => subscribeToAgentActivity(caseId, { retry: true }), delay);
  };
}

// ---------------------------------------------------------------------------------------------
// Cross-surface events
// ---------------------------------------------------------------------------------------------

function wireWindowEvents() {
  window.addEventListener('agentbl:walletchange', (event) => {
    if (!event.detail?.address) set({ wallet: null, portfolio: { investments: [], positions: [], summary: null, error: null } });
    refreshPortfolio();
  });
  window.addEventListener('agentbl:portfoliochange', () => refreshPortfolio());
  window.addEventListener('agentbl:copilotaction', () => { refreshPortfolio(); refreshEvidence(); });
  window.addEventListener('agentbl:decisionopen', (event) => {
    setView('agent');
    agentStore.set({ openDecisionId: event.detail.decision_id });
  });
  window.addEventListener('agentbl:selectcase', (event) => {
    const caseId = event.detail?.case_id;
    if (!get().cases.some((entry) => entry.case_id === caseId)) return;
    // An explicit Copilot navigation replaces the market search that could hide the requested project.
    resetMarketFilters();
    selectCase(caseId);
    setView('market');
  });
  window.addEventListener('agentbl:decisionselected', (event) => {
    selectLinkedDecision(event.detail.decision).catch((error) => toast(error.message, true));
  });
  window.addEventListener('agentbl:decisionnavigate', async (event) => {
    const { decision, target } = event.detail;
    if (!['market', 'mint'].includes(target)) return;
    if (!await selectLinkedDecision(decision)) return;
    setView(target);
    set({ focusRequest: { target, caseId: decision.case_id, seq: Date.now() } });
  });
  window.addEventListener('agentbl:copilotupdate', ({ detail }) => {
    const state = get();
    if (detail.scope !== 'search' || !state.aiMatchedIds || state.aiSearching) return;
    const result = detail.update.result;
    applySearchResult({ ...result, rerank: detail.update });
  });
  window.addEventListener('hashchange', () => {
    const view = viewFromHash(window.location.hash);
    // Back to the entry before the first page load has no hash: that is the home page.
    if (!view) setView('finance', { history: 'replace' });
    else if (view !== get().view) setView(view, { history: 'none' });
  });
}
