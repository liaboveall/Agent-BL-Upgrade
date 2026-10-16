// Live settlement wording: a verified USDC repayment or arrival proof reads differently from the
// agent's generic reasoning.
import { t } from '../../lib/i18n.js';

const SETTLEMENT_ACTIONS = ['RECORD_PAYMENT', 'RECORD_ARRIVAL', 'SETTLE'];

export function settlementReasoning(decision) {
  const amount = decision.proposal?.params?.repayment_amount;
  return decision.mode === 'live' && SETTLEMENT_ACTIONS.includes(decision.action)
    ? t(`ac_set_reason_${decision.action}`, { amount }) : decision.reasoning_summary;
}

export function settlementPolicyReason(decision, reason) {
  if (reason.rule === 'STALE_EVIDENCE') return t('ac_evidence_expired');
  const keys = { LIVE_REQUIRES_APPROVAL: 'ac_set_policy_live', IRREVERSIBLE: 'ac_set_policy_sensitive', AUTONOMY_LEVEL: 'ac_set_policy_propose' };
  return decision.mode === 'live' && SETTLEMENT_ACTIONS.includes(decision.action) && keys[reason.rule] ? t(keys[reason.rule]) : reason.message;
}

export const SETTLEMENT_ERROR_KEYS = {
  invalid_repayment_amount: 'ac_set_error_amount', unsafe_repayment_number: 'ac_set_error_amount', invalid_atomic_amount: 'ac_set_error_amount',
  payment_transfer_mismatch: 'ac_set_error_transfer', invalid_payment_sender: 'ac_set_error_transfer',
  invalid_payment_hash: 'ac_set_error_receipt', payment_not_mined: 'ac_set_error_receipt', payment_reverted: 'ac_set_error_receipt',
  payment_unconfirmed: 'ac_set_error_receipt', payment_reorged: 'ac_set_error_receipt', payment_evidence_changed: 'ac_set_error_receipt',
  no_chain_pool: 'ac_set_error_pool', protected_pool: 'ac_set_error_pool', settlement_pool_mismatch: 'ac_set_error_pool',
  emergency_stopped: 'ac_set_error_stop', unsupported_payment_source: 'ac_set_error_source'
};
