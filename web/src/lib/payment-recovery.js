const KEY = 'agentbl-x402-recovery-v1';
export function paymentRecoveryStorage() {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage; }
  catch { throw new Error('Payment recovery storage is unavailable; enable session storage before signing'); }
}
function journal(storage) {
  if (!storage) return {};
  const raw = storage.getItem(KEY);
  const parsed = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Payment recovery history is corrupt; reconcile existing payments before signing');
  return parsed;
}
export async function paymentRequestKey(endpoint, from, body) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const bytes = new TextEncoder().encode(JSON.stringify([endpoint, from.toLowerCase(), canonical(body ?? {})]));
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
}
export function readPaymentRecovery(storage, key, endpoint, from) {
  const entries = journal(storage), saved = entries[key];
  if (saved && (saved.endpoint !== endpoint || saved.from !== from.toLowerCase())) throw new Error('Payment recovery binding changed');
  if (!saved && Object.values(entries).some((entry) => !entry.completed && entry.endpoint === endpoint && entry.from === from.toLowerCase())) throw new Error('Reconcile the previous payment for this service before signing another request');
  return saved ?? null;
}
export function savePaymentRecovery(storage, key, record) {
  if (!storage) return;
  const entries = journal(storage);
  if (!entries[key] && Object.keys(entries).length >= 50) throw new Error('Payment recovery history is full; reconcile and export it before another payment');
  entries[key] = record; storage.setItem(KEY, JSON.stringify(entries));
}
export function reportAuthorization(reportId, storage = paymentRecoveryStorage()) {
  return Object.values(journal(storage)).find((entry) => entry.report_id === reportId)?.header ?? null;
}
