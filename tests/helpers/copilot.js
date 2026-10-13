export function pool(id, options = {}) {
  const { commodity = 'Copper Cathodes', risk = 'MEDIUM', score = 2000, yieldBps = 1000, status = 'Open', ...extra } = options;
  return {
    poolId: id, status, subscribedUsd: 0, targetUsd: 100000,
    createdAt: new Date(0).toISOString(), quoteUpdatedAt: new Date(0).toISOString(), complianceStatus: 'CLEARED', investorEligible: true,
    caseData: { case_id: id, cargo: { commodity }, bill_of_lading: { cargo: commodity,
      port_of_loading: 'Singapore', port_of_discharge: 'Shanghai', issue_date: '2026-06-01', eta: '2026-06-15', carrier: 'Example' }, insurance: { coverage_ratio: 1.1 } },
    quote: { final_issue_price_usd: 0.8, implied_gross_yield_bps: yieldBps, risk_level: risk, risk_score_bps: score,
      requested_cash_usd: 100000, ai_verified_collateral_value_usd: 200000, target_redemption_exposure_usd: 125000,
      payout_speed: 'BALANCED', quote_hash: `quote-${id}` }, ...extra
  };
}
