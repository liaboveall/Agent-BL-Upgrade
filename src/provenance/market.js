import { hashSnapshot } from '../agent/decisionLogger.js';

export const CALIBRATION = Object.freeze({ schema: 'agentbl-research-calibration-v1', version: '2026-10-17.1',
  status: 'research_parameters_unvalidated', day_count: 'ACT/365', base_annual_rate_bps: { FAST: 1200, BALANCED: 900, LOW_COST: 700 },
  risk_score_semantics: 'risk_pressure_not_default_probability', payout_sla: null,
  source: 'repository_policy_requires_independent_business_calibration', max_observation_age_ms: 3 * 86400000,
  max_source_spread_bps: 500, extreme_change_bps: 2500 });
export const CALIBRATION_HASH = hashSnapshot(CALIBRATION);
const finitePositive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Applicability is independent of retrieval success. Matching a benchmark does not establish a
 * cargo's realizable value. Explicit basis/region/grade and approved deductions remain necessary. */
export function assessMarketEvidence(caseData, quote, { now = Date.now(), alternatives = [], calendar = null } = {}) {
  const market = caseData?.market ?? {}, reasons = [];
  if (!quote) reasons.push('MISSING_SOURCE');
  const observed = Date.parse(quote?.observed_at ?? quote?.as_of ?? '');
  if (!Number.isFinite(observed) || observed > now + 300000) reasons.push('INVALID_OBSERVATION_TIME');
  else if (now - observed >= CALIBRATION.max_observation_age_ms || quote?.status === 'stale') reasons.push('STALE_SOURCE');
  if (quote && quote.status !== 'live') reasons.push('UNVERIFIED_OR_OFFLINE_SOURCE');
  const price = quote?.price_usd_per_mt ?? quote?.price_usd_per_bbl;
  if (!finitePositive(price)) reasons.push('INVALID_PRICE');
  if (quote?.key !== market.benchmark_key) reasons.push('BENCHMARK_MISMATCH');
  const basis = market.valuation_basis;
  for (const field of ['grade', 'region', 'currency', 'unit', 'instrument', 'calendar_version', 'basis_source']) if (typeof basis?.[field] !== 'string' || !basis[field].trim()) reasons.push(`MISSING_${field.toUpperCase()}`);
  if (basis?.currency && basis.currency !== 'USD') reasons.push('UNSUPPORTED_CURRENCY');
  if (basis?.unit && basis.unit !== (quote?.price_usd_per_mt !== undefined ? 'USD/MT' : 'USD/bbl')) reasons.push('UNIT_MISMATCH');
  if (!Number.isInteger(basis?.liquidation_cost_bps) || basis.liquidation_cost_bps < 0 || basis.liquidation_cost_bps > 10000
    || !Number.isInteger(basis?.insurance_deduction_bps) || basis.insurance_deduction_bps < 0 || basis.insurance_deduction_bps > 10000
    || (basis?.liquidation_cost_bps ?? 0) + (basis?.insurance_deduction_bps ?? 0) >= 10000) reasons.push('UNVERIFIED_DEDUCTIONS');
  if (!calendar || calendar.version !== basis?.calendar_version || calendar.state !== 'open') reasons.push('MARKET_CALENDAR_REVIEW');
  if (quote?.change_1m === null || quote?.change_1m === undefined || !Number.isFinite(quote.change_1m)) reasons.push('MISSING_VOLATILITY');
  else if (Math.abs(quote.change_1m) * 10000 >= CALIBRATION.extreme_change_bps) reasons.push('EXTREME_VOLATILITY');
  for (const other of alternatives) {
    const otherPrice = other.price_usd_per_mt ?? other.price_usd_per_bbl;
    if (other.key !== quote?.key || other.quoted_unit !== quote?.quoted_unit || !finitePositive(otherPrice)
      || other.status !== 'live' || !Number.isFinite(Date.parse(other.observed_at ?? ''))
      || now - Date.parse(other.observed_at) >= CALIBRATION.max_observation_age_ms) reasons.push('ALTERNATE_SOURCE_INAPPLICABLE');
    else if (Math.abs(otherPrice - price) / price * 10000 > CALIBRATION.max_source_spread_bps) reasons.push('SOURCE_CONFLICT');
  }
  return { schema: 'agentbl-market-provenance-v1', calibration_version: CALIBRATION.version, calibration_hash: CALIBRATION_HASH,
    applicability: reasons.length ? 'REVIEW' : 'REFERENCE_ONLY', review_required: true, reasons: [...new Set(reasons)],
    valuation_basis: 'rule_estimate', independent_valuation_verified: false, business_enabled: false,
    source_hash: hashSnapshot(quote ?? null), basis_hash: hashSnapshot(basis ?? null),
    net_reference_price: reasons.length ? null : price * (1 - (basis.liquidation_cost_bps + basis.insurance_deduction_bps) / 10000) };
}

export function actualFinancingPeriod({ fundedAt, maturityAt, priceAtomic, redemptionAtomic, feeAtomic = '0' }) {
  const from = Date.parse(fundedAt), until = Date.parse(maturityAt);
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) throw new Error('A positive actual financing period is required');
  const price = BigInt(priceAtomic), target = BigInt(redemptionAtomic), fee = BigInt(feeAtomic);
  if (price <= 0n || target < 0n || fee < 0n || fee > target) throw new Error('Invalid financing cash amounts');
  const days = (until - from) / 86400000;
  const gross = Number((target - price) * 100000000n / price) / 100000000;
  const net = Number((target - fee - price) * 100000000n / price) / 100000000;
  return { day_count: 'ACT/365', funded_at: new Date(from).toISOString(), maturity_at: new Date(until).toISOString(),
    remaining_days: days, gross_yield: gross, annualized_gross_yield: gross * 365 / days, annualized_net_yield: net * 365 / days };
}
