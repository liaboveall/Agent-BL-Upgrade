// Scenario compensation is a policy assumption, never a fitted default probability.
export const RESEARCH_CONSTRAINTS = Object.freeze({ version: 'research-feasibility-v1', funding_rate_bps: 300, operations_rate_bps: 100, loss_buffer_bps: 100 });
export function researchConstraints(input = {}) {
  const policy = { ...RESEARCH_CONSTRAINTS, ...input };
  for (const key of ['funding_rate_bps', 'operations_rate_bps', 'loss_buffer_bps']) {
    if (!Number.isInteger(policy[key]) || policy[key] < 0 || policy[key] > 10000) throw new TypeError(`Invalid research constraint: ${key}`);
  }
  if (Object.keys(input).some((key) => !['funding_rate_bps', 'operations_rate_bps', 'loss_buffer_bps'].includes(key))) throw new TypeError('Unknown research constraint');
  return policy;
}
export function feasibility({ cash, profit, maxProfitShare, annualCap, tenorDays, collateral, policy }) {
  const rate = (policy.funding_rate_bps + policy.operations_rate_bps + policy.loss_buffer_bps) / 10000;
  const lower = cash * rate * tenorDays / 365;
  const borrower = Math.min(Math.max(0, profit) * maxProfitShare, cash * annualCap * tenorDays / 365);
  const upper = Math.min(borrower, Math.max(0, collateral - cash));
  return { lower, upper, feasible: cash > 0 && lower <= upper && collateral >= cash,
    annual_floor_bps: Math.round(rate * 10000), borrower_ceiling: borrower };
}
export function researchSensitivity(input) {
  return [['base', {}], ['low_profit', { profit: input.profit * 0.25 }],
    ['high_funding_cost', { policy: { ...input.policy, funding_rate_bps: Math.min(10000, input.policy.funding_rate_bps + 1000) } }],
    ['high_loss_pressure', { policy: { ...input.policy, loss_buffer_bps: Math.min(10000, input.policy.loss_buffer_bps + 2000) } }]
  ].map(([scenario, change]) => {
    const value = feasibility({ ...input, ...change });
    return { scenario, investor_floor_usd: Math.ceil(value.lower * 100) / 100, total_ceiling_usd: Math.floor(value.upper * 100) / 100,
      feasible: value.feasible, outcome: value.feasible ? 'FEASIBLE_RESEARCH_ONLY' : 'REJECT_NO_COMMON_INTERVAL' };
  });
}
