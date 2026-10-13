import { riskLevelRank } from '../core/schema.js';
import { commodityOf, COMMODITY_TERMS, REGION_TERMS } from './intentRouter.js';

export function tokenize(text) {
  const aliases = [...COMMODITY_TERMS, ...REGION_TERMS];
  // One pass prevents the canonical copper_concentrate token being expanded again as copper.
  const combined = new RegExp(aliases.map(([, pattern]) => `(?:${pattern.source})`).join('|'), 'giu');
  const value = String(text ?? '').toLowerCase().replace(combined, (match) =>
    ` ${aliases.find(([, pattern]) => new RegExp(`^(?:${pattern.source})$`, 'iu').test(match))[0]} `);
  return value.match(/[a-z_][a-z_0-9]*|[\u3400-\u9fff]{2}/gu) ?? [];
}

/** BM25 over the current pool snapshot; no external embeddings or stale catalogue risk hints. */
export function bm25(query, texts) {
  const documents = texts.map(tokenize);
  const average = documents.reduce((sum, terms) => sum + terms.length, 0) / Math.max(1, documents.length) || 1;
  const terms = [...new Set(tokenize(query))];
  return documents.map((document) => terms.reduce((score, term) => {
    const frequency = document.filter((token) => token === term).length;
    if (!frequency) return score;
    const containing = documents.filter((tokens) => tokens.includes(term)).length;
    const idf = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
    return score + idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * document.length / average));
  }, 0));
}

export function poolCandidate(pool, decision, now = Date.now()) {
  const data = pool.caseData ?? {}, bl = data.bill_of_lading ?? {}, quote = pool.quote;
  const departure = Date.parse(bl.shipped_on_board ?? bl.issue_date), arrival = Date.parse(bl.eta);
  const tenor = Number.isFinite(arrival - departure) && arrival >= departure ? Math.ceil((arrival - departure) / 86_400_000) : null;
  const route = [bl.port_of_loading, bl.port_of_discharge].filter(Boolean).join(' → ');
  const routeEvidence = `${route} ${JSON.stringify(data.shipment_events ?? [])}`.toLowerCase();
  const countries = [['china', /shanghai|qingdao|tianjin|lianyungang|foshan|中国|上海|青岛|天津|连云港|佛山/u], ['australia', /port hedland|australia/u], ['chile', /antofagasta|chile/u]]
    .filter(([, pattern]) => pattern.test(routeEvidence)).map(([country]) => country).join(' ');
  const age = now - Date.parse(pool.quoteUpdatedAt ?? pool.createdAt);
  return {
    pool_id: pool.poolId, case_id: data.case_id ?? pool.poolId,
    label: bl.cargo ?? data.cargo?.commodity ?? pool.poolId,
    commodity: commodityOf(`${data.cargo?.commodity ?? ''} ${bl.cargo ?? ''}`), route,
    status: pool.status, quote, tenor_days: tenor,
    insurance_coverage: data.insurance?.coverage_ratio ?? null,
    collateral_coverage: quote.ai_verified_collateral_value_usd / Math.max(1, quote.target_redemption_exposure_usd),
    remaining_usd: Math.max(0, pool.targetUsd - pool.subscribedUsd),
    compliance: pool.complianceStatus ?? 'UNKNOWN',
    eligible: pool.investorEligible !== false, decision,
    stale: !Number.isFinite(age) || age > 3600_000,
    geography: `${routeEvidence} ${countries} ${data.region ?? ''}`.toLowerCase(),
    text: `${bl.cargo ?? ''} ${route} ${bl.carrier ?? ''} ${data.note ?? ''}`, caseData: data
  };
}

export function exclusionReasons(candidate, constraints) {
  const c = candidate, q = c.quote, reasons = [];
  if (!['Open', 'Repriced', 'Funded', 'Subscribed', 'InTransit', 'Paused'].includes(c.status)) reasons.push('inactive_pool');
  if (!c.eligible || c.compliance === 'BLOCKED') reasons.push('compliance_block');
  if (['HOLD_FOR_REVIEW', 'REJECT'].includes(c.document_verdict?.action ?? c.decision?.action)) reasons.push('agent_hold');
  if (riskLevelRank(q.risk_level) < 0) reasons.push('unknown_risk');
  if (constraints.risk_max && riskLevelRank(q.risk_level) > riskLevelRank(constraints.risk_max)) reasons.push('risk_max');
  if (constraints.yield_min_bps !== undefined && q.implied_gross_yield_bps < constraints.yield_min_bps) reasons.push('yield_min_bps');
  if (constraints.tenor_days_max !== undefined && (c.tenor_days === null || c.tenor_days > constraints.tenor_days_max)) reasons.push('tenor_days_max');
  if (constraints.commodities_include.length && !constraints.commodities_include.includes(c.commodity)) reasons.push('commodities_include');
  if (constraints.commodities_exclude.includes(c.commodity)) reasons.push('commodities_exclude');
  if (constraints.regions_include.some((name) => !c.geography.includes(name))) reasons.push('regions_include');
  if (constraints.regions_exclude.some((name) => c.geography.includes(name))) reasons.push('regions_exclude');
  if (constraints.chokepoints_avoid.some((name) => c.geography.includes(name))) reasons.push('chokepoints_avoid');
  if (constraints.ticket_usd !== undefined && (constraints.ticket_usd > c.remaining_usd || !['Open', 'Repriced'].includes(c.status))) reasons.push('ticket_usd');
  if (constraints.financing_max_usd !== undefined && q.requested_cash_usd > constraints.financing_max_usd) reasons.push('financing_max_usd');
  if (constraints.insurance_coverage_min !== undefined && (c.insurance_coverage === null || c.insurance_coverage < constraints.insurance_coverage_min)) reasons.push('insurance_coverage_min');
  if (constraints.payout_speed && constraints.payout_speed !== q.payout_speed) reasons.push('payout_speed');
  return reasons;
}

export function retrieve(candidates, context, query) {
  const textScores = bm25(query, candidates.map((candidate) => candidate.text));
  const included = [], excluded = [];
  candidates.forEach((candidate, index) => {
    const reasons = exclusionReasons(candidate, context.constraints);
    const item = { ...candidate, text_score: textScores[index] };
    if (reasons.length) excluded.push({ ...item, exclusion_reasons: reasons });
    else included.push(item);
  });
  return { included, excluded };
}
