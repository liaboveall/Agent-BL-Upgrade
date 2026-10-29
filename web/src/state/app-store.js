// The shared application state: runtime mode, the case catalog, the selected case and its quotes,
// the wallet. Every view reads from here; the controller (controller.js) is the only writer of the
// cross-view fields.

import { createStore } from './store.js';

export const appStore = createStore({
  // One explicit runtime mode shared by the banner, the payment flows and Copilot.
  demoMode: true,
  liveAvailable: false,
  modeGeneration: 1,

  view: 'finance', // 'finance' | 'market' | 'mint' | 'agent' | 'discover'
  busy: false,

  // catalog + selection
  cases: [],
  casesError: null,
  caseId: null,
  caseData: null,

  // pricing: all three payout speeds + a recommendation
  comparison: null,
  speed: 'BALANCED',
  marketComparisons: {}, // case_id -> { comparison } | { promise } | { error }
  marketLoading: false,

  // marketplace filters
  categoryFilter: 'all',
  searchQuery: '',
  marketSort: 'recommended',
  aiMatchedIds: null, // Set of case ids from the Copilot search
  aiRanks: null, // Map case_id -> rank
  aiSearching: false,
  aiResult: null, // the Copilot search result rendered above the shelf

  // subscription panel
  marketSubscriptionUsd: null,
  marketSubscriptionResult: null,
  marketSubscribing: false,

  // agent decisions linked to cases (references + pools)
  evidenceLatest: new Map(),
  evidencePools: new Map(),
  evidenceSelected: null,

  // exporter preferences the agent enforces
  // `preferences` is the form (a draft); `preferencesByCase` holds what the server saved, and only that prices quotes.
  preferences: { minPrice: '', speed: '' },
  preferencesByCase: {},
  preferencesError: null,
  // A save that failed: the draft stays visible, marked unsaved, until it is retried or undone.
  preferencesUnsaved: null,
  // The server case this browser writes for the selected one: its own working copy of a public sample.
  workspaceCaseId: null,
  // The step where loading the selected case stopped ('workspace' | 'preferences' | 'quote') and why. It stays on the
  // page, with a retry that resumes at that step, until the case loads or another is selected.
  caseLoad: null,
  // Upload jobs of the selected case waiting for corrected documents (the Documents card reports them).
  intakeHeld: 0,
  // Cases this browser's uploads produced (catalog-shaped entries, `private: true`); never part of `cases`.
  workspaceCases: [],
  // What the shown comparison was computed for (case, mode generation, saved preferences, material revision): see quoteCurrent().
  comparisonKey: null,
  // Why repricing with newly saved preferences failed; the old comparison is then shown for reference only.
  quoteError: null,

  // mint module
  financingUsd: null,
  mint: null,
  minting: false,
  poolId: null,

  // in-transit simulation inside the project dialog
  voyageInjected: false,
  voyageOffering: null,
  voyageEvents: [],

  // wallet + chain
  wallet: null, // { address, walletType, kind }
  chainReal: false,
  networkName: 'Injective Testnet',
  networks: [],
  networkKey: null,

  // portfolio + agent activity
  portfolio: { investments: [], positions: [], summary: null, error: null },
  agentLogs: [],
  agentActivities: [],

  // the project detail dialog
  dealOpen: false,
  // a linked decision asked a view to scroll to and focus its card or quote
  focusRequest: null
});

export const getAppState = () => appStore.get();

/** The PricingQuote for the currently selected payout speed (or the first). */
/** The selected case, whether it is a public sample or one of this browser's own working cases. */
export function findCase(state, caseId = state.caseId) {
  return state.cases.find((entry) => entry.case_id === caseId) ?? state.workspaceCases.find((entry) => entry.case_id === caseId) ?? null;
}

// A case's content revision: a digest of its whole content (keys sorted), so an upload or review that changes the
// material under the same ID is a new revision. It identifies a version, it secures nothing. Kept per object.
const revisions = new WeakMap();
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value ?? null);
export function caseRevision(data) {
  if (!data || typeof data !== 'object') return null;
  if (!revisions.has(data)) {
    // Two 32-bit FNV-1a lanes with different seeds: collisions between versions of one case are not a practical worry.
    let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
    const text = canonical(data);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b ^ code, 0x01000197) >>> 0;
    }
    revisions.set(data, `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`);
  }
  return revisions.get(data);
}

/**
 * What a comparison for `caseId` must have been computed with: the mode generation, the preferences the server saved
 * and the revision of the case's material (`data`, by default what the page now holds for the case).
 */
export function quoteKey(state, caseId = state.caseId, data = findCase(state, caseId)?.case) {
  return JSON.stringify([caseId, state.modeGeneration, state.preferencesByCase[caseId] ?? null, caseRevision(data)]);
}

/** Whether the shown comparison still prices the saved constraints and the current material; only then may anything be issued from it. */
export function quoteCurrent(state = appStore.get()) {
  return Boolean(state.comparison) && state.comparisonKey === quoteKey(state);
}

/** Why the shown comparison is not current: 'material' (the case's material has a new revision), 'constraints', or null. */
export function quoteStaleReason(state = appStore.get()) {
  if (!state.comparison || quoteCurrent(state)) return null;
  let shown = null;
  try { shown = JSON.parse(state.comparisonKey ?? 'null'); } catch { /* an unreadable key is simply stale */ }
  return Array.isArray(shown) && shown[3] !== caseRevision(findCase(state)?.case) ? 'material' : 'constraints';
}

export function selectedQuote(state = appStore.get()) {
  const quotes = state.comparison?.quotes ?? [];
  const quote = quotes.find((quote) => quote.payout_speed === state.speed) ?? quotes[0] ?? null;
  return quote && quote.case_id === state.caseId ? quote : null;
}

/** The live quote in the voyage panel: the repriced quote if an event was injected, else the selected quote. */
export function liveQuote(state = appStore.get()) {
  if (state.voyageInjected && state.voyageOffering?.final_quote) return state.voyageOffering.final_quote;
  return selectedQuote(state);
}
