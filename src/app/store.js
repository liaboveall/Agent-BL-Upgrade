import crypto from 'node:crypto';
import { STATE_BY_PRICING_ACTION } from '../core/pricingSchema.js';
import { HttpError } from './http.js';

// In-memory data store for the AgentBL backend.
// Satisfies hackathon requirements for mock persistence without an external DB.
// Everything recorded here is a Demo simulation: no subscription touches a contract.

export const storeState = {
  pools: new Map(),
  investments: []
};

export function resetStore() {
  storeState.pools.clear();
  storeState.investments = [];
}

export function createPool(poolId, caseData, quote, options = {}) {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const status = options.status
    ?? STATE_BY_PRICING_ACTION[quote.pricing_action]
    ?? 'Open';
  storeState.pools.set(poolId, {
    poolId,
    caseData,
    quote,
    status,
    subscribedUsd: 0,
    targetUsd: quote.requested_cash_usd,
    createdAt,
    quoteUpdatedAt: options.quoteUpdatedAt ?? createdAt,
    complianceStatus: options.complianceStatus ?? 'CLEARED',
    investorEligible: options.investorEligible ?? true
  });
  return storeState.pools.get(poolId);
}

/**
 * Record a (mock) subscription. `amountUsd` must already be a finite number:
 * anything else used to slip through the `<= 0` / `>` comparisons (NaN and
 * strings compare false) and corrupt the pool's running total.
 */
export function subscribeToPool(walletAddress, poolId, amountUsd, options = {}) {
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new HttpError(400, 'invalid_amount', 'Subscription amount must be a finite number greater than 0');
  }
  const pool = storeState.pools.get(poolId);
  if (!pool) throw new HttpError(404, 'pool_not_found', 'Pool not found');
  if (!['Open', 'Repriced', 'Subscribed'].includes(pool.status)) {
    throw new HttpError(409, 'pool_not_open', `Cannot subscribe to pool in status: ${pool.status}`);
  }
  if (pool.subscribedUsd + amountUsd > pool.targetUsd) {
    throw new HttpError(409, 'subscription_exceeds_target', 'Subscription exceeds target amount');
  }

  pool.subscribedUsd += amountUsd;

  if (pool.subscribedUsd >= pool.targetUsd) {
    pool.status = 'Funded';
  }

  // A mock subscription has no transaction. The reference is a deterministic, clearly
  // non-chain identifier (never a 0x… string that could be mistaken for a tx hash).
  const reference = `demo:sub:${crypto.createHash('sha256')
    .update([walletAddress, poolId, amountUsd, storeState.investments.length].join('|'))
    .digest('hex').slice(0, 16)}`;
  const tokenCount = amountUsd / (pool.quote.final_issue_price_usd || 1);
  const normalizedWalletAddress = String(walletAddress ?? '').toLowerCase();

  const investment = {
    reference,
    mode: 'demo',
    // Deprecated: kept (always null) for callers that still read it. Nothing was sent on-chain.
    txHash: null,
    walletAddress: normalizedWalletAddress,
    poolId,
    amountUsd,
    tokenCount,
    price: pool.quote.final_issue_price_usd,
    yieldBps: pool.quote.implied_gross_yield_bps,
    riskLevel: pool.quote.risk_level,
    label: pool.caseData?.bill_of_lading?.cargo || poolId,
    source: options.source ? structuredClone(options.source) : null,
    timestamp: new Date().toISOString()
  };

  storeState.investments.push(investment);
  return { reference, mode: 'demo', txHash: null, investment, poolStatus: pool.status };
}
