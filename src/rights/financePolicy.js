// Disclosures embed the policy of their control version. The v2 text must stay byte-identical
// so that disclosures already published for the v2 instance still verify.
export const FINANCE_POLICY_V2 = Object.freeze({ version: 'agentbl-cash-rights-v2.1',
  scope: 'research_test_assets_only', token_decimals: 6, platform_fee_atomic: '0',
  subscription_boundary: 'at_or_before', disbursement_boundary: 'strictly_before',
  valuation: 'revalidate_each_draw_no_deadline_extension',
  undisbursed_exit: 'public_close_at_disbursement_deadline_principal_only',
  partial_target: 'P+ceil((G-P)*L/P)', debt: 'max(partial_target-(P-L+recovery),0)',
  resolution_notice_seconds: 86400, resolution_hard_limit_seconds: 259200,
  dispute: 'one_freeze_per_pool_notice_window_only_no_hash_or_actor_reset',
  fallback: 'public_cash_finalization_at_hard_deadline',
  allocation: 'permanent_subscription_slots_cyclic_atomic_units_claim_order_independent',
  late_recovery: 'beneficiaries_survive_share_burn', max_segments: 32, max_supply: '1000000',
  loss: 'principal_and_target_return_at_risk_no_guarantee',
  external_rights: 'fictional_title_no_verified_real_cargo_debt_or_disposal_rights',
  governance: 'research_addresses_do_not_establish_independent_organizations',
  direct_transfer: 'not_pool_repayment_requires_separate_reconciliation' });

const { max_segments: _segments, ...shared } = FINANCE_POLICY_V2;
export const FINANCE_POLICY = Object.freeze({ ...shared, version: 'agentbl-cash-rights-v3',
  max_subscription_segments_per_investor: 32,
  pricing: 'fixed_after_first_subscription_full_raise_must_reach_minimum',
  early_liquidation: 'delayed_governance_before_maturity_operator_may_only_freeze',
  issuer_keys: 'rotation_keeps_existing_titles_revocation_invalidates_them',
  collateral_release: 'anyone_may_retry_after_terminal_state' });

export function financePolicy(controlVersion) { return controlVersion >= 3 ? FINANCE_POLICY : FINANCE_POLICY_V2; }
