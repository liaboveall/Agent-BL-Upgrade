// x402 AI report market for the selected case. Three ways to unlock a report:
//   - Demo smoke run: the server simulates the whole 402 → pay → settle flow (no wallet).
//   - Demo wallet: the wallet signs the 402 challenge (personal_sign, costs nothing); the server
//     unlocks the report and records a SIMULATED receipt, which is never shown as a transaction.
//   - Live: the wallet signs an EIP-3009 USDC authorization through the x402 V2 gateway; the
//     facilitator settles it on chain and the server attests the report.
import { createStore } from '../../state/store.js';
import { appStore } from '../../state/app-store.js';
import * as web3 from '../../lib/web3.js';
import { payV2WithWallet } from '../../lib/x402-v2.js';
import {
  completePaymentRecovery, exportPaymentJournal, journalEntries, paymentRecoveryStorage, reportAuthorization, voidPaymentRecovery
} from '../../lib/payment-recovery.js';
import { t } from '../../lib/i18n.js';

export const STEPS = ['challenge', 'pay', 'settle', 'unlock'];
const idleSteps = () => Object.fromEntries(STEPS.map((step) => [step, { status: 'idle', text: '—' }]));

export const x402Store = createStore({
  loaded: false,
  services: [],
  configured: false,
  network: 'eip155:1439',
  selectedId: 'premium-risk',
  running: false,
  steps: idleSteps(),
  log: [], // { text, tone, href? }
  payment: null, // data for the payment evidence card
  impact: null, // { before, after, delta }
  report: null, // { data, source } once unlocked
  purchased: [], // [{ entry, report, needsRecovery?, unavailable? }]
  pending: [], // unresolved Live payments from the persistent journal
  duplicate: false // the last purchase matched one already completed: offer a re-read or an explicit new snapshot
});

const set = (patch) => x402Store.set(patch);
const get = () => x402Store.get();

export function currentService(state = get()) {
  return state.services.find((service) => service.serviceId === state.selectedId)
    ?? state.services[0]
    ?? { serviceId: 'premium-risk', endpoint: '/api/x402/intel/premium-risk', priceUSDC: 0.001, title: 'Premium Risk Intelligence', description: 'Live world-risk signals + RAG deep analysis with full source citations', status: 'available' };
}

export function selectService(serviceId) {
  set({ selectedId: serviceId, report: null });
}

export function resetFlow() {
  set({ running: false, steps: idleSteps(), log: [], payment: null, impact: null, duplicate: false });
}

function step(name, status, text) {
  set((state) => ({ steps: { ...state.steps, [name]: { status, text: text || status } } }));
}

function log(text, tone = 'muted', href = null) {
  set((state) => ({ log: [...state.log, { text, tone, href }] }));
}

export function reportCountSummary(data) {
  if (data.service === 'premium-valuation') return t('x402_count_valuation', { comparables: data.historical_comparables?.length || 0, tools: data.tool_trace?.length || 0 });
  if (data.service === 'fraud-review') return t('x402_count_fraud', { checks: data.checks?.length || 0, issues: data.issues?.length || 0 });
  return t('x402_count_risk', { events: data.events?.length || data.intel_preview?.events_count || 0, rag: data.deepIntel?.length || data.intel_preview?.deep_intel_count || 0 });
}

export async function loadX402Config() {
  try {
    const res = await fetch('/api/x402/config');
    const data = await res.json();
    if (data.ok) {
      const selectedId = data.services.some((service) => service.serviceId === get().selectedId) ? get().selectedId : data.services[0]?.serviceId;
      set({ services: data.services, configured: data.configured, network: data.network, selectedId, loaded: true });
      return;
    }
  } catch { /* falls through */ }
  set({ services: [], configured: false, loaded: true });
}

// X402-11 re-read: remember purchased reports locally so a page refresh can re-open them within
// their TTL (the server re-serves them with no new charge).
const PURCHASES_KEY = 'agentbl.x402.purchases';

function loadPurchases() {
  let entries;
  try { entries = JSON.parse(localStorage.getItem(PURCHASES_KEY) || '[]'); } catch { entries = []; }
  const now = Date.now();
  // Drop locally-expired entries up front; the server is the final authority.
  const live = entries.filter((entry) => entry?.report_id && Date.parse(entry.expires_at || '') > now);
  if (live.length !== entries.length) savePurchases(live);
  return live;
}

function savePurchases(entries) {
  try { localStorage.setItem(PURCHASES_KEY, JSON.stringify(entries)); } catch { /* storage disabled */ }
}

function persistPurchase(envelope) {
  if (!envelope?.report_id || !envelope?.expires_at) return;
  const entries = loadPurchases().filter((entry) => entry.report_id !== envelope.report_id);
  entries.unshift({ report_id: envelope.report_id, expires_at: envelope.expires_at, kind: envelope.kind || 'premium-risk', case_id: envelope.case_id || null });
  savePurchases(entries.slice(0, 12));
}

// Live payer recovery session: memory only, bound to one wallet and runtime generation.
let recoverySession = null;
const recoveryHeaders = () => recoverySession && recoverySession.expires_at > Date.now() && recoverySession.generation === appStore.get().modeGeneration
  ? { 'x-x402-recovery': recoverySession.token } : null;
const journalSafe = () => { try { return journalEntries(); } catch { return []; } };

/**
 * Confirm each remembered report is still re-readable on the server (a 404 means its cache expired). In Live,
 * a report this tab cannot authorize stays listed as needing wallet recovery instead of disappearing, and a
 * read that fails for another reason stays listed as temporarily unavailable.
 */
export async function restorePurchases() {
  const entries = loadPurchases(), live = !appStore.get().demoMode;
  const probes = await Promise.all(entries.map(async (entry) => {
    try {
      const authorization = reportAuthorization(entry.report_id);
      const headers = authorization ? { 'PAYMENT-SIGNATURE': authorization } : live ? recoveryHeaders() : {};
      if (!headers) return { entry, report: null, needsRecovery: true };
      const res = await fetch(`/api/x402/report/${encodeURIComponent(entry.report_id)}`, { headers });
      if (res.ok) return { entry, report: await res.json() };
      if (res.status === 404) return null; // expired or unknown: the server is the authority
      return live && [401, 409].includes(res.status) ? { entry, report: null, needsRecovery: true } : { entry, report: null, unavailable: true };
    } catch {
      return { entry, report: null, unavailable: true }; // offline: keep it listed
    }
  }));
  savePurchases(entries);
  set({ purchased: probes.filter(Boolean), pending: journalSafe().filter((entry) => entry.status === 'pending') });
}

async function requestJson(url, { body, headers = {} } = {}) {
  const res = await fetch(url, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Server returned ${res.status}`), { code: data.code, status: res.status });
  return data;
}

/**
 * Live: prove control of the paying wallet with a one-time recovery signature (no funds, no payment), then
 * reconcile this browser's unresolved payments and re-open reports this tab cannot authorize. A payment the
 * server never received is void once its authorization window has passed.
 */
export async function recoverWithWallet() {
  if (get().running) return;
  const eth = web3.getEthereumProvider();
  if (!eth) { log(t('x402_live_wallet_required'), 'crit'); return; }
  set({ running: true });
  try {
    await ensureWallet();
    const [account] = await eth.request({ method: 'eth_requestAccounts' }), payer = String(account).toLowerCase();
    if (!recoveryHeaders() || recoverySession.payer !== payer) {
      log(t('x402_recover_sign_prompt'), 'accent');
      const challenge = await requestJson('/api/x402/recovery/challenges', { body: { payer: account } });
      const typed = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }], ...challenge.types },
        primaryType: 'PaidReportRecovery', domain: challenge.domain, message: challenge.message };
      const signature = await eth.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typed)] });
      const opened = await requestJson('/api/x402/recovery/sessions', { body: { challenge_id: challenge.challenge_id, signature } });
      recoverySession = { token: opened.token, payer: opened.payer, expires_at: opened.expires_at, generation: appStore.get().modeGeneration };
    }
    const headers = recoveryHeaders(), storage = paymentRecoveryStorage();
    const { payments } = await requestJson('/api/x402/recovery/payments', { headers });
    const counts = { delivered: 0, unspent: 0, open: 0 };
    for (const entry of journalSafe().filter((item) => item.status === 'pending' && item.from === payer)) {
      const payment = payments.find((item) => item.nonce?.toLowerCase() === String(entry.nonce).toLowerCase());
      if (!payment) {
        // Never received by the server, so never submitted: void once nobody can use it any more.
        if (Number(entry.valid_before) * 1000 < Date.now()) { voidPaymentRecovery(storage, entry.key); counts.unspent++; } else counts.open++;
        continue;
      }
      const result = await requestJson(`/api/x402/recovery/payments/${payment.payment_id}`, { headers, body: payment.report_id ? {} : { request: entry.request ?? {} } });
      if (result.status === 'delivered') {
        completePaymentRecovery(storage, entry.key, result.report?.report_envelope?.report_id ?? null);
        persistPurchase(result.report?.report_envelope); counts.delivered++;
      } else if (result.status === 'expired_unspent') { voidPaymentRecovery(storage, entry.key); counts.unspent++; }
      else counts.open++;
    }
    // Reports this wallet bought in another browser or tab that this one does not list yet.
    const known = new Set(loadPurchases().map((entry) => entry.report_id));
    for (const payment of payments.filter((item) => item.report_id && !known.has(item.report_id)).slice(0, 12)) {
      try { persistPurchase((await requestJson(`/api/x402/report/${encodeURIComponent(payment.report_id)}`, { headers })).report_envelope); counts.delivered++; }
      catch { /* expired or awaiting reconciliation: it stays in the server list */ }
    }
    log(t('x402_recover_done', counts), counts.open ? 'warn' : 'ok');
    if (counts.open) log(t('x402_recover_open_hint'), 'warn');
    await restorePurchases();
  } catch (error) {
    log(t('x402_fail_log', { msg: error.message }), 'crit');
    if (error.code === 4001 || error.code === 'ACTION_REJECTED' || error.code === 'REJECTED') log(t('x402_user_rejected'), 'warn');
  } finally {
    set({ running: false });
  }
}

/** A signature-free JSON copy of this browser's payment journal, for manual reconciliation. */
export function exportJournal() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(exportPaymentJournal(), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `agentbl-x402-payments-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function paymentCard(data) {
  const pay = data.payment ?? {};
  // The smoke flow nests these under `receipt`; the unlocked/cached report body carries them at the top level.
  const serviceId = pay.receipt?.serviceId ?? pay.serviceId;
  const amountUSDC = pay.receipt?.amountUSDC ?? pay.amountUSDC;
  // A Demo receipt hash is simulated; only a Live (on-chain) one is shown as a hash.
  const simulated = pay.live === false || pay.onchain === false || pay.mode === 'demo';
  return {
    tx: pay.txHash ? (simulated ? t('x402_demo_receipt_ref', { ref: pay.txHash.slice(0, 18) + '…' }) : pay.txHash.slice(0, 42) + '…') : '—',
    simulated,
    service: serviceId || data.service || data.kind || '—',
    amount: amountUSDC !== undefined ? `${amountUSDC} USDC` : '—',
    reportHash: (pay.evidence?.responseHash ?? data.report_envelope?.report_hash)?.slice(0, 42) ?? '—'
  };
}

function pricingImpact(data) {
  const preview = data.intel_preview ?? (data.before_quote || data.after_quote ? {
    before_price: data.before_quote?.final_issue_price_usd,
    after_price: data.after_quote?.final_issue_price_usd,
    price_delta: data.delta?.issue_price_delta_usd ?? data.delta?.issue_price_usd,
    before_risk: data.before_quote?.risk_level,
    after_risk: data.after_quote?.risk_level
  } : null);
  if (!preview || (preview.before_price === undefined && preview.after_price === undefined)) return null;
  return { before: preview.before_price, after: preview.after_price, delta: preview.price_delta, beforeRisk: preview.before_risk ?? preview.risk_before, afterRisk: preview.after_risk ?? preview.risk_after };
}

function unlocked(data, source) {
  step('pay', 'done', t('x402_signed'));
  step('settle', 'done', t('x402_settled'));
  step('unlock', 'done', t('x402_unlocked'));
  set({ payment: paymentCard(data), impact: pricingImpact(data), report: { data, source }, ...(data.service ? { selectedId: data.service } : {}) });
}

/** Re-open an already-paid report without re-running the 402 flow. */
export function reopenReport(data) {
  resetFlow();
  step('challenge', 'done', t('x402_challenge_status'));
  unlocked(data, 'cache');
  log(`${t('x402_purchased_reread')} — ${data.report_envelope?.report_id?.slice(0, 18) || ''}…`, 'ok');
}

const caseBody = () => {
  const { caseData, caseId } = appStore.get();
  return { case: caseData, case_id: caseId };
};

/** Demo only: the server simulates every step; nothing is signed or settled. */
export async function runSmoke() {
  if (get().running) return;
  const service = currentService();
  resetFlow();
  set({ running: true });
  log(t('x402_running'));
  try {
    step('challenge', 'active', t('x402_challenge_status'));
    log(t('x402_challenge_log'), 'accent');
    step('pay', 'active', t('x402_signing_status'));
    log(t('x402_demo_signing_log'), 'accent');
    step('settle', 'active', t('x402_settling_status'));
    log(t('x402_demo_settlement_log'), 'info');
    const res = await fetch('/api/x402/smoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ locale: 'en', serviceId: service.serviceId, case: appStore.get().caseData })
    });
    const data = await res.json();
    if (!data.ok) {
      step('unlock', 'error', t('x402_failed'));
      log(t('x402_fail_log', { msg: data.error || t('x402_error') }), 'crit');
      return;
    }
    step('challenge', 'done', t('x402_challenge_status'));
    unlocked(data);
    log(t('x402_unlocked_log', { summary: reportCountSummary(data) }), 'ok');
    if (data.payment?.txHash) log(`${t('x402_tx_log', { tx: data.payment.txHash.slice(0, 42) + '…' })} [${data.payment.live ? t('x402_onchain_tag') : t('x402_mock_tag')}]`, data.payment.live ? 'ok' : 'warn');
    log(t('x402_pass'), 'ok');
  } catch (error) {
    step('settle', 'error', t('x402_failed'));
    log(t('x402_fail_log', { msg: error.message }), 'crit');
  } finally {
    set({ running: false });
  }
}

/** `renew`: Live only — buy the same request again as a new snapshot (a new payment) instead of re-reading it. */
export async function purchase({ renew = false } = {}) {
  if (get().running) return;
  const service = currentService();
  if (appStore.get().demoMode) await purchaseWithWalletDemo(service.endpoint);
  else await purchaseWithWalletLive(Number(service.priceUSDC), service.endpoint, { renew });
}

async function ensureWallet() {
  if (web3.isWalletConnected()) return;
  const { address } = await web3.connectWallet();
  appStore.set({ wallet: { address } });
}

/**
 * Demo wallet flow. Nothing is settled on-chain:
 *   1. GET endpoint → HTTP 402 + challenge
 *   2. the wallet signs the challenge with personal_sign (proves wallet control, costs nothing)
 *   3. POST the signature → the server unlocks the report and records a SIMULATED receipt
 * The receipt is labelled DEMO and never rendered as a link.
 */
async function purchaseWithWalletDemo(endpoint) {
  resetFlow();
  log(t('x402_initiating'));
  const eth = web3.getEthereumProvider();
  if (!eth) {
    log(t('x402_demo_no_wallet'), 'crit');
    step('pay', 'error', t('x402_no_wallet_status'));
    return;
  }
  set({ running: true });
  try {
    step('challenge', 'active', t('x402_challenge_status'));
    log(t('x402_challenge_log'), 'accent');
    const unpaidRes = await fetch(endpoint, { headers: { Accept: 'application/json' } });
    if (unpaidRes.status !== 402) throw new Error(`Expected HTTP 402, got ${unpaidRes.status}`);
    const unpaidBody = await unpaidRes.json();
    const { challenge, nonce } = unpaidBody;
    if (!challenge) throw new Error('No challenge message in 402 response');
    step('challenge', 'done', t('x402_challenge_status'));
    log(t('x402_challenge_received', { challenge: String(challenge).slice(0, 60) }), 'accent');

    step('pay', 'active', t('x402_signing_status'));
    log(t('x402_demo_sign_prompt'), 'accent');
    try { await ensureWallet(); } catch (error) {
      if (error.code === 'REJECTED') throw Object.assign(new Error('User rejected wallet connection'), { code: 'REJECTED' });
      throw error;
    }
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    const signerAddr = accounts[0];
    const signature = await eth.request({ method: 'personal_sign', params: [challenge, signerAddr] });
    log(t('x402_signed_by', { signer: `${signerAddr.slice(0, 8)}…${signerAddr.slice(-4)}` }), 'ok');

    // Demo settlement happens on the server (simulated, no transaction).
    step('settle', 'active', t('x402_settling_status'));
    log(t('x402_demo_settlement_log'), 'info');
    const paidRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X402-Signature': signature, 'X402-Signer': signerAddr },
      body: JSON.stringify({ nonce, ...caseBody() })
    });
    if (!paidRes.ok) {
      const errBody = await paidRes.json().catch(() => ({}));
      throw new Error(errBody.error || `Server returned ${paidRes.status}`);
    }
    const data = await paidRes.json();
    unlocked(data);
    // Remember this report so a refresh can re-open it within its TTL.
    if (data.report_envelope) { persistPurchase(data.report_envelope); restorePurchases(); }
    log(t('x402_unlocked_log', { summary: reportCountSummary(data) }), 'ok');
    // The Demo receipt is simulated: shown as such, with no link and no claim that a transaction came from the wallet.
    log(t('x402_demo_receipt_note', { payer: `${signerAddr.slice(0, 10)}…${signerAddr.slice(-6)}` }), 'warn');
    log(t('x402_demo_complete'), 'ok');
  } catch (error) {
    step('settle', 'error', t('x402_failed'));
    log(t('x402_fail_log', { msg: error.message }), 'crit');
    if (error.code === 4001 || error.code === 'REJECTED') log(t('x402_user_rejected'), 'warn');
  } finally {
    set({ running: false });
  }
}

/**
 * Live mode: pay through the x402 V2 gateway. The connected wallet signs an EIP-3009 USDC transfer
 * authorization (eth_signTypedData_v4); the facilitator settles it on chain and the server attests
 * the report. The price the server asks must equal the price shown here, otherwise nothing is signed.
 */
async function purchaseWithWalletLive(priceUSDC, endpoint, { renew = false } = {}) {
  resetFlow();
  log(t('x402_initiating'));
  const eth = web3.getEthereumProvider();
  if (!eth) {
    log(t('x402_live_wallet_required'), 'crit');
    step('pay', 'error', t('x402_no_wallet_status'));
    return;
  }
  set({ running: true });
  try {
    await ensureWallet();
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    const { response, replayed } = await payV2WithWallet({
      endpoint,
      body: caseBody(),
      provider: eth,
      from: accounts[0],
      renew,
      expectedAmountAtomic: Math.round(Number(priceUSDC) * 1_000_000),
      onStage: (stage) => {
        if (stage === 'challenge') {
          step('challenge', 'active', t('x402_challenge_status'));
          log(t('x402_challenge_log'), 'accent');
        } else if (stage === 'sign') {
          step('challenge', 'done', t('x402_challenge_status'));
          step('pay', 'active', t('x402_signing_status'));
          log(t('x402_live_sign_prompt'), 'accent');
        } else if (stage === 'settle') {
          step('pay', 'done', t('x402_signed'));
          step('settle', 'active', t('x402_settling_status'));
          log(t('x402_settlement_log'), 'info');
        } else if (stage === 'reconcile') {
          step('settle', 'active', t('x402_reconciling'));
          log(t('x402_recovery_log'), 'info');
        }
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Server returned ${response.status}`);
    unlocked(data);
    if (replayed && !renew) { set({ duplicate: true }); log(t('x402_already_purchased'), 'info'); }
    if (data.report_envelope) persistPurchase(data.report_envelope);
    restorePurchases();
    log(t('x402_unlocked_log', { summary: reportCountSummary(data) }), 'ok');
    for (const [labelKey, url] of [['x402_payment_link', data.payment?.explorerUrl], ['x402_attestation_link', data.payment?.attestationExplorerUrl]]) {
      // Only ever link to an https explorer page that came back from the chain layer.
      if (typeof url === 'string' && /^https:\/\//iu.test(url)) log(t(labelKey), 'ok', url);
    }
    log(t('x402_pass'), 'ok');
  } catch (error) {
    if (error.code === 'purchase_recovery_required') {
      step('settle', 'done', t('x402_reconciling'));
      set({ duplicate: true }); log(t('x402_already_purchased'), 'info'); log(t('x402_recover_needed'), 'warn');
    } else if (error.code === 'payment_recovery_required') {
      step('settle', 'error', t('x402_reconciling'));
      log(t('x402_recover_needed'), 'warn');
    } else {
      step('settle', 'error', t('x402_failed'));
      log(t('x402_fail_log', { msg: error.message }), 'crit');
      if (error.code === 4001 || error.code === 'ACTION_REJECTED' || error.code === 'REJECTED') log(t('x402_user_rejected'), 'warn');
    }
    restorePurchases();
  } finally {
    set({ running: false });
  }
}
