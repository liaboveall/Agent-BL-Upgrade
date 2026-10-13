// Small view helpers shared by the Agent console modules. Everything dynamic goes in through el()
// (text nodes), never HTML strings: decisions carry values that came from events and the chain.

import { el } from '../dom.js';
import { t } from '../i18n.js';

const STATUS_TONE = {
  COMPLETED: 'tone-ok',
  EXECUTING: 'tone-info',
  PENDING_APPROVAL: 'tone-warn',
  AWAITING_OWNER_SIGNATURE: 'tone-warn',
  DECIDED: 'tone-info',
  FAILED: 'tone-err',
  REJECTED: 'tone-err',
  SKIPPED: 'tone-muted'
};

const VERDICT_TONE = { AUTO: 'tone-ok', NEEDS_APPROVAL: 'tone-warn', OBSERVE_ONLY: 'tone-muted', REJECTED: 'tone-err' };

export function badge(text, tone = 'tone-muted', title) {
  return el('span', { class: `badge sm ac-badge ${tone}`, title }, text);
}

export function statusBadge(status) {
  return badge(t(`ac_status_${status}`) === `ac_status_${status}` ? status : t(`ac_status_${status}`), STATUS_TONE[status] ?? 'tone-muted');
}

export function verdictBadge(verdict) {
  return badge(t(`ac_verdict_${verdict}`) === `ac_verdict_${verdict}` ? verdict : t(`ac_verdict_${verdict}`), VERDICT_TONE[verdict] ?? 'tone-muted');
}

export function modeBadge(mode) {
  return badge(String(mode ?? '').toUpperCase(), mode === 'live' ? 'tone-ok' : 'tone-muted');
}

export function shortId(id, head = 14, tail = 4) {
  const text = String(id ?? '');
  return text.length > head + tail + 1 ? `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ''}` : text;
}

export function formatTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

export function formatDateTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, { hour12: false });
}

/** A small button that copies `value` and says so; falls back silently when the clipboard is unavailable. */
export function copyButton(value, label = t('ac_copy')) {
  const button = el('button', { class: 'ac-copy', type: 'button', title: label, 'aria-label': label, 'data-focus-key': `copy:${value}` }, '⧉');
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(value));
      button.textContent = '✓';
      setTimeout(() => { button.textContent = '⧉'; }, 1200);
    } catch {
      button.textContent = '!';
      setTimeout(() => { button.textContent = '⧉'; }, 1200);
    }
  });
  return button;
}

export function kv(label, value) {
  return el('div', { class: 'ac-kv' },
    el('span', { class: 'ac-kv-k' }, label),
    el('span', { class: 'ac-kv-v' }, value ?? '—'));
}

export function section(title, ...children) {
  return el('section', { class: 'ac-section' }, el('h4', {}, title), ...children);
}

export function usd(value, digits = 4) {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number.toFixed(digits)}` : '—';
}
