// Formatting shared by the Agent console panels.
import { getLang, t } from './i18n.js';

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

/** The decision verb, trigger and source as people read them; the raw code stays available for the audit trail. */
export const actionLabel = (action) => labelFor('ac_action_', action);
export const eventLabel = (type) => labelFor('ac_event_', type);
export const sourceLabel = (source) => labelFor('ac_src_', String(source).replaceAll('-', '_'));

/**
 * One policy hit in the reader's language. The server words each rule in English; the rules are a closed set,
 * so Chinese readers get a fixed sentence per rule (with the numbers the rule reported) and English readers
 * get the server text unchanged.
 */
export function policyReasonText(reason) {
  const message = String(reason?.message ?? '');
  if (getLang() !== 'zh') return message;
  const { rule, verdict } = reason;
  let key = `ac_policy_${rule}`, vars;
  if (rule === 'AUTONOMY') key = verdict === 'REJECTED' ? 'ac_policy_AUTONOMY_OFF' : 'ac_policy_AUTONOMY_OBSERVE';
  else if (rule === 'UNSAFE_FINDING') key = verdict === 'REJECTED' ? 'ac_policy_UNSAFE_BLOCK' : 'ac_policy_UNSAFE_REVIEW';
  else if (rule === 'AUTONOMY_LEVEL') key = verdict === 'AUTO' ? 'ac_policy_LEVEL_AUTO' : 'ac_policy_LEVEL_PROPOSE';
  else if (rule === 'COOLDOWN') key = message.includes('already had') ? 'ac_policy_COOLDOWN_DAILY' : 'ac_policy_COOLDOWN_REPEAT';
  else if (rule === 'PRICE_GUARD') {
    const move = /(-?[0-9.]+) bps exceeds the ([0-9.]+) bps/u.exec(message);
    const floor = /New price ([0-9.]+) is below the exporter's minimum ([0-9.]+)/u.exec(message);
    if (move) { key = 'ac_policy_PRICE_MOVE'; vars = { move: move[1], limit: move[2] }; }
    else if (floor) { key = 'ac_policy_PRICE_FLOOR'; vars = { price: floor[1], floor: floor[2] }; }
  }
  const text = t(key, vars);
  return text === key ? message : text;
}
