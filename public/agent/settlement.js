// Live operators submit evidence here. Verification and human approval are separate server steps.
import { clear, el, toast } from '../dom.js';
import { t, tData } from '../i18n.js';
import { agent } from './api.js';

const draft = { case_id: '', type: 'PAYMENT_RECEIVED', proof: '', amount: '', result: '', error: false };
let pending = false;
const ERROR_KEYS = {
  invalid_repayment_amount: 'ac_set_error_amount', unsafe_repayment_number: 'ac_set_error_amount', invalid_atomic_amount: 'ac_set_error_amount',
  payment_transfer_mismatch: 'ac_set_error_transfer', invalid_payment_sender: 'ac_set_error_transfer',
  invalid_payment_hash: 'ac_set_error_receipt', payment_not_mined: 'ac_set_error_receipt', payment_reverted: 'ac_set_error_receipt',
  payment_unconfirmed: 'ac_set_error_receipt', payment_reorged: 'ac_set_error_receipt', payment_evidence_changed: 'ac_set_error_receipt',
  no_chain_pool: 'ac_set_error_pool', protected_pool: 'ac_set_error_pool', settlement_pool_mismatch: 'ac_set_error_pool',
  emergency_stopped: 'ac_set_error_stop', unsupported_payment_source: 'ac_set_error_source'
};

export function renderSettlementIntake(container, { cases, status, onSubmitted }) {
  clear(container);
  const select = el('select', { id: 'ac-set-case', class: 'ac-select', 'aria-label': t('ac_inj_case') }, cases.map((entry) => {
    const bill = entry.case?.bill_of_lading;
    return el('option', { value: entry.case_id, selected: entry.case_id === draft.case_id },
      bill ? `${tData(bill.cargo)} · ${tData(bill.port_of_loading)} → ${tData(bill.port_of_discharge)}` : tData(entry.label ?? entry.case_id));
  }));
  select.addEventListener('change', () => { draft.case_id = select.value; });
  const type = el('select', { id: 'ac-set-type', class: 'ac-select', 'aria-label': t('ac_set_type') },
    [['PAYMENT_RECEIVED', 'ac_inj_pay'], ['CARGO_ARRIVED', 'ac_inj_arrive'], ['CARGO_DEPARTED', 'ac_inj_depart']].map(([value, key]) =>
      el('option', { value, selected: value === draft.type }, t(key))));
  const proof = el('input', { id: 'ac-set-proof', class: 'ac-select', type: 'text', maxlength: 300, required: true, value: draft.proof, autocomplete: 'off' });
  proof.addEventListener('input', () => { draft.proof = proof.value; });
  const amount = el('input', { id: 'ac-set-amount', class: 'ac-select', type: 'text', inputmode: 'decimal', maxlength: 85, value: draft.amount, autocomplete: 'off' });
  amount.addEventListener('input', () => { draft.amount = amount.value; });
  const amountField = el('label', { class: 'ac-field', for: 'ac-set-amount' }, el('span', {}, t('ac_set_amount')), amount);
  const proofLabel = el('span');
  const result = el('p', { class: `ac-small${draft.error ? ' ac-error' : ''}`, id: 'ac-set-result', role: 'status', 'aria-live': 'polite' },
    draft.result === 'accepted' ? t('ac_set_accepted') : Object.values(ERROR_KEYS).includes(draft.result) ? t(draft.result) : draft.result);
  const button = el('button', { class: 'btn', type: 'submit', 'data-focus-key': 'settlement:submit' }, t('ac_set_submit'));
  const update = () => {
    const payment = type.value === 'PAYMENT_RECEIVED'; amountField.hidden = !payment; amount.required = payment;
    proofLabel.textContent = t(payment ? 'ac_set_payment_hash' : 'ac_set_proof');
    button.disabled = pending || payment && !status?.settlement?.recipient_configured;
  };
  type.addEventListener('change', () => { draft.type = type.value; update(); });
  const form = el('form', { id: 'ac-set-form', onsubmit: async (event) => {
    event.preventDefault(); if (pending) return;
    pending = true; update(); result.textContent = t('ac_set_verifying'); result.classList.remove('ac-error');
    let accepted = false;
    try {
      const data = type.value === 'PAYMENT_RECEIVED'
        ? { payment_proof: proof.value.trim(), repayment_amount: amount.value.trim(), proof_source: 'usdc-transfer' }
        : type.value === 'CARGO_ARRIVED' ? { arrival_proof: proof.value.trim() } : { departure_proof: proof.value.trim() };
      const response = await agent.inject({ type: type.value, case_id: select.value, data });
      if (response.processing?.status === 'DEAD') throw Object.assign(new Error(response.processing.error?.message ?? t('ac_set_failed')), { code: response.processing.error?.code });
      draft.result = 'accepted'; draft.error = false; accepted = true;
      result.textContent = t('ac_set_accepted'); toast(t('ac_set_accepted'));
    } catch (error) {
      draft.result = ERROR_KEYS[error.code] ?? error.message; draft.error = true;
      const message = ERROR_KEYS[error.code] ? t(ERROR_KEYS[error.code]) : error.message;
      result.textContent = message; result.classList.add('ac-error'); toast(message, true);
    }
    finally { pending = false; update(); if (accepted) await onSubmitted?.(); }
  } },
  el('label', { class: 'ac-field', for: 'ac-set-case' }, el('span', {}, t('ac_inj_case')), select),
  el('label', { class: 'ac-field', for: 'ac-set-type' }, el('span', {}, t('ac_set_type')), type),
  el('label', { class: 'ac-field', for: 'ac-set-proof' }, proofLabel, proof), amountField, button, result);
  container.append(el('header', { class: 'ac-panel-head' }, el('h3', {}, t('ac_set_h'))),
    el('p', { class: 'muted ac-small' }, t('ac_set_hint')));
  if (!status?.settlement?.recipient_configured) container.append(el('p', { class: 'ac-error ac-small' }, t('ac_set_unconfigured')));
  container.append(form);
  update();
}

export function settlementSummary(decision) {
  const verification = decision.proposal?.params?.payment_verification;
  if (decision.mode !== 'live' || verification?.source !== 'confirmed-usdc-transfer') return null;
  return el('div', { class: 'ac-opening-summary ac-set-evidence' },
    el('strong', {}, t('ac_set_verified')),
    el('p', {}, t('ac_set_payment', { amount: verification.amount_usdc })),
    el('p', { class: 'muted ac-small' }, t('ac_set_recipient', { recipient: verification.recipient })),
    el('p', { class: 'muted ac-small' }, t('ac_set_finality', { block: verification.block_number, count: verification.required_confirmations })),
    el('p', { class: 'muted ac-small' }, t('ac_set_disclaimer')));
}

export function settlementReasoning(decision) {
  const amount = decision.proposal?.params?.repayment_amount;
  return decision.mode === 'live' && ['RECORD_PAYMENT', 'RECORD_ARRIVAL', 'SETTLE'].includes(decision.action)
    ? t(`ac_set_reason_${decision.action}`, { amount }) : decision.reasoning_summary;
}

export function settlementPolicyReason(decision, reason) {
  if (reason.rule === 'STALE_EVIDENCE') return t('ac_evidence_expired');
  const keys = { LIVE_REQUIRES_APPROVAL: 'ac_set_policy_live', IRREVERSIBLE: 'ac_set_policy_sensitive', AUTONOMY_LEVEL: 'ac_set_policy_propose' };
  return decision.mode === 'live' && ['RECORD_PAYMENT', 'RECORD_ARRIVAL', 'SETTLE'].includes(decision.action) && keys[reason.rule] ? t(keys[reason.rule]) : reason.message;
}
