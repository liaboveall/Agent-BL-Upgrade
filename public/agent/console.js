// Agent console (FE-13): what the agent runtime is doing, what it decided and why, and what is waiting
// for a human. Every row comes from the server's decision log and activity feed; nothing is invented
// here. Updates arrive over the activity SSE stream (the browser resumes it with Last-Event-ID), with
// a slow poll as a safety net.

import { clear, el, toast } from '../dom.js';
import { t } from '../i18n.js';
import { agent, safeExplorerUrl } from './api.js';
import { approvalControls, renderApprovalsPanel } from './approvals.js';
import { showDecisionDetail } from './decision-detail.js';
import { renderInjector } from './injector.js';
import { badge, copyButton, formatTime, kv, modeBadge, shortId, statusBadge, verdictBadge } from './ui.js';

const POLL_MS = 10_000;
const REFRESH_DEBOUNCE_MS = 250;
const TIMELINE_LIMIT = 40;

const view = {
  active: false,
  stream: null,
  pollTimer: null,
  refreshTimer: null,
  refreshing: false,
  status: null,
  decisions: [],
  protectedCases: new Set(),
  cases: [],
  selectedCase: null,
  filters: { status: '', action: '' },
  openDecisionId: null,
  wired: false,
  getCases: async () => []
};

const $ = (selector) => document.querySelector(selector);

export function initAgentConsole({ getCases }) {
  view.getCases = getCases;
}

export async function openAgentDecision(id) {
  await showAgentConsole();
  await openDrawer(id);
}

// ------------------------------------------------------------------ status + controls

function statusCard(status) {
  const root = $('#ac-status');
  if (!root) return;
  clear(root);
  if (!status) {
    root.append(el('p', { class: 'muted' }, t('ac_loading')));
    return;
  }
  const autonomy = status.autonomy;
  const signers = Object.entries(status.signers ?? {});
  root.append(
    el('header', { class: 'ac-panel-head' }, el('h3', {}, t('ac_status_h')), badge(status.running ? t('ac_running') : t('ac_stopped'), status.running ? 'tone-ok' : 'tone-muted')),
    el('div', { class: 'ac-kvlist' },
      kv(t('ac_mode'), el('span', {}, modeBadge(status.mode), ' ', badge(status.executor === 'chain' ? 'CHAIN' : 'SIM', status.executor === 'chain' ? 'tone-ok' : 'tone-muted', status.executor === 'chain' ? t('ac_exec_chain') : t('ac_exec_demo')))),
      kv(t('ac_autonomy'), el('span', {}, autonomy.effective,
        autonomy.downgraded ? [' ', badge(t('ac_downgraded'), 'tone-warn', t('ac_downgraded_hint'))] : null)),
      kv(t('ac_monitor'), t('ac_monitor_value', { sec: status.scheduler.interval_sec })),
      kv(t('ac_last_tick'), status.scheduler.last_tick_at ? formatTime(status.scheduler.last_tick_at) : '—'),
      kv(t('ac_next_tick'), status.scheduler.next_tick_at ? formatTime(status.scheduler.next_tick_at) : '—'),
      kv(t('ac_queue'), t('ac_queue_value', { queued: status.queue.queued, processing: status.queue.processing, dead: status.queue.dead })),
      kv(t('ac_signers'), el('span', { class: 'ac-signers' }, signers.map(([role, info]) =>
        badge(`${role} ${info.configured ? '✓' : '—'}`, info.configured ? 'tone-ok' : 'tone-muted')))),
      kv(t('ac_pending'), t('ac_pending_value', { pending: status.pending_approvals, owner: status.awaiting_owner_signature })),
      kv(t('ac_emergency'), status.emergency_stop ? badge(t('ac_emergency_on'), 'tone-err') : badge(t('ac_emergency_off'), 'tone-muted')),
      status.last_error ? kv(t('ac_last_error'), el('span', { class: 'ac-error' }, status.last_error.message)) : null));
}

function controlsCard(status) {
  const root = $('#ac-controls');
  if (!root) return;
  clear(root);
  const run = async (body, doneKey) => {
    try {
      await agent.control(body);
      toast(t(doneKey));
    } catch (error) {
      toast(error.message, true);
    }
    await refresh();
  };
  const select = el('select', { id: 'ac-autonomy', class: 'ac-select', 'aria-label': t('ac_autonomy') },
    ['off', 'observe', 'propose', 'auto'].map((level) => el('option', { value: level, selected: level === (status?.autonomy.effective ?? 'propose') }, level)));
  select.addEventListener('change', () => run({ action: 'set_autonomy', autonomy: select.value }, 'ac_autonomy_set'));
  root.append(
    el('header', { class: 'ac-panel-head' }, el('h3', {}, t('ac_controls_h'))),
    el('div', { class: 'ac-actions ac-wrap' },
      el('button', { class: 'btn ghost', type: 'button', onclick: () => run({ action: status?.running ? 'stop' : 'start' }, status?.running ? 'ac_stopped_toast' : 'ac_started_toast') }, status?.running ? t('ac_stop') : t('ac_start')),
      el('button', { class: 'btn ghost', type: 'button', onclick: () => run({ action: 'tick' }, 'ac_tick_toast') }, t('ac_tick')),
      el('button', {
        class: `btn ${status?.emergency_stop ? '' : 'ghost'} ac-danger`, type: 'button',
        onclick: () => run({ action: 'emergency_stop', stopped: !status?.emergency_stop }, status?.emergency_stop ? 'ac_emergency_lifted' : 'ac_emergency_set')
      }, status?.emergency_stop ? t('ac_emergency_lift') : t('ac_emergency_stop'))),
    el('label', { class: 'ac-field', for: 'ac-autonomy' }, el('span', {}, t('ac_autonomy')), select),
    el('p', { class: 'muted ac-small' }, status?.mode === 'live' ? t('ac_live_note') : t('ac_demo_note')));
}

// ------------------------------------------------------------------ timeline

function triggerLabel(decision) {
  return `${decision.event_type}`;
}

function txCell(decision) {
  const execution = decision.execution;
  if (!execution) return el('span', { class: 'muted' }, '—');
  const link = safeExplorerUrl(execution.explorer_url);
  if (execution.tx_hash) {
    return link
      ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', onclick: (event) => event.stopPropagation() }, `${shortId(execution.tx_hash, 8, 6)} ↗`)
      : el('code', {}, shortId(execution.tx_hash, 8, 6));
  }
  if (execution.reference) return el('span', {}, badge(t('ac_simulated'), 'tone-warn', t('ac_simulated_hint')), ' ', el('code', { class: 'muted' }, shortId(execution.reference, 14, 0)));
  return el('span', { class: 'muted' }, '—');
}

function timelineRow(decision) {
  const row = el('button', {
    class: `ac-row${decision.decision_id === view.openDecisionId ? ' is-open' : ''}`, type: 'button',
    'aria-label': `${decision.action} ${decision.case_id}`,
    onclick: () => openDrawer(decision.decision_id)
  },
  el('span', { class: 'ac-row-time' }, formatTime(decision.created_at)),
  el('span', { class: 'ac-row-trigger' },
    el('span', {}, triggerLabel(decision)),
    el('span', { class: 'muted ac-small' }, decision.case_id),
    el('span', { class: 'ac-row-badges' }, modeBadge(decision.mode), view.protectedCases.has(decision.case_id) ? badge(t('ac_protected'), 'tone-warn', t('ac_protected_hint')) : null)),
  el('span', { class: 'ac-row-action' }, el('strong', {}, decision.action), decision.proposed_action && decision.proposed_action !== decision.action ? el('span', { class: 'muted ac-small' }, `(${decision.proposed_action})`) : null),
  el('span', { class: 'ac-row-state' }, verdictBadge(decision.policy?.verdict), statusBadge(decision.status)),
  el('span', { class: 'ac-row-tx' }, txCell(decision)),
  el('span', { class: 'ac-row-id' }, el('code', {}, shortId(decision.decision_id, 11, 4)), copyButton(decision.decision_id)));
  return row;
}

function timelineCard() {
  const root = $('#ac-timeline');
  if (!root) return;
  clear(root);
  const actions = [...new Set(view.decisions.map((decision) => decision.action))].sort();
  const statuses = [...new Set(view.decisions.map((decision) => decision.status))].sort();
  const filtered = view.decisions.filter((decision) => (!view.filters.status || decision.status === view.filters.status)
    && (!view.filters.action || decision.action === view.filters.action));

  const filterSelect = (key, options, label) => {
    const select = el('select', { class: 'ac-select', 'aria-label': label },
      el('option', { value: '' }, label),
      options.map((value) => el('option', { value, selected: view.filters[key] === value }, value)));
    select.addEventListener('change', () => { view.filters[key] = select.value; timelineCard(); });
    return select;
  };
  root.append(
    el('header', { class: 'ac-panel-head' },
      el('h3', {}, t('ac_timeline_h')),
      el('div', { class: 'ac-actions ac-wrap' }, filterSelect('status', statuses, t('ac_filter_status')), filterSelect('action', actions, t('ac_filter_action')))),
    el('div', { class: 'ac-rows', role: 'log', 'aria-live': 'polite', 'aria-label': t('ac_timeline_h') },
      filtered.length
        ? filtered.map(timelineRow)
        : el('p', { class: 'muted ac-empty' }, view.decisions.length ? t('ac_timeline_filtered_empty') : t('ac_timeline_empty'))));
}

// ------------------------------------------------------------------ drawer

function drawerElement() {
  return $('#ac-drawer');
}

async function openDrawer(decisionId) {
  view.openDecisionId = decisionId;
  const drawer = drawerElement();
  if (!drawer) return;
  drawer.hidden = false;
  const body = drawer.querySelector('.ac-drawer-body');
  await showDecisionDetail(body, decisionId, {
    approvalPanel: (approvals, decision) => el('div', {}, approvals.map((approval) => approvalControls(approval, decision, refresh)))
  });
  timelineCard();
  drawer.querySelector('.ac-drawer-close')?.focus({ preventScroll: true });
}

function closeDrawer() {
  view.openDecisionId = null;
  const drawer = drawerElement();
  if (drawer) drawer.hidden = true;
  timelineCard();
}

// ------------------------------------------------------------------ data + lifecycle

async function loadCases() {
  try {
    view.cases = (await view.getCases()) ?? [];
  } catch {
    view.cases = [];
  }
  if (!view.selectedCase) view.selectedCase = view.cases[0]?.case_id ?? null;
}

async function refresh() {
  if (!view.active || view.refreshing) return;
  view.refreshing = true;
  try {
    const [status, decisions, pools] = await Promise.all([
      agent.status(),
      agent.decisions({ limit: TIMELINE_LIMIT }),
      agent.pools().catch(() => ({ pools: [] }))
    ]);
    view.status = status;
    view.decisions = decisions.decisions ?? [];
    view.protectedCases = new Set((pools.pools ?? []).filter((pool) => pool.protected).map((pool) => pool.case_id));
    render();
    if (view.openDecisionId && !drawerElement()?.hidden) await openDrawer(view.openDecisionId);
  } catch (error) {
    const root = $('#ac-status');
    if (root && !view.status) { clear(root); root.append(el('p', { class: 'ac-error' }, error.message)); }
  } finally {
    view.refreshing = false;
  }
}

function render() {
  statusCard(view.status);
  controlsCard(view.status);
  const approvalsRoot = $('#ac-approvals');
  if (approvalsRoot) {
    renderApprovalsPanel(approvalsRoot, view.decisions, {
      protectedPools: view.protectedCases,
      onChanged: refresh,
      onOpen: openDrawer
    });
  }
  const injector = $('#ac-injector');
  if (injector) {
    injector.hidden = view.status?.mode !== 'demo';
    if (!injector.hidden) {
      renderInjector(injector, {
        cases: view.cases,
        selectedCaseId: view.selectedCase,
        onChange: (caseId) => { view.selectedCase = caseId; },
        onInjected: refresh
      });
    }
  }
  timelineCard();
}

function scheduleRefresh() {
  clearTimeout(view.refreshTimer);
  view.refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
}

function openStream() {
  closeStream();
  if (typeof EventSource === 'undefined') return;
  // The browser reconnects by itself and sends Last-Event-ID, so nothing recorded meanwhile is lost.
  view.stream = new EventSource('/api/agent/activity/stream');
  view.stream.onmessage = (message) => {
    let data;
    try { data = JSON.parse(message.data); } catch { return; }
    if (data.type === 'activity' || data.type === 'connected') scheduleRefresh();
  };
}

function closeStream() {
  if (view.stream) view.stream.close();
  view.stream = null;
}

export async function showAgentConsole() {
  view.active = true;
  const drawer = drawerElement();
  if (drawer && !view.wired) {
    view.wired = true;
    drawer.querySelector('.ac-drawer-close')?.addEventListener('click', closeDrawer);
    drawer.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });
  }
  statusCard(null);
  await loadCases();
  await refresh();
  openStream();
  clearInterval(view.pollTimer);
  view.pollTimer = setInterval(refresh, POLL_MS);
}

export function hideAgentConsole() {
  view.active = false;
  closeStream();
  clearInterval(view.pollTimer);
  clearTimeout(view.refreshTimer);
}

/** Re-render with the current data (language change). */
export function rerenderAgentConsole() {
  if (view.active) render();
}
