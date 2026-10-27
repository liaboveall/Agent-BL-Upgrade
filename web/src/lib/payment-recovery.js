// Browser x402 payment recovery, kept in two stores with different lifetimes:
//   - the journal (localStorage) holds what a later tab needs to find and finish a payment, and nothing that
//     can spend or prove it: endpoint, payer, terms, the authorization nonce and window, the request body while
//     the payment is unresolved, and the report id once delivered;
//   - the signed PAYMENT-SIGNATURE stays in sessionStorage for in-tab replay only. Another tab recovers the
//     payment with a one-time wallet-signed recovery request instead (see /api/x402/recovery).
// Unresolved payments are few and block another signature until reconciled. Completed and unspent ones are
// kept for a retention period, pruned oldest first, and never block a purchase.
const JOURNAL_KEY = 'agentbl-x402-journal-v2';
const SECRET_KEY = 'agentbl-x402-recovery-v1';
export const MAX_PENDING_PAYMENTS = 10;
export const MAX_SETTLED_RECORDS = 100;
export const SETTLED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function paymentRecoveryStorage() {
  if (typeof window === 'undefined') return null;
  try { return { journal: window.localStorage, secrets: window.sessionStorage }; }
  catch { throw new Error('Payment recovery storage is unavailable; enable site storage before signing'); }
}
// Tests and tools may pass one Storage-like object for both.
const stores = (storage) => !storage ? null : storage.journal ? storage : { journal: storage, secrets: storage };

function readObject(storage, key, corrupt) {
  const raw = storage.getItem(key);
  const parsed = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(corrupt);
  return parsed;
}
function journal(storage) {
  const parsed = readObject(storage.journal, JOURNAL_KEY, 'Payment recovery history is corrupt; export it and reconcile existing payments before signing');
  if (parsed.entries && (typeof parsed.entries !== 'object' || Array.isArray(parsed.entries))) throw new Error('Payment recovery history is corrupt; export it and reconcile existing payments before signing');
  return parsed.entries ?? {};
}
function secrets(storage) {
  return readObject(storage.secrets, SECRET_KEY, 'Payment recovery history is corrupt; reconcile existing payments before signing');
}
const headerOf = (value) => typeof value === 'string' ? value : value?.header ?? null; // v1 kept whole records here

/** Completed and unspent records past retention, or beyond the cap (oldest first), are dropped with their signatures. */
export function pruneJournal(entries, now = Date.now()) {
  const settled = Object.entries(entries).filter(([, entry]) => entry.status !== 'pending')
    .sort(([, left], [, right]) => String(right.updated_at).localeCompare(String(left.updated_at)));
  return settled.filter(([, entry], index) => index >= MAX_SETTLED_RECORDS || Date.parse(entry.updated_at) + SETTLED_RETENTION_MS <= now).map(([key]) => key);
}
function write(storage, entries, secretValues, now = Date.now()) {
  for (const key of pruneJournal(entries, now)) { delete entries[key]; delete secretValues[key]; }
  storage.journal.setItem(JOURNAL_KEY, JSON.stringify({ version: 2, entries }));
  storage.secrets.setItem(SECRET_KEY, JSON.stringify(secretValues));
}

export async function paymentRequestKey(endpoint, from, body) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const bytes = new TextEncoder().encode(JSON.stringify([endpoint, from.toLowerCase(), canonical(body ?? {})]));
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * The saved payment for this exact request, with this tab's signature when it has one. Refuses, before any
 * signature, a second unresolved payment for the same service and wallet, or more unresolved payments than
 * the cap. Completed records never block.
 */
export function readPaymentRecovery(storage, key, endpoint, from) {
  const pair = stores(storage), entries = journal(pair), saved = entries[key], payer = from.toLowerCase();
  if (saved && (saved.endpoint !== endpoint || saved.from !== payer)) throw new Error('Payment recovery binding changed');
  const pending = Object.values(entries).filter((entry) => entry.status === 'pending');
  if (!saved && pending.some((entry) => entry.endpoint === endpoint && entry.from === payer)) throw new Error('Reconcile the previous payment for this service before signing another request');
  if (!saved && pending.length >= MAX_PENDING_PAYMENTS) throw new Error(`${pending.length} payments still need reconciliation; recover or export them before signing another`);
  return saved ? { ...saved, header: headerOf(secrets(pair)[key]) } : null;
}

/** Durable before the paid request is sent: the journal entry first, then this tab's signature. */
export function savePaymentRecovery(storage, key, record, now = Date.now()) {
  const pair = stores(storage);
  if (!pair) return;
  const entries = journal(pair), secretValues = secrets(pair);
  const { header, requirement, authorization, request, ...rest } = record;
  const at = new Date(now).toISOString(), previous = entries[key];
  entries[key] = { ...previous, ...rest, key,
    ...(requirement ? { network: requirement.network, asset: requirement.asset, amount: String(requirement.amount), pay_to: requirement.payTo, requirement } : {}),
    ...(authorization ? { nonce: authorization.nonce, valid_before: authorization.validBefore, authorization } : {}),
    ...(rest.status === 'pending' && request !== undefined ? { request } : {}),
    created_at: previous?.created_at ?? at, updated_at: at };
  if (entries[key].status !== 'pending') delete entries[key].request; // the body is only needed to finish delivery
  if (header) secretValues[key] = header;
  write(pair, entries, secretValues, now);
}

export function completePaymentRecovery(storage, key, reportId, now = Date.now()) {
  savePaymentRecovery(storage, key, { status: 'completed', report_id: reportId ?? null, completed_at: new Date(now).toISOString() }, now);
}
/** The authorization expired without being spent: no charge, and the request may be bought again. */
export function voidPaymentRecovery(storage, key, now = Date.now()) {
  savePaymentRecovery(storage, key, { status: 'void' }, now);
}
/** Keep a finished record under its own key so the same request can be bought again as a new snapshot. */
export function archivePaymentRecovery(storage, key, now = Date.now()) {
  const pair = stores(storage), entries = journal(pair), secretValues = secrets(pair), entry = entries[key];
  if (!entry || entry.status === 'pending') throw new Error('Only a completed or unspent payment can be archived');
  const archived = `${key}~${entry.created_at}`;
  entries[archived] = { ...entry, key: archived, archived: true }; delete entries[key];
  if (secretValues[key]) { secretValues[archived] = secretValues[key]; delete secretValues[key]; }
  write(pair, entries, secretValues, now);
}

export function journalEntries(storage = paymentRecoveryStorage()) {
  const pair = stores(storage);
  return pair ? Object.values(journal(pair)).sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))) : [];
}
export function pendingPayments(storage = paymentRecoveryStorage()) {
  return journalEntries(storage).filter((entry) => entry.status === 'pending');
}
/** A downloadable, signature-free copy of the journal for manual reconciliation. */
export function exportPaymentJournal(storage = paymentRecoveryStorage()) {
  return { schema: 'agentbl-x402-payment-journal-v2', exported_at: new Date().toISOString(),
    note: 'Contains no payment signature. Recover a payment with the paying wallet; this file alone cannot spend or prove it.',
    entries: journalEntries(storage).map(({ request: _request, ...entry }) => entry) };
}
export function reportAuthorization(reportId, storage = paymentRecoveryStorage()) {
  const pair = stores(storage);
  if (!pair) return null;
  const key = Object.values(journal(pair)).find((entry) => entry.report_id === reportId)?.key;
  return key ? headerOf(secrets(pair)[key]) : null;
}
