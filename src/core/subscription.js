// The same eligibility predicate is used by HTTP, Copilot and the marketplace.
export const SUBSCRIBABLE_STATES = Object.freeze(['Open', 'Subscribed', 'Repriced']);
export function subscriptionAvailability(pool) {
  const state = pool.status ?? pool.state;
  const total = Number(pool.targetUsd ?? pool.target_usd);
  const used = Number(pool.subscribedUsd ?? pool.subscribed_usd);
  const supply = pool.tokenSupply ?? pool.token_supply, shares = pool.subscribedShares ?? pool.subscribed_shares;
  const shareCapacity = supply != null && shares != null
    ? Math.max(0, supply - shares) * pool.quote?.final_issue_price_usd : null;
  const remaining = Number.isFinite(shareCapacity) ? Math.round(shareCapacity * 1e6) / 1e6
    : Number.isFinite(total) && Number.isFinite(used) ? Math.max(0, total - used) : null;
  let reason = null;
  if (pool.historical || pool.caseData?.historical) reason = 'historical';
  else if (!SUBSCRIBABLE_STATES.includes(state)) reason = 'lifecycle_closed';
  else if (['PAUSE_OFFERING', 'FREEZE_POOL', 'TRIGGER_LIQUIDATION'].includes(pool.quote?.pricing_action)) reason = 'quote_closed';
  else if (pool.quote?.data_quality?.status === 'live' && Number.isFinite(Date.parse(pool.quote.data_quality.expires_at))
      && Date.parse(pool.quote.data_quality.expires_at) <= Date.now()) reason = 'data_expired';
  else if (pool.chainOnly || pool.chainQuoteMismatch || pool.investorEligible === false) reason = 'unverified_terms';
  else if (remaining === null || remaining <= 0) reason = 'no_capacity';
  return { can_subscribe: reason === null, remaining_usd: remaining, subscription_disabled_reason: reason };
}
