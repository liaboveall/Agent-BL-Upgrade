import { poolCandidate, retrieve, tokenize } from './retrieval.js';
import { rankCandidates, diversify, recommendation } from './ranking.js';

// Persist only the vocabulary needed to repeat a search, never the original chat.
export function searchSpec(query, context, turn, pools) {
  const vocabulary = new Set(pools.flatMap((pool) => {
    const data = pool.caseData ?? {}, bl = data.bill_of_lading ?? {};
    return tokenize(`${bl.cargo ?? ''} ${bl.port_of_loading ?? ''} ${bl.port_of_discharge ?? ''} ${bl.carrier ?? ''} ${data.note ?? ''}`);
  }));
  return {
    terms: [...new Set(tokenize(query.message))].filter((term) => vocabulary.has(term)).slice(0, 128).map((term) => term.slice(0, 60)),
    limit: query.limit, pool_ids: query.pool_ids ?? [],
    constraints: turn.intent === 'COMPARE' && turn.constraints_delta.commodities_include?.length
      ? { ...context.constraints, commodities_include: turn.constraints_delta.commodities_include } : context.constraints,
    explore: turn.intent === 'EXPLORATORY_BROWSE' || !!context.soft.diversify,
    tracked_pool_ids: []
  };
}

export function rankSnapshot(pools, decisions, context, spec, now) {
  const latest = new Map(), documentVerdicts = new Map();
  for (const decision of decisions) {
    if (decision.mode && (decision.mode !== context.mode || decision.generation !== undefined && decision.generation !== context.generation)) continue;
    const key = decision.pool_id ?? decision.case_id;
    if (!latest.has(key)) latest.set(key, decision);
    const verdict = ['HOLD_FOR_REVIEW', 'REJECT'].includes(decision.action)
      || ['DOCUMENTS_INGESTED', 'REVIEW_RESOLVED'].includes(decision.event_type) && ['OPEN', 'OPEN_WITH_WARNING'].includes(decision.action);
    if (verdict && !documentVerdicts.has(key)) documentVerdicts.set(key, decision);
  }
  const candidates = pools.filter((pool) => pool.quote && (!spec.pool_ids.length || spec.pool_ids.includes(pool.poolId))).map((pool) => ({
    ...poolCandidate(pool, latest.get(pool.poolId) ?? latest.get(pool.caseData?.case_id), now),
    document_verdict: documentVerdicts.get(pool.poolId) ?? documentVerdicts.get(pool.caseData?.case_id)
  }));
  const { included, excluded } = retrieve(candidates, { ...context, constraints: spec.constraints }, spec.terms);
  const ranked = rankCandidates(included, context);
  const selected = spec.explore ? diversify(ranked, spec.limit) : ranked.slice(0, spec.limit);
  return {
    recommendations: selected.map((item, index) => recommendation(item, index + 1, context.locale)),
    matched: included.length,
    excluded_notable: rankCandidates(excluded, context).slice(0, 3).map((item) => ({ pool_id: item.pool_id, label: item.label, reasons: item.exclusion_reasons, score: item.score }))
  };
}

export function recommendationItems(recommendations) {
  return recommendations.map(({ pool_id, rank, score, price_usd, status, risk_level, quote_hash }) => ({ pool_id, rank, score, price_usd, status, risk_level, quote_hash }));
}

export function rankChanges(before, after, priorChanges = []) {
  const old = new Map(before.map((item) => [item.pool_id, item]));
  const next = new Map(after.map((item) => [item.pool_id, item]));
  const changes = [...new Set([...old.keys(), ...next.keys()])].flatMap((pool_id) => {
    const a = old.get(pool_id), b = next.get(pool_id);
    if (a && b && JSON.stringify(a) === JSON.stringify(b)) return [];
    return [{ pool_id, previous_rank: a?.rank ?? null, rank: b?.rank ?? null,
      previous_price_usd: a?.price_usd ?? null, price_usd: b?.price_usd ?? null }];
  });
  // A fast executor can already affect the first notification. Keep the baseline of
  // that decision when its confirmation follows, rather than replacing it with an empty delta.
  const combined = new Map(changes.map((change) => [change.pool_id, change]));
  for (const prior of priorChanges) combined.set(prior.pool_id, {
    ...prior, rank: next.get(prior.pool_id)?.rank ?? null, price_usd: next.get(prior.pool_id)?.price_usd ?? null
  });
  return [...combined.values()];
}
