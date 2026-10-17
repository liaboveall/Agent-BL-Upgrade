// The shared application state: runtime mode, the case catalog, the selected case and its quotes,
// the wallet. Every view reads from here; the controller (controller.js) is the only writer of the
// cross-view fields.

import { createStore } from './store.js';

export const appStore = createStore({
  // One explicit runtime mode shared by the banner, the payment flows and Copilot.
  demoMode: true,
  liveAvailable: false,
  modeGeneration: 1,

  view: 'market', // 'market' | 'mint' | 'agent' | 'discover'
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
  preferences: { minPrice: '', speed: '' },
  preferencesByCase: {},
  preferencesError: null,

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
  portfolio: { investments: [], summary: null, error: null },
  agentLogs: [],
  agentActivities: [],

  // the project detail dialog
  dealOpen: false,
  // a linked decision asked a view to scroll to and focus its card or quote
  focusRequest: null
});

export const getAppState = () => appStore.get();

/** The PricingQuote for the currently selected payout speed (or the first). */
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
