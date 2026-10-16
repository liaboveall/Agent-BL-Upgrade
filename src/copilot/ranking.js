import { retrieveRiskIntel } from '../agent/riskIntel.js';
import { annualYieldBps } from './retrieval.js';

const clamp = (number) => Math.max(0, Math.min(1, Number.isFinite(number) ? number : 0));
const round = (number) => Math.round(number * 1e6) / 1e6;
const tie = (a, b) => a.pool_id < b.pool_id ? -1 : a.pool_id > b.pool_id ? 1 : 0;
const LEVEL_RANK = { LOW: 0, MEDIUM: 1, WARNING: 2, CRITICAL: 3 };
// Risk penalty in [0, 1]: mostly the risk level, refined by the score within it (scores run up to 1800 bps).
const riskPenalty = (q) => 0.7 * clamp((LEVEL_RANK[q.risk_level] ?? 3) / 3) + 0.3 * clamp(q.risk_score_bps / 1800);

export function rankCandidates(candidates, context) {
  const lowRisk = context.constraints.risk_max === 'LOW' || context.soft.prefer_low_volatility;
  const weights = lowRisk ? { yield: 0.2, risk: 0.5, preference: 0.2, coverage: 0.1 }
    : { yield: 0.4, risk: 0.3, preference: 0.2, coverage: 0.1 };
  return candidates.map((candidate) => {
    const c = candidate, q = c.quote;
    const warnings = [];
    if (q.risk_level === 'WARNING' || q.risk_level === 'CRITICAL') warnings.push('elevated_risk');
    if (!['Open', 'Repriced', 'Subscribed'].includes(c.status)) warnings.push('not_subscribable');
    if (c.compliance !== 'CLEARED') warnings.push('compliance_review');
    if (c.stale) warnings.push('stale_quote');
    const breakdown = {
      // Annualized, so a short deal and a long one compare fairly; 30% a year saturates the term.
      yield: round(weights.yield * clamp(annualYieldBps(q) / 3000)),
      risk: round(-weights.risk * riskPenalty(q)),
      preference: round(weights.preference * (clamp(c.text_score / 5) * 0.7 + (context.soft.prefer_short_tenor && c.tenor_days !== null ? 0.3 * clamp(1 - c.tenor_days / 60) : 0))),
      coverage: round(weights.coverage * clamp(c.collateral_coverage / 2)),
      penalties: round(-warnings.reduce((sum, warning) => sum + ({ elevated_risk: 0.15, not_subscribable: 0.3, compliance_review: 0.2, stale_quote: 0.15 }[warning]), 0))
    };
    return { ...c, warnings, breakdown, score: round(Object.values(breakdown).reduce((a, b) => a + b, 0)), weights };
  }).sort((a, b) => b.score - a.score || tie(a, b));
}

/** MMR: diversify exploration across both commodity and route while retaining relevance. */
export function diversify(items, limit) {
  const remaining = [...items], selected = [];
  while (remaining.length && selected.length < limit) {
    const mmr = (candidate) => candidate.score - 0.22 * Math.max(0, ...selected.map((other) =>
      (candidate.commodity === other.commodity ? 0.7 : 0) + (candidate.route === other.route ? 0.3 : 0)));
    remaining.sort((a, b) => mmr(b) - mmr(a) || tie(a, b));
    selected.push(remaining.shift());
  }
  return selected;
}

export function recommendation(item, rank, locale) {
  const q = item.quote, zh = locale === 'zh';
  return {
    pool_id: item.pool_id, case_id: item.case_id, label: item.label, route: item.route, rank,
    score: item.score, breakdown: item.breakdown, weights: item.weights, status: item.status,
    price_usd: q.final_issue_price_usd, yield_bps: q.implied_gross_yield_bps, annualized_yield_bps: annualYieldBps(q),
    risk_level: q.risk_level, risk_score_bps: q.risk_score_bps, tenor_days: item.tenor_days,
    remaining_usd: item.remaining_usd, insurance_coverage: item.insurance_coverage,
    quote_hash: q.quote_hash ?? null, decision_id: item.decision?.decision_id ?? null,
    source: 'offchain-mirror',
    reasons: [zh ? '按最新报价、风险和抵押覆盖排序；收益为融资期限内的指示性毛收益，另附年化折算。' : 'Ranked using current quote, risk and collateral coverage; yield is the indicative gross yield over the financing tenor, with its annualized equivalent.'],
    warnings: item.warnings,
    evidence: [
      { kind: 'quote', id: q.quote_hash ?? null, source: 'pricing-engine' },
      ...(item.decision ? [{ kind: 'decision', id: item.decision.decision_id, action: item.decision.action }] : []),
      ...retrieveRiskIntel(item.caseData, { k: 2 }).map((entry) => ({ kind: 'risk_intel', id: entry.id, source: entry.source, mode: 'fixture', text: entry.snippet }))
    ]
  };
}
