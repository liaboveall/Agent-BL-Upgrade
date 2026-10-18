import crypto from 'node:crypto';
import path from 'node:path';
import { STATE_BY_PRICING_ACTION } from '../core/pricingSchema.js';
import { HttpError } from './http.js';
import { subscriptionAvailability } from '../core/subscription.js';
import { Ledger } from '../ledger/ledger.js';
import { runtimeDir } from '../runtimePaths.js';

// In-memory data store for the AgentBL backend.
// Satisfies hackathon requirements for mock persistence without an external DB.
// Everything recorded here is a Demo simulation: no subscription touches a contract.

export const storeState = {
  pools: new Map(),
  investments: []
};

const ledgerBaseDir = process.env.AGENTBL_LEDGER_DIR || path.join(runtimeDir(), 'demo-ledger');
export const ledger = new Ledger({ baseDir: ledgerBaseDir });

export function resetStore() {
  storeState.pools.clear();
  storeState.investments = [];
}

export function createPool(poolId, caseData, quote, options = {}) {
  const pools = (options.store ?? storeState).pools;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const status = options.status
    ?? STATE_BY_PRICING_ACTION[quote.pricing_action]
    ?? 'Open';
  pools.set(poolId, {
    poolId,
    caseData,
    quote,
    status,
    subscribedUsd: 0,
    subscribedShares: 0,
    tokenSupply: quote.recommended_token_supply,
    redemptionValueUsd: quote.target_redemption_value_usd ?? 1,
    quoteVersion: 1,
    targetUsd: quote.expected_cash_to_exporter_usd ?? quote.requested_cash_usd,
    createdAt,
    quoteUpdatedAt: options.quoteUpdatedAt ?? createdAt,
    complianceStatus: options.complianceStatus ?? 'CLEARED',
    investorEligible: options.investorEligible ?? true
  });
  return pools.get(poolId);
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
  if (pool.caseData?.historical === true) {
    throw new HttpError(409, 'pool_historical', 'This is a historical demo pool kept for its testnet record; it is not open for subscription');
  }
  if (!subscriptionAvailability(pool).can_subscribe) {
    throw new HttpError(409, 'pool_not_open', `Cannot subscribe to pool in status: ${pool.status}`);
  }
  const budgetAtomic = Math.round(amountUsd * 1_000_000);
  const priceAtomic = Math.round(pool.quote.final_issue_price_usd * 1_000_000);
  if (!Number.isSafeInteger(budgetAtomic) || !Number.isSafeInteger(priceAtomic) || priceAtomic <= 0) {
    throw new HttpError(400, 'invalid_amount', 'Amount and price must fit six-decimal safe integer units');
  }
  const tokenCount = Math.floor(budgetAtomic / priceAtomic);
  if (tokenCount < 1) throw new HttpError(400, 'amount_too_small', 'The budget must cover at least one whole share');
  const remaining = subscriptionAvailability(pool).remaining_usd;
  if (amountUsd > remaining + 0.000001) {
    throw new HttpError(409, 'subscription_exceeds_target', 'Subscription exceeds target amount');
  }

  const paidAtomic = tokenCount * priceAtomic;
  const paidUsd = paidAtomic / 1_000_000;
  pool.subscribedUsd = Math.round((pool.subscribedUsd + paidUsd) * 1e6) / 1e6;
  pool.subscribedShares = (pool.subscribedShares ?? 0) + tokenCount;

  if (pool.subscribedShares >= pool.tokenSupply) {
    pool.status = 'Funded';
  }

  // A mock subscription has no transaction. The reference is a deterministic, clearly
  // non-chain identifier (never a 0x… string that could be mistaken for a tx hash).
  const reference = `demo:sub:${crypto.createHash('sha256')
    .update([walletAddress, poolId, amountUsd, storeState.investments.length].join('|'))
    .digest('hex').slice(0, 16)}`;
  const normalizedWalletAddress = String(walletAddress ?? '').toLowerCase();

  const investment = {
    reference,
    mode: 'demo',
    // Deprecated: kept (always null) for callers that still read it. Nothing was sent on-chain.
    txHash: null,
    walletAddress: normalizedWalletAddress,
    poolId,
    amountUsd: paidUsd,
    requestedBudgetUsd: amountUsd,
    unspentUsd: (budgetAtomic - paidAtomic) / 1_000_000,
    paidAmountAtomic: String(paidAtomic),
    quoteHash: pool.quote.quote_hash,
    quoteVersion: pool.quoteVersion,
    redemptionValueUsd: pool.redemptionValueUsd,
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

/**
 * Record a Live subscription intent in the persistent ledger before it is signed
 * or broadcast. The returned intent carries an `intent_id` that callers can use
 * to track the transaction through broadcast and confirmation.
 */
export async function recordLiveSubscriptionIntent({ walletAddress, poolId: _poolId, protocolInstance, chainPoolId, asset, amountAtomic, shares, calldata }) {
  return ledger.recordIntent({
    protocol_instance: protocolInstance,
    chain_pool_id: chainPoolId,
    operation: 'SUBSCRIBE',
    investor: walletAddress,
    asset,
    amount_atomic: amountAtomic,
    shares,
    calldata
  });
}
