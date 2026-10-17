// Thin API client for the AgentBL harness backend. Every pricing call goes
// through the SAME endpoints the contract mock and CLI demo use, so the frontend
// shows real engine output — never hard-coded numbers.

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.error || body?.message || `${url} → ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = body?.details;
    throw err;
  }
  return body;
}

function postJson(url, payload) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {})
  });
}

/** FE-7: curated case catalog. Falls back to the single demo case if /api/cases is absent. */
export async function getCases() {
  try {
    const data = await fetchJson('/api/cases');
    if (Array.isArray(data?.cases) && data.cases.length) return data.cases;
  } catch { /* fall through */ }
  const demo = await fetchJson('/api/demo-data');
  const bl = demo.bill_of_lading ?? {};
  return [{
    case_id: demo.case_id,
    label: `${bl.cargo ?? 'Trade case'} · ${bl.port_of_loading ?? '?'} → ${bl.port_of_discharge ?? '?'}`,
    route: `${bl.port_of_loading ?? '?'} → ${bl.port_of_discharge ?? '?'}`,
    cargo: bl.cargo ?? null,
    risk_hint: null,
    case: demo
  }];
}

/** WP2.8: the exporter's preferences for a case, as the agent holds them (the server is the source of truth). */
export function getExporterPreferences(caseId) {
  return fetchJson(`/api/agent/cases/${encodeURIComponent(caseId)}/preferences`);
}

/** WP2.8: store the preferences the agent must respect (a price floor, a payout speed, a financing target). */
export function saveExporterPreferences(caseId, preferences) {
  return fetchJson(`/api/agent/cases/${encodeURIComponent(caseId)}/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preferences ?? {})
  });
}

/** Unwrap a catalog entry to its raw case object. /api/cases returns { case_id, label, …, case: rawCase },
 *  but the pricing endpoints expect the raw case (with bill_of_lading, financing, etc.) directly. */
function rawCase(caseData) {
  return caseData?.case ?? caseData;
}

export function compareSpeeds(caseData, prefs = {}) {
  return postJson('/api/pricing/quote', { case: rawCase(caseData), compare: true, ...prefs });
}

/** BE-4: full RWA offering lifecycle. Pass speed, subscription, and in-transit events. */
export function simulateOffering(caseData, { payout_speed, subscription_usd, events, min_acceptable_issue_price } = {}) {
  return postJson('/api/offering/simulate', {
    case: rawCase(caseData),
    payout_speed,
    subscription_usd,
    min_acceptable_issue_price,
    events: events && events.length ? events : undefined
  });
}

/** BE-8: on-chain RiskPricingOracle.updatePricing payload (issue price + hashes). */
export function oracleUpdate(caseData, { payout_speed, pool_id } = {}) {
  return postJson('/api/oracle/pricing-update', { case: rawCase(caseData), payout_speed, pool_id });
}

/** MCP-5: mock/real push of the quote to the oracle — returns a tx + PricingUpdated event. */
export function pushPricingToOracle(caseId, quote) {
  return postJson('/api/mcp/call', {
    tool: 'push_pricing_to_oracle',
    params: { case_id: caseId, pricing_quote: quote }
  });
}

/** RAG: knowledge-base search over the macro risk-intel feed. */
export function ragSearch(query, categories) {
  return postJson('/api/rag/search', { query, categories });
}

/** RAG-2: pre-baked judge Q&A pairs. */
export async function getJudgeQA() {
  const data = await fetchJson('/api/rag/judge-qa');
  return data.pairs ?? [];
}

/** RAG: full sourced risk sweep for a case (route/weather/war/port/price/fx/buyer). */
export function riskSweep(caseData) {
  return postJson('/api/rag/risk-sweep', rawCase(caseData));
}

/** INTEL: live real-world risk via xAPI (tweets / officials / news / prediction markets)
 *  → structured events + signals + before/after re-priced quote. Offline-safe (fixtures w/o key). */
export function worldRisk(caseData) {
  return postJson('/api/intel/world-risk', { case: rawCase(caseData) });
}

/** AI-19: server-side recommendation over the market pools. `criteria` is optional structured input. */
export function marketSearch({ preference, criteria, limit } = {}) {
  return postJson('/api/market/search', { preference, criteria, limit });
}

/** BE-12: offchain mirror of one pool (status, subscription progress, current quote summary). */
export function getPoolStatus(poolId) {
  return fetchJson('/api/pool/status?pool_id=' + encodeURIComponent(poolId));
}

/** BE-13: the Demo subscriptions the server holds for a wallet. */
export function getPortfolio(walletAddress) {
  const query = walletAddress ? '?wallet_address=' + encodeURIComponent(walletAddress) : '';
  return fetchJson('/api/investors/portfolio' + query);
}

/** BE-12: record a Demo (simulated) subscription on the server. No transaction is sent. */
export function subscribePool({ pool_id, amount_usd, wallet_address }) {
  return postJson('/api/pool/subscribe', { pool_id, amount_usd, wallet_address });
}

/** BE-15: the server's persisted-in-memory agent activity feed. */
export function getAgentActivity({ caseId, poolId } = {}) {
  const params = new URLSearchParams();
  if (caseId) params.set('case_id', caseId);
  if (poolId) params.set('pool_id', poolId);
  const query = params.toString();
  return fetchJson('/api/agent/activity' + (query ? '?' + query : ''));
}

export function getPositions(wallet) { return fetchJson('/api/positions?wallet=' + encodeURIComponent(wallet)); }
