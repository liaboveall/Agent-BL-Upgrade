// The dashboard controller: loading the catalog and quotes, selecting a case, the runtime mode,
// subscriptions, minting, the wallet, the Copilot search and the agent activity stream. Components
// call these functions and read the results from appStore; nothing here touches the DOM.
//
// Every async path checks that the case, the runtime generation and the wallet it started with are
// still current before it writes, so a slow reply never overwrites a newer selection.

import { appStore, selectedQuote } from './app-store.js';
import * as api from '../lib/api.js';
import * as web3 from '../lib/web3.js';
import * as f from '../lib/format.js';
import { agent } from '../lib/agent-api.js';
import { t } from '../lib/i18n.js';
import { toast } from '../lib/toast.js';
import { copilotQuery, resetCopilotSession } from '../lib/copilot-api.js';
import { defaultMarketSubscription, PAUSED_ACTIONS, visibleCases } from '../lib/market.js';
import { scrollBehavior } from '../lib/accessibility.js';
import { agentStore } from '../pages/agent/agent-store.js';

const get = () => appStore.get();
const set = (patch) => appStore.set(patch);
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

const versions = { evidence: 0, selection: 0, caseVersion: 0, search: 0 };
// Decision verbs worth a toast when the agent emits them (docs/agent-implementation-plan.md §4.3).
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
  wireWindowEvents();
  await loadDemoRuntimeMode();
  await refreshNetworks();
  await reflectChainStatus();
  await restoreWalletIfSaved();
  try {
    set({ cases: await api.getCases(), casesError: null });
  } catch (error) {
    set({ casesError: error.message });
    toast(t('t_load_cases_fail', { msg: error.message }), true);
    return;
  }
  await selectCase(get().cases[0]?.case_id);
  warmMarketQuotes();
  refreshEvidence();
  refreshPortfolio();
}

async function loadDemoRuntimeMode() {
  try {
    const response = await fetch('/api/demo/mode');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load runtime mode');
    set({ demoMode: data.demoMode, liveAvailable: data.liveAvailable, modeGeneration: data.generation });
    resetEvidence();
  } catch {
    set({ demoMode: true, liveAvailable: false });
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
    const entered = (window.prompt(t('admin_token_prompt')) || '').trim();
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
    set({ demoMode: data.demoMode, liveAvailable: data.liveAvailable, modeGeneration: data.generation });
    resetEvidence();
    resetCopilotUi();
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
      mint: null, poolId: null, voyageInjected: false, voyageOffering: null, voyageEvents: []
    });
    resetEvidence();
    resetCopilotUi();
    await selectCase(get().cases[0]?.case_id);
    setView('market');
    warmMarketQuotes();
    toast(t('demo_reset_done'));
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

export const VIEWS = ['market', 'mint', 'agent', 'discover'];

export function setView(name) {
  if (!VIEWS.includes(name)) return;
  set({ view: name });
  // A decision drawer belongs to the Agent console it was opened in.
  if (name !== 'agent') agentStore.set({ openDecisionId: null });
  if (name === 'market') refreshPortfolio();
  if (typeof window !== 'undefined') {
    if (window.location.hash !== `#/${name}`) window.history.replaceState(null, '', `#/${name}`);
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  }
}

export function viewFromHash(hash) {
  const name = String(hash ?? '').replace(/^#\/?/u, '');
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

/** The preferences the form shows, in the shape the server stores. Empty fields are left out. */
function currentExporterPreferences() {
  const { minPrice, speed } = get().preferences;
  const preferences = {};
  const floor = minPrice !== '' ? Number(minPrice) : NaN;
  if (Number.isFinite(floor) && floor >= 0 && floor <= 1) preferences.min_acceptable_issue_price = floor;
  if (speed) preferences.payout_speed_preference = speed;
  return preferences;
}

/** WP2.8: the agent enforces these, so the server must hold them, not just this browser tab. */
async function persistExporterPreferences() {
  const { caseId } = get();
  if (!caseId) return;
  try {
    await api.saveExporterPreferences(caseId, currentExporterPreferences());
    agentLog(t('pref_saved'), 'muted', 'pref_saved');
  } catch (error) {
    toast(t('pref_save_failed', { msg: error.message }), true);
  }
}

/** Show what the agent already holds for a case instead of whatever the previous case left in the form. */
async function loadExporterPreferences(caseId) {
  try {
    const stored = (await api.getExporterPreferences(caseId))?.preferences ?? {};
    if (get().caseId !== caseId) return;
    const current = get().preferences;
    set({ preferences: {
      minPrice: Number.isFinite(stored.min_acceptable_issue_price) ? String(stored.min_acceptable_issue_price) : current.minPrice,
      speed: stored.payout_speed_preference ?? ''
    } });
  } catch {
    // The form keeps its current values; saving will report a real problem.
  }
}

export function setPreferenceDraft(patch) {
  set((state) => ({ preferences: { ...state.preferences, ...patch } }));
}

/** The price floor was committed (blur / Enter): store it for the agent and reprice. */
export async function commitMinPrice() {
  persistExporterPreferences();
  const { caseId, cases, preferences } = get();
  const entry = cases.find((c) => c.case_id === caseId);
  if (!entry) return;
  set({ busy: true });
  try {
    agentLog(t('pref_price_updated', { value: preferences.minPrice }));
    const comparison = await getCaseComparison(entry, true);
    if (get().caseId === caseId) set({ comparison });
  } catch (error) {
    toast(t('t_reprice_fail', { msg: error.message }), true);
  } finally {
    set({ busy: false });
  }
}

export function commitSpeedPreference(value) {
  setPreferenceDraft({ speed: value });
  persistExporterPreferences();
  agentLog(t('pref_speed_updated', { value: value ? f.SPEED_META[value]?.label ?? value : t('pref_ai_recommended') }));
  selectSpeed(value || (get().comparison?.recommended_payout_speed ?? 'BALANCED'));
}

export function getCaseComparison(entry, forceUpdate = false) {
  if (!entry?.case_id) return Promise.reject(new Error('Missing case id'));
  const cached = get().marketComparisons[entry.case_id];
  if (!forceUpdate && cached?.comparison) return Promise.resolve(cached.comparison);
  if (!forceUpdate && cached?.promise) return cached.promise;
  const floor = Number(get().preferences.minPrice);
  const putComparison = (value) => set((state) => ({ marketComparisons: { ...state.marketComparisons, [entry.case_id]: value } }));
  const promise = api.compareSpeeds(entry.case, { min_acceptable_issue_price: Number.isFinite(floor) ? floor : undefined })
    .then((comparison) => { putComparison({ comparison }); return comparison; })
    .catch((error) => { putComparison({ error }); throw error; });
  putComparison({ promise });
  return promise;
}

/** Make sure every listed case has a quote (or is loading one). */
export function ensureComparisons(cases) {
  for (const entry of cases) {
    const cached = get().marketComparisons[entry.case_id];
    if (!cached) getCaseComparison(entry).catch(() => {});
  }
}

export function warmMarketQuotes() {
  const { cases } = get();
  if (!cases.length) return;
  set({ marketLoading: true });
  Promise.allSettled(cases.map((entry) => getCaseComparison(entry))).finally(() => set({ marketLoading: false }));
}

export async function selectCase(caseId) {
  const entry = get().cases.find((c) => c.case_id === caseId);
  if (!entry) return;
  const version = ++versions.caseVersion, generation = get().modeGeneration;
  if (get().evidenceSelected?.case_id !== caseId) clearEvidenceSelection();
  set({ caseId });
  emit('agentbl:casechange', { case_id: caseId });
  await loadExporterPreferences(caseId);
  if (version !== versions.caseVersion || generation !== get().modeGeneration) return;
  set({ caseData: entry.case, financingUsd: null, mint: null, poolId: null, voyageInjected: false, voyageOffering: null, voyageEvents: [], busy: true });
  subscribeToAgentActivity(caseId);
  try {
    const comparison = await getCaseComparison(entry);
    if (version !== versions.caseVersion || generation !== get().modeGeneration) return;
    const speed = comparison.recommended_payout_speed ?? comparison.quotes?.[0]?.payout_speed ?? 'BALANCED';
    set({ comparison, speed });
    const quote = selectedQuote();
    set({
      financingUsd: Math.round(quote?.requested_cash_usd ?? quote?.expected_cash_to_exporter_usd ?? 0),
      marketSubscriptionUsd: defaultMarketSubscription(quote),
      marketSubscriptionResult: null
    });
  } catch (error) {
    toast(t('t_pricing_fail', { msg: error.message }), true);
  } finally {
    if (version === versions.caseVersion) set({ busy: false });
  }
}

export function selectSpeed(speed) {
  if (!get().comparison?.quotes?.some((quote) => quote.payout_speed === speed)) return;
  clearEvidenceSelection();
  set({ speed, voyageInjected: false, voyageOffering: null, voyageEvents: [] });
}

/** After a filter change the selection must stay among the visible cases. */
function keepSelectionVisible() {
  const visible = visibleCases(get());
  if (visible.length && !visible.some((c) => c.case_id === get().caseId)) selectCase(visible[0].case_id);
}

export function setCategory(category) {
  set({ categoryFilter: category });
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
  set({ marketSubscriptionUsd: Number(value) || 0, marketSubscriptionResult: null });
}

export async function subscribeSelected() {
  const state = get();
  const quote = state.evidencePools.get(state.caseId)?.quote ?? selectedQuote(state);
  if (!state.demoMode || !quote || PAUSED_ACTIONS.has(quote.pricing_action)) return;
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

export async function refreshPortfolio() {
  const wallet = walletAddress(), modeGeneration = get().modeGeneration;
  try {
    const response = await fetch('/api/investors/portfolio?wallet_address=' + encodeURIComponent(wallet));
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error);
    if (wallet !== walletAddress() || modeGeneration !== get().modeGeneration) return;
    set({ portfolio: { investments: data.investments, summary: data.summary, error: null } });
  } catch (error) {
    if (modeGeneration === get().modeGeneration) set((state) => ({ portfolio: { ...state.portfolio, error: error.message } }));
  }
}

// ---------------------------------------------------------------------------------------------
// Mint (View ①): a real testnet transaction when a wallet and the contracts are there, else a labelled simulation
// ---------------------------------------------------------------------------------------------

export function setFinancing(value) {
  set({ financingUsd: Number(value) || 0 });
}

function userFacingError(error) {
  const keyByCode = { NO_CONTRACT: 'err_no_contract', NO_SESSION: 'err_wallet_not_connected', INVALID_PARAMS: 'err_invalid_mint_params', NETWORK_ERROR: 'err_rpc_network' };
  const key = keyByCode[error?.code];
  return key ? t(key) : (error?.message || String(error || ''));
}

async function fallbackSim(caseId, quote, financing, note) {
  if (note) toast(note, true);
  return web3.simulatedMint(caseId, quote, financing);
}

export async function mint() {
  const quote = selectedQuote();
  if (!quote || PAUSED_ACTIONS.has(quote.pricing_action)) return;
  const financing = Number(get().financingUsd) || 0;
  if (financing <= 0) { toast(t('t_need_financing'), true); return; }
  const caseId = get().caseId;
  const record = (result) => set((state) => ({ mint: result, poolId: result.poolId && result.poolId !== 'sim' ? result.poolId : state.poolId }));
  set({ minting: true });
  try {
    let result;
    if (await web3.isRealChainConfigured()) {
      if (!web3.isWalletConnected()) {
        try { await connectWallet(); } catch (error) {
          if (error.code === 'NO_WALLET') result = await fallbackSim(caseId, quote, financing, t('t_no_wallet_detected'));
          else throw error;
        }
      }
      if (!result) {
        try {
          // Fire: tx sent → pending UI. Confirm: background poll → update UI.
          result = await web3.mintOnChain(quote, financing, (confirmed) => {
            if (get().caseId !== caseId) return;
            record(confirmed);
            if (confirmed.mode === 'chain') toast(t('t_mint_confirmed', { block: confirmed.blockNumber }));
            else if (confirmed.mode === 'chain_failed') toast(t('t_tx_failed', { msg: t('res_execution_failed') }), true);
            else if (confirmed.mode === 'chain_timeout') toast(t('t_confirm_timeout'), true);
          });
        } catch (error) {
          if (error.code === 'REJECTED') { toast(t('t_cancel_mint'), true); return; }
          result = await fallbackSim(caseId, quote, financing, t('t_chain_call_failed', { msg: userFacingError(error) }));
        }
      }
    } else {
      result = await web3.simulatedMint(caseId, quote, financing);
    }
    if (get().caseId !== caseId) return;
    record(result);
    if (result.mode === 'chain') toast(t('t_minted_chain', { n: f.int(result.mintedAmount), network: get().networkName }));
    else if (result.mode === 'chain_pending') toast(t('t_tx_submitted'));
    else toast(t('t_minted_sim', { n: f.int(result.mintedAmount) }));
  } catch (error) {
    toast(t('t_mint_fail', { msg: userFacingError(error) }), true);
  } finally {
    set({ minting: false });
  }
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
  set({ wallet: { address, walletType, kind } });
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
    set({ wallet: null });
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
      agentLog(`Agent: ${data.action}${data.details?.price ? ` → $${data.details.price}` : ''}`, 'accent');
      set((state) => ({ agentActivities: [{ ...data, id: data.id ?? `ui-${Date.now()}`, timestamp: data.timestamp ?? new Date().toISOString() }, ...state.agentActivities].slice(0, 100) }));
      if (data.decision_id) refreshEvidence();
      // Decision records carry the agent's decision verb in details.decision_action.
      const decisionAction = data.details?.decision_action ?? data.action;
      if (NOTIFY_DECISION_ACTIONS.has(decisionAction)) toast(t('agent_decision_toast', { action: decisionAction }));
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
    if (!event.detail?.address) set({ wallet: null });
    refreshPortfolio();
  });
  window.addEventListener('agentbl:portfoliochange', () => refreshPortfolio());
  window.addEventListener('agentbl:copilotaction', () => { refreshPortfolio(); refreshEvidence(); });
  window.addEventListener('agentbl:decisionopen', (event) => {
    setView('agent');
    agentStore.set({ openDecisionId: event.detail.decision_id });
  });
  window.addEventListener('agentbl:selectcase', (event) => { selectCase(event.detail.case_id); setView('market'); });
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
    if (view && view !== get().view) setView(view);
  });
}
