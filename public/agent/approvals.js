// Approval panel: the human side of "the agent only proposes" (D1). Each card is one proposal waiting
// for a decision. Pricing actions are sent by the server after approval; actions the owner must sign
// show the exact command to run on the operator's own machine, and the server verifies the result
// against the chain before anything is marked done.

import { clear, el, toast } from '../dom.js';
import { t } from '../i18n.js';
import { agent } from './api.js';
import { badge, copyButton, formatDateTime, statusBadge, usd } from './ui.js';
import { settlementSummary, settlementReasoning, settlementPolicyReason } from './settlement.js';

const WAITING = ['PENDING_APPROVAL', 'AWAITING_OWNER_SIGNATURE'];

function command(approvalId, step) {
  return `npm run agent:approve -- --id ${approvalId}${step === undefined ? '' : ` --step ${step}`}`;
}

const STEP_KEYS = ['ac_open_mint', 'ac_open_pledge', 'ac_open_create'];
function argumentText(arg, bindings) {
  if (arg?.ref) return bindings?.[arg.ref] ?? t('ac_open_dependency');
  return arg && typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
}

function openingSummary(decision) {
  const opening = decision.opening;
  if (!opening || opening.kind === 'unavailable') return null;
  return el('div', { class: 'ac-opening-summary' },
    el('strong', {}, t(opening.kind === 'link' ? 'ac_open_existing' : 'ac_open_new')),
    el('p', { class: 'muted ac-small' }, t(opening.kind === 'link' ? 'ac_open_link_hint' : 'ac_open_three_hint')),
    opening.kind === 'create' ? el('p', {}, t('ac_open_progress', { count: opening.steps_verified ?? 0 })) : null);
}

function transactionPlan(approval) {
  const done = new Set((approval.steps_done ?? []).map((step) => step.index));
  const opening = approval.plan?.kind === 'create';
  return el('ol', { class: 'ac-steps ac-owner-plan' }, (approval.plan?.steps ?? []).map((step) =>
    el('li', {},
      el('strong', {}, opening ? t(STEP_KEYS[step.index]) : `${step.contract}.${step.method}`),
      ' ', badge(t(done.has(step.index) ? 'ac_open_verified' : 'ac_open_pending'), done.has(step.index) ? 'tone-ok' : 'tone-warn'),
      step.args.some((arg) => arg?.ref && !approval.plan.bindings?.[arg.ref]) ? el('p', { class: 'muted ac-small' }, t('ac_open_dependency')) : null,
      el('details', {}, el('summary', {}, t('ac_open_arguments')),
        el('code', {}, `${step.contract}.${step.method}(${step.args.map((arg) => argumentText(arg, approval.plan.bindings)).join(', ')})`)))));
}

async function guarded(action, onChanged, doneKey) {
  try {
    await action();
    toast(t(doneKey));
  } catch (error) {
    toast(error.message, true);
  }
  await onChanged?.();
}

/** The controls for one approval; shared by the panel and the decision drawer. */
export function approvalControls(approval, decision, onChanged) {
  const wrap = el('div', { class: 'ac-approval-controls' });
  const route = approval.route;
  const stale = decision.freshness_status === 'stale' || decision.freshness?.fresh === false;
  if (approval.status === 'PENDING') {
    wrap.append(
      el('div', { class: 'ac-actions' },
        el('button', {
          class: 'btn', type: 'button', disabled: stale, title: stale ? t('ac_evidence_expired') : '', 'data-focus-key': `approve:${approval.approval_id}`,
          onclick: () => guarded(() => agent.approve(approval.approval_id), onChanged, 'ac_approved_toast')
        }, t(route === 'link' ? 'ac_open_link_button' : 'ac_approve')),
        el('button', {
          class: 'btn ghost', type: 'button', 'data-focus-key': `reject:${approval.approval_id}`,
          onclick: () => {
            const note = window.prompt(t('ac_reject_reason'));
            if (note === null) return;
            return guarded(() => agent.reject(approval.approval_id, note.trim() || undefined), onChanged, 'ac_rejected_toast');
          }
        }, t('ac_reject'))),
      stale ? el('p', { class: 'ac-error ac-small' }, t('ac_evidence_expired')) : null,
      el('p', { class: 'muted ac-small' }, route === 'link' ? t('ac_open_link_hint') : route === 'owner_cli' ? t('ac_route_owner') : route === 'server' ? t('ac_route_server') : t('ac_route_sim')));
  } else if (approval.status === 'AWAITING_OWNER_SIGNATURE') {
    const opening = decision.opening?.kind === 'create';
    const next = opening ? (approval.steps_done?.length ?? decision.opening.steps_verified ?? 0) : undefined;
    const cli = command(approval.approval_id, next);
    wrap.append(
      el('p', {}, t(opening && next >= 3 ? 'ac_open_reconcile' : 'ac_owner_waiting')),
      opening && next >= 3 ? null : el('div', { class: 'ac-command' }, el('code', {}, cli), copyButton(cli)),
      el('p', { class: 'muted ac-small' }, t(opening ? 'ac_open_three_hint' : 'ac_owner_hint')),
      el('button', {
        class: 'btn ghost', type: 'button',
        onclick: async (event) => {
          const button = event.currentTarget;
          try {
            const detail = await agent.approvals('AWAITING_OWNER_SIGNATURE');
            const mine = detail.approvals.find((item) => item.approval_id === approval.approval_id);
            button.replaceWith(transactionPlan(mine ?? approval));
          } catch (error) {
            toast(error.message, true);
          }
        }
      }, t('ac_show_plan')));
  } else {
    wrap.append(el('p', { class: 'muted' }, statusBadge(approval.status)));
  }
  return wrap;
}

/** A single card for a decision that is waiting. */
export function approvalCard(decision, { protectedPools, onChanged, onOpen }) {
  const approval = decision.approval ?? {};
  const proposal = decision.proposal ?? {};
  const reasons = (decision.policy?.reasons ?? []).filter((reason) => reason.verdict === 'NEEDS_APPROVAL').map((reason) => settlementPolicyReason(decision, reason));
  const card = el('article', { class: 'ac-approval-card' },
    el('header', {},
      el('div', {},
        badge(decision.action, 'tone-info'),
        ' ', el('strong', {}, decision.case_id),
        protectedPools?.has(decision.case_id) ? [' ', badge(t('ac_protected'), 'tone-warn', t('ac_protected_hint'))] : null),
      el('div', { class: 'muted ac-small' }, formatDateTime(decision.created_at), approval.expires_at ? ` · ${t('ac_expires', { time: formatDateTime(approval.expires_at) })}` : '')),
    el('p', {}, settlementReasoning(decision)),
    openingSummary(decision),
    settlementSummary(decision),
    proposal.new_issue_price_usd !== null && proposal.new_issue_price_usd !== undefined
      ? el('p', { class: 'ac-price' }, t('ac_price_move', { price: usd(proposal.new_issue_price_usd), bps: proposal.price_move_bps ?? 0 }))
      : null,
    reasons.length ? el('ul', { class: 'ac-list' }, reasons.map((reason) => el('li', {}, reason))) : null,
    approvalControls({ approval_id: approval.approval_id, status: decision.status === 'AWAITING_OWNER_SIGNATURE' ? 'AWAITING_OWNER_SIGNATURE' : 'PENDING', route: approval.route }, decision, onChanged),
    el('button', { class: 'ac-link', type: 'button', 'data-focus-key': `details:${decision.decision_id}`, onclick: () => onOpen(decision.decision_id) }, t('ac_details')));
  return card;
}

/**
 * Render the approvals panel from the decisions that are waiting.
 * @param {HTMLElement} container
 * @param {object[]} decisions  all recent decisions
 */
export function renderApprovalsPanel(container, decisions, options) {
  clear(container);
  const waiting = decisions.filter((decision) => WAITING.includes(decision.status) && decision.approval?.approval_id);
  container.append(el('header', { class: 'ac-panel-head' },
    el('h3', {}, t('ac_approvals_h')),
    badge(String(waiting.length), waiting.length ? 'tone-warn' : 'tone-muted')));
  if (!waiting.length) {
    container.append(el('p', { class: 'muted' }, t('ac_approvals_empty')));
    return;
  }
  container.append(...waiting.map((decision) => approvalCard(decision, options)));
}
