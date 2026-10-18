const presentNumber = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
export function sourceState({ value, status, observed_at, expires_at, source }, now = Date.now()) {
  let state = status === 'offline' ? 'fixture' : status;
  if (!presentNumber(value)) state = 'unavailable';
  else if (!['live', 'stale', 'fixture', 'unavailable'].includes(state)) state = status == null ? 'fixture' : 'unavailable';
  if (state === 'live') {
    const observed = Date.parse(observed_at ?? ''), expires = Date.parse(expires_at ?? '');
    if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now + 300000) state = 'unavailable';
    else if (expires <= now) state = 'stale';
  }
  return { status: state, source: source ?? 'repository_research_assumption', observed_at: observed_at ?? null,
    expires_at: expires_at ?? null, applicability: 'research_reference_requires_responsible_review' };
}
export function pricingFieldSources(caseData, economics, collateral, now) {
  const data = caseData.real_data ?? {};
  return {
    invoice: sourceState({ value: economics.invoice_value_usd, status: 'fixture', source: 'declared_invoice_not_independently_verified' }, now),
    cost: sourceState({ value: economics.cost_of_goods_usd, status: 'fixture', source: economics.profit_basis }, now),
    collateral: sourceState({ value: collateral, status: 'fixture', source: 'deterministic_rule_estimate_not_realizable_cargo_value' }, now),
    market: sourceState({ status: data.status, observed_at: data.observed_at, expires_at: data.expires_at,
      value: caseData.market?.reference_price_usd_per_mt ?? caseData.market?.current_price_usd_per_mt ?? caseData.market?.reference_price_usd_per_bbl,
      source: caseData.market?.source }, now),
    risk: { status: ['stale', 'unavailable'].includes(data.status) ? data.status : 'fixture',
      source: 'deterministic_research_pressure_rules', applicability: 'risk_pressure_not_default_probability' }
  };
}
