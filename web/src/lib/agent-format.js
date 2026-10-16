// Formatting shared by the Agent console panels.
import { t } from './i18n.js';

export const STATUS_TONE = {
  COMPLETED: 'ok', EXECUTING: 'info', PENDING_APPROVAL: 'warn', AWAITING_OWNER_SIGNATURE: 'warn',
  DECIDED: 'info', FAILED: 'crit', REJECTED: 'crit', SKIPPED: 'muted'
};

export const VERDICT_TONE = { AUTO: 'ok', NEEDS_APPROVAL: 'warn', OBSERVE_ONLY: 'muted', REJECTED: 'crit' };

export function shortId(id, head = 14, tail = 4) {
  const text = String(id ?? '');
  return text.length > head + tail + 1 ? `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ''}` : text;
}

export function formatTime(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour12: false }) : '—';
}

export function formatDateTime(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { hour12: false }) : '—';
}

export function usd(value, digits = 4) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(digits)}` : '—';
}

/** A translated label for a key family, or the raw value when there is no translation. */
export function labelFor(prefix, value) {
  const key = `${prefix}${value}`;
  return t(key) === key ? String(value) : t(key);
}
