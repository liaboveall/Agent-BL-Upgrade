// Decision detail drawer: what happened for one decision and why -- pipeline steps with timings,
// the trace waterfall, findings, the policy's reasons, evidence hashes, the execution record and, when
// the decision is waiting, the approval controls. A simulated execution is shown as DEMO with its
// `demo:` reference and never gets an explorer link.

import { clear, el } from '../dom.js';
import { t } from '../i18n.js';
import { agent, safeExplorerUrl } from './api.js';
import { badge, copyButton, formatDateTime, kv, section, shortId, statusBadge, usd, verdictBadge } from './ui.js';

export function renderExecution(execution) {
  if (!execution) return el('p', { class: 'muted' }, t('ac_no_execution'));
  const link = safeExplorerUrl(execution.explorer_url);
  const rows = [kv(t('ac_exec_mode'), execution.mode === 'chain' ? t('ac_exec_chain') : execution.mode === 'demo' ? t('ac_exec_demo') : String(execution.mode))];
  if (execution.signer_role) rows.push(kv(t('ac_exec_signer'), execution.signer_role));
  if (execution.tx_hash) {
    rows.push(kv(t('ac_exec_tx'), el('span', {},
      link
        ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, `${shortId(execution.tx_hash, 12, 8)} ↗`)
        : shortId(execution.tx_hash, 12, 8),
      ' ', copyButton(execution.tx_hash))));
  } else if (execution.reference) {
    rows.push(kv(t('ac_exec_ref'), el('span', {}, el('code', {}, execution.reference), ' ', badge(t('ac_simulated'), 'tone-warn', t('ac_simulated_hint')))));
  }
  if (execution.block_number !== undefined && execution.block_number !== null) rows.push(kv(t('ac_exec_block'), `#${execution.block_number}`));
  if (execution.effects) {
    rows.push(kv(t('ac_exec_state'), `${execution.effects.state_before} → ${execution.effects.state_after}`));
    if (execution.effects.issue_price_before_usd !== execution.effects.issue_price_after_usd) {
      rows.push(kv(t('ac_exec_price'), `${usd(execution.effects.issue_price_before_usd)} → ${usd(execution.effects.issue_price_after_usd)}`));
    }
  }
  if (execution.confirmed_events?.length) rows.push(kv(t('ac_exec_events'), execution.confirmed_events.join(', ')));
  if (execution.pending) rows.push(kv(t('ac_exec_pending'), t('ac_exec_pending_hint')));
  if (execution.note) rows.push(kv(t('ac_exec_note'), execution.note));
  return el('div', { class: 'ac-kvlist' }, rows);
}

/** Pipeline step durations plus the trace spans as a waterfall. */
function renderTrace(trace, pipeline) {
  const wrap = el('div', { class: 'ac-trace' });
  if (trace?.spans?.length) {
    const start = Date.parse(trace.started_at);
    const total = Math.max(1, trace.duration_ms ?? Math.max(...trace.spans.map((s) => (Date.parse(s.started_at) - start) + (s.duration_ms ?? 0))));
    const ordered = [...trace.spans].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
    for (const span of ordered) {
      const offset = Math.max(0, Math.min(100, ((Date.parse(span.started_at) - start) / total) * 100));
      const width = Math.max(1.5, Math.min(100 - offset, ((span.duration_ms ?? 0) / total) * 100));
      wrap.append(el('div', { class: `ac-span ${span.status === 'error' ? 'is-error' : ''}` },
        el('span', { class: 'ac-span-name' }, span.name),
        el('span', { class: 'ac-span-track', role: 'img', 'aria-label': `${span.name} ${span.duration_ms} ms` },
          el('span', { class: 'ac-span-bar', style: `margin-left:${offset}%;width:${width}%` })),
        el('span', { class: 'ac-span-ms' }, `${span.duration_ms ?? 0} ms`)));
    }
    wrap.append(el('p', { class: 'muted ac-small' }, t('ac_trace_total', { ms: trace.duration_ms ?? total, id: shortId(trace.trace_id, 8, 0) })));
  } else {
    wrap.append(el('p', { class: 'muted' }, t('ac_trace_none')));
  }
  if (pipeline?.length) {
    wrap.append(el('ol', { class: 'ac-steps' }, pipeline.map((step) =>
      el('li', {}, badge(step.status, step.status === 'PASS' ? 'tone-ok' : step.status === 'FAIL' ? 'tone-err' : 'tone-warn'),
        ` ${step.step} `, el('span', { class: 'muted' }, `${step.duration_ms ?? 0} ms`)))));
  }
  return wrap;
}

function renderFindings(findings) {
  if (!findings?.length) return el('p', { class: 'muted' }, t('ac_no_findings'));
  return el('ul', { class: 'ac-list' }, findings.map((finding) => el('li', {},
    badge(finding.severity ?? 'info', finding.severity === 'critical' || finding.severity === 'high' ? 'tone-err' : finding.severity === 'warning' ? 'tone-warn' : 'tone-muted'),
    ` ${finding.kind}: ${finding.detail ?? ''}`)));
}

function renderPolicy(policy) {
  if (!policy) return el('p', { class: 'muted' }, '—');
  return el('div', {},
    el('p', {}, verdictBadge(policy.verdict), ` ${t('ac_autonomy')}: ${policy.autonomy}`),
    el('ul', { class: 'ac-list' }, (policy.reasons ?? []).map((reason) => el('li', {}, el('code', {}, reason.rule), ` — ${reason.message}`))));
}

function renderEvidence(decision) {
  const rows = [];
  if (decision.evidence_hash) rows.push(kv(t('ac_evidence_hash'), el('span', {}, el('code', {}, shortId(decision.evidence_hash, 12, 8)), ' ', copyButton(decision.evidence_hash))));
  if (decision.quote_hash) rows.push(kv(t('ac_quote_hash'), el('span', {}, el('code', {}, shortId(decision.quote_hash, 12, 8)), ' ', copyButton(decision.quote_hash))));
  rows.push(kv(t('ac_decision_id'), el('span', {}, el('code', {}, shortId(decision.decision_id, 18, 6)), ' ', copyButton(decision.decision_id))));
  if (decision.trace_id) rows.push(kv(t('ac_trace_id'), el('code', {}, decision.trace_id)));
  return el('div', { class: 'ac-kvlist' }, rows);
}

/**
 * Fill `container` with the detail of one decision.
 * @param {HTMLElement} container
 * @param {string} decisionId
 * @param {{approvalPanel: (approvals: object[], decision: object) => HTMLElement}} hooks
 */
export async function showDecisionDetail(container, decisionId, { approvalPanel }) {
  clear(container);
  container.append(el('p', { class: 'muted' }, t('ac_loading')));
  try {
    const [detail, traceResult] = await Promise.all([
      agent.decision(decisionId),
      agent.trace(decisionId).catch(() => ({ trace: null }))
    ]);
    const { decision, approvals, activity } = detail;
    clear(container);
    const proposal = decision.proposal ?? {};
    // append() would print a literal "null" for an absent section, so absent ones are filtered out.
    container.append(...[
      el('header', { class: 'ac-drawer-head' },
        el('div', {},
          el('h3', {}, `${decision.action}`),
          el('p', { class: 'muted ac-small' }, `${decision.case_id} · ${formatDateTime(decision.created_at)} · ${decision.event_type}`)),
        el('div', { class: 'ac-drawer-badges' }, statusBadge(decision.status), badge(String(decision.mode).toUpperCase(), decision.mode === 'live' ? 'tone-ok' : 'tone-muted'))),
      section(t('ac_summary'),
        el('p', {}, decision.reasoning_summary),
        proposal.new_issue_price_usd !== null && proposal.new_issue_price_usd !== undefined
          ? el('p', { class: 'muted' }, t('ac_price_move', { price: usd(proposal.new_issue_price_usd), bps: proposal.price_move_bps ?? 0 }))
          : null,
        decision.note ? el('p', { class: 'muted' }, decision.note) : null,
        decision.error ? el('p', { class: 'ac-error' }, `${decision.error.code ?? ''} ${decision.error.message ?? ''}`) : null),
      section(t('ac_policy'), renderPolicy(decision.policy)),
      approvals?.length ? section(t('ac_approval'), approvalPanel(approvals, decision)) : null,
      section(t('ac_execution'), renderExecution(decision.execution)),
      section(t('ac_pipeline'), renderTrace(traceResult.trace, decision.pipeline)),
      section(t('ac_findings'), renderFindings(decision.findings)),
      section(t('ac_evidence'), renderEvidence(decision)),
      section(t('ac_activity'), el('ol', { class: 'ac-steps' }, (activity ?? []).map((record) =>
        el('li', {}, el('code', {}, `#${record.seq}`), ` ${record.action} `, el('span', { class: 'muted' }, formatDateTime(record.timestamp))))))
    ].filter(Boolean));
    container.dataset.decisionId = decisionId;
  } catch (error) {
    clear(container);
    container.append(el('p', { class: 'ac-error' }, error.message));
  }
}
