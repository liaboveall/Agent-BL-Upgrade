// Decision detail drawer: what happened for one decision and why -- pipeline steps with timings,
// the trace waterfall, findings, the policy's reasons, evidence hashes, the execution record and, when
// the decision is waiting, the approval controls. A simulated execution is shown as DEMO with its
// `demo:` reference and never gets an explorer link.

import { clear, el } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { preserveFocus } from '../accessibility.js';
import { agent, safeExplorerUrl } from './api.js';
import { settlementReasoning, settlementPolicyReason } from './settlement.js';
import { renderReferences } from './references.js';
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

function renderPolicy(policy, decision) {
  if (!policy) return el('p', { class: 'muted' }, '—');
  return el('div', {},
    el('p', {}, verdictBadge(policy.verdict), ` ${t('ac_autonomy')}: ${policy.autonomy}`),
    el('ul', { class: 'ac-list' }, (policy.reasons ?? []).map((reason) => el('li', {}, el('code', {}, reason.rule), ` — ${settlementPolicyReason(decision, reason)}`))));
}

function renderReplay(decision, previous) {
  if (previous?.dataset.decisionReplay === decision.decision_id && previous.dataset.replayLocale === getLang()) {
    if (previous.dataset.replayEvidence !== decision.evidence_hash && previous.dataset.replayPending !== 'true') {
      previous.querySelector('.ac-replay-result').replaceChildren();
      delete previous.querySelector('.ac-replay-result').dataset.replayStatus;
    }
    previous.dataset.replayEvidence = decision.evidence_hash;
    return previous;
  }
  const result = el('div', { role: 'status', 'aria-live': 'polite', class: 'ac-replay-result' });
  const wrap = el('div', { 'data-decision-replay': decision.decision_id, 'data-replay-evidence': decision.evidence_hash, 'data-replay-locale': getLang() });
  const button = el('button', { type: 'button', class: 'btn ghost', 'data-focus-key': 'decision:replay',
    onclick: async () => {
      if (wrap.dataset.replayPending === 'true') return;
      wrap.dataset.replayPending = 'true';
      button.setAttribute('aria-disabled', 'true'); result.textContent = t('ac_replay_running');
      delete result.dataset.replayStatus;
      try {
        const { replay } = await agent.replay(decision.decision_id);
        const evidence = replay.checks?.find((check) => check.name === 'evidence_hash');
        if (evidence) wrap.dataset.replayEvidence = evidence.expected;
        result.textContent = t(replay.passed ? 'ac_replay_pass' : 'ac_replay_fail');
        result.dataset.replayStatus = replay.status;
        if (replay.code === 'snapshot_unavailable') result.append(' ', t('ac_replay_missing'));
        if (replay.checks?.length) result.append(el('ul', { class: 'ac-list' }, replay.checks.map((check) =>
          el('li', {}, `${check.passed ? '✓' : '✗'} ${check.name}`))));
      } catch (error) { result.textContent = error.message; }
      finally { button.removeAttribute('aria-disabled'); delete wrap.dataset.replayPending; }
    } }, t('ac_replay_button'));
  wrap.append(button, result);
  return wrap;
}

function renderAnchoring(anchor, decision) {
  const wrap = el('div', { class: 'ac-anchor', 'data-anchor-state': anchor?.state ?? 'UNAVAILABLE' });
  const render = (value) => {
    clear(wrap);
    wrap.dataset.anchorState = value?.state ?? 'UNAVAILABLE';
    wrap.append(el('p', {}, badge(t(`ac_anchor_state_${value?.state ?? 'UNAVAILABLE'}`),
      value?.verification?.passed ? 'tone-ok' : 'tone-warn')));
    if (!value?.available) return;
    wrap.append(el('p', { class: 'muted' }, t(value.mode === 'demo' ? 'ac_anchor_demo_hint' : 'ac_anchor_live_hint')),
      kv(t('ac_anchor_seq'), String(value.seq)), kv(t('ac_anchor_finalized'), formatDateTime(value.payload.finalized_at)));
    if (value.batch) {
      wrap.append(kv(t('ac_anchor_batch'), `#${value.batch.batch_id}`),
        kv(t('ac_anchor_root'), el('span', {}, el('code', {}, shortId(value.batch.merkle_root, 12, 8)), ' ', copyButton(value.batch.merkle_root))));
      const link = value.mode === 'live' && value.state === 'ANCHORED' && value.verification?.status === 'PASS_CHAIN'
        && value.batch.tx_hash && safeExplorerUrl(value.batch.explorer_url);
      if (link) wrap.append(kv(t('ac_anchor_tx'), el('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, `${shortId(value.batch.tx_hash, 12, 8)} ↗`)));
    }
    const verification = el('p', { role: 'status', 'aria-live': 'polite', class: value.verification?.passed ? 'muted' : 'ac-error',
      'data-anchor-verification': value.verification?.status ?? 'UNAVAILABLE' },
    t(value.verification?.status === 'PASS_CHAIN' ? 'ac_anchor_pass_chain' : value.verification?.passed ? 'ac_anchor_pass_local' : value.state === 'PENDING_BATCH' ? 'ac_anchor_wait' : 'ac_anchor_fail'));
    const button = el('button', { type: 'button', class: 'btn ghost', 'data-focus-key': 'decision:anchor-verify',
      onclick: async () => {
        if (button.getAttribute('aria-busy') === 'true') return;
        button.setAttribute('aria-busy', 'true'); verification.textContent = t('ac_anchor_checking');
        try { const { anchor: fresh } = await agent.anchor(decision.decision_id); preserveFocus(wrap, () => render(fresh)); }
        catch { verification.textContent = t('ac_anchor_fail'); button.setAttribute('aria-busy', 'false'); }
      } }, t('ac_anchor_verify'));
    wrap.append(button, verification, el('details', {}, el('summary', {}, t('ac_anchor_proof')),
      el('pre', { class: 'ac-anchor-json', tabindex: '0' }, JSON.stringify({ payload: value.payload, leaf: value.leaf,
        version: value.version, proof: value.proof, batch: value.batch }, null, 2))));
  };
  render(anchor);
  return wrap;
}

function renderFreshness(freshness, currentStatus) {
  if (!freshness) return el('p', { class: 'muted' }, t('ac_freshness_missing'));
  const status = currentStatus ?? freshness.source_status;
  return el('div', { class: 'ac-kvlist', 'data-evidence-status': status },
    badge(t(`ac_source_${status}`), status === 'stale' ? 'tone-err' : status === 'live' ? 'tone-ok' : 'tone-warn'),
    kv(t('ac_observed_at'), formatDateTime(freshness.observed_at)),
    kv(t('ac_expires_at'), formatDateTime(freshness.expires_at)));
}

function renderEvidence(decision) {
  const rows = [];
  if (decision.evidence_hash) rows.push(kv(t('ac_evidence_hash'), el('span', {}, el('code', {}, shortId(decision.evidence_hash, 12, 8)), ' ', copyButton(decision.evidence_hash))));
  if (decision.quote_hash) rows.push(kv(t('ac_quote_hash'), el('span', {}, el('code', {}, shortId(decision.quote_hash, 12, 8)), ' ', copyButton(decision.quote_hash))));
  rows.push(kv(t('ac_decision_id'), el('span', {}, el('code', {}, shortId(decision.decision_id, 18, 6)), ' ', copyButton(decision.decision_id))));
  if (decision.trace_id) rows.push(kv(t('ac_trace_id'), el('code', {}, decision.trace_id)));
  return el('div', { class: 'ac-kvlist' }, rows);
}

function renderModelUsage(trace, decision) {
  const calls = (trace?.spans ?? []).filter((span) => span.attributes?.['llm.provider'] || span.attributes?.['llm.model']);
  const pipelineCalls = (decision.pipeline ?? []).flatMap((step) => step.model_usage ?? []).map((call) => ({
    attributes: { 'llm.provider': call.provider, 'llm.model': call.model, 'llm.latency_ms': call.latency_ms,
      ...(call.tokens ? { 'llm.tokens': JSON.stringify(call.tokens) } : {}) }
  }));
  calls.push(...pipelineCalls);
  if (!calls.length) return el('p', { class: 'muted' }, t('ac_model_unrecorded'));
  return el('ul', { class: 'ac-steps' }, calls.map(({ attributes: attributes, duration_ms: duration }) =>
    el('li', {}, el('code', {}, [attributes['llm.provider'], attributes['llm.model']].filter(Boolean).join(' / ')),
      ` · ${attributes['llm.latency_ms'] ?? duration ?? '—'} ms`,
      attributes['llm.tokens'] ? el('p', {}, t('ac_model_tokens'), ': ', attributes['llm.tokens']) : null)));
}

/**
 * Fill `container` with the detail of one decision.
 * @param {HTMLElement} container
 * @param {string} decisionId
 * @param {{approvalPanel: (approvals: object[], decision: object) => HTMLElement}} hooks
 */
export async function showDecisionDetail(container, decisionId, { approvalPanel, isCurrent = () => true }) {
  const version = Number(container.dataset.requestVersion ?? 0) + 1;
  container.dataset.requestVersion = String(version);
  if (container.dataset.decisionId !== decisionId) {
    clear(container);
    container.append(el('p', { class: 'muted' }, t('ac_loading')));
  }
  try {
    const [detail, traceResult, anchorResult] = await Promise.all([
      agent.decision(decisionId),
      agent.trace(decisionId).catch(() => ({ trace: null })),
      agent.anchor(decisionId).catch(() => ({ anchor: { available: false, state: 'UNAVAILABLE' } }))
    ]);
    const { decision, approvals, activity } = detail;
    if (!isCurrent() || Number(container.dataset.requestVersion) !== version) return;
    const snapshot = JSON.stringify([detail, traceResult, anchorResult, getLang()]);
    if (container.dataset.detailSnapshot === snapshot) return;
    window.dispatchEvent(new CustomEvent('agentbl:decisionselected', { detail: { decision } }));
    preserveFocus(container, () => {
    const replay = renderReplay(decision, container.querySelector('[data-decision-replay]'));
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
        el('p', {}, settlementReasoning(decision)),
        proposal.new_issue_price_usd !== null && proposal.new_issue_price_usd !== undefined
          ? el('p', { class: 'muted' }, t('ac_price_move', { price: usd(proposal.new_issue_price_usd), bps: proposal.price_move_bps ?? 0 }))
          : null,
        decision.note ? el('p', { class: 'muted' }, decision.note) : null,
        decision.error ? el('p', { class: 'ac-error' }, `${decision.error.code ?? ''} ${decision.error.message ?? ''}`) : null),
      section(t('ac_policy'), renderPolicy(decision.policy, decision)),
      approvals?.length ? section(t('ac_approval'), approvalPanel(approvals, decision)) : null,
      section(t('ac_execution'), renderExecution(decision.execution)),
      section(t('ac_pipeline'), renderTrace(traceResult.trace, decision.pipeline)),
      section(t('ac_model_usage'), renderModelUsage(traceResult.trace, decision)),
      section(t('ac_findings'), renderFindings(decision.findings)),
      section(t('ac_evidence'), renderEvidence(decision), renderFreshness(decision.freshness, decision.freshness_status), replay),
      section(t('ac_anchor_title'), renderAnchoring(anchorResult.anchor, decision)),
      section(t('ac_linked_views'), el('div', { class: 'ac-actions ac-wrap' },
        ...['market', 'mint'].map((target) => el('button', { type: 'button', class: 'btn ghost',
          disabled: target === 'mint' && !(decision.quote_snapshot ?? decision.proposal?.params?.quote),
          'data-focus-key': `decision-view:${target}`, onclick: () => window.dispatchEvent(new CustomEvent('agentbl:decisionnavigate', { detail: { decision, target } }))
        }, target === 'market' ? t('ac_view_market') : t('ac_view_quote'))))),
      renderReferences(decision.references, { open: true }),
      section(t('ac_activity'), el('ol', { class: 'ac-steps' }, (activity ?? []).map((record) =>
        el('li', {}, el('code', {}, `#${record.seq}`), ` ${record.action} `, el('span', { class: 'muted' }, formatDateTime(record.timestamp))))))
    ].filter(Boolean));
    container.dataset.decisionId = decisionId;
    container.dataset.detailSnapshot = snapshot;
    });
  } catch (error) {
    if (!isCurrent() || Number(container.dataset.requestVersion) !== version) return;
    clear(container);
    container.append(el('p', { class: 'ac-error' }, error.message));
  }
}
