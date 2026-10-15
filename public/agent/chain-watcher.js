import { el } from '../dom.js';
import { t } from '../i18n.js';
import { badge, formatTime, kv } from './ui.js';

export function watcherStatus(status) {
  const watcher = status.chain_watcher ?? { state: 'disabled' };
  const states = ['disabled', 'inactive', 'idle', 'healthy', 'catching-up', 'waiting-confirmations', 'degraded'];
  const state = states.includes(watcher.state) ? watcher.state : 'idle';
  const tone = state === 'degraded' ? 'tone-err' : state === 'healthy' ? 'tone-ok' : 'tone-muted';
  return el('div', { class: 'ac-chain-watcher', 'data-watcher-state': state,
    'data-last-block': String(watcher.last_block ?? ''), 'data-chain-stop': String(Boolean(status.emergency_stop_sources?.chain)) },
    kv(t('ac_chain_watcher'), badge(t(`ac_chain_${state}`), tone)),
    watcher.enabled && status.mode === 'live' ? [
      kv(t('ac_chain_progress'), t('ac_chain_progress_value', { block: watcher.last_block ?? '—', lag: watcher.lag_blocks ?? '—', confirmations: watcher.confirmations })),
      watcher.retry_at ? kv(t('ac_chain_retry'), formatTime(watcher.retry_at)) : null,
      watcher.reconciliation_required ? el('p', { class: 'ac-error ac-small', role: 'status' }, t('ac_chain_reconcile')) : null,
      status.emergency_stop_sources?.chain ? el('p', { class: 'ac-error ac-small' }, t('ac_chain_stop_hint')) : null,
      status.emergency_stop_sources?.chain_unknown ? el('p', { class: 'muted ac-small' }, t('ac_chain_unknown_hint')) : null
    ] : null);
}
