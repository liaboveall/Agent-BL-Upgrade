import crypto from 'node:crypto';

const SECRET_KEY = /(?:private.?key|api.?key|password|secret|mnemonic|seed.?phrase|authorization|admin.?token|access.?token|refresh.?token|^token$)/iu;
const RAW_KEY = /^(?:text|raw_text|content|content_base64|prompt|output|raw_document|document_text)$/iu;
const HASH_KEY = /(?:hash|sha256|root|proof|signature|^evidence$|^data_hash$|^decision_id$|^event_id$|^version_id$|^code_commit$|^idempotency_key$|^explorer_url$)/iu;

export function redactText(value, { hash = false } = {}) {
  let text = String(value).replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gu, '[REDACTED]');
  if (!hash) text = text.replace(/\b(?:0x)?[0-9a-fA-F]{64}\b/gu, '[REDACTED]');
  return text.replace(/\b0x[0-9a-fA-F]{40}\b/gu, (address) => `${address.slice(0, 6)}…${address.slice(-4)}`);
}

/** Audit projection only. Exact operational addresses belong in the encrypted sidecar. */
export function sanitizeAudit(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (RAW_KEY.test(key)) return '[CONTENT OMITTED]';
  if (typeof value === 'string') return redactText(value, { hash: HASH_KEY.test(key) });
  if (Array.isArray(value)) return value.map((item) => sanitizeAudit(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [redactText(name), sanitizeAudit(item, name)]));
  return value;
}

// Secrets and source document text never enter the operational journal either.
export function stripSecretFields(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (RAW_KEY.test(key)) return '[CONTENT OMITTED]';
  if (typeof value === 'string') return value.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gu, '[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => stripSecretFields(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, stripSecretFields(item, name)]));
  return value;
}

export function sealRecords(records, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(records), 'utf8'), cipher.final()]);
  return { schema: 'agent-private-v1', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}

export function openRecords(sealed, key) {
  if (sealed.schema !== 'agent-private-v1') throw new Error('Unsupported private journal');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8'));
}
