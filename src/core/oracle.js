// On-chain oracle payload builder (BE-8).
//
// Maps a PricingQuote to the exact arguments the RiskPricingOracle and
// RWAOfferingPool need on-chain, so the AI's pricing decision can be written as
// a verifiable event. Two hashes travel with it:
//   evidence_hash anchors the INPUTS behind the price (valuation, risk, docs)
//   quote_hash    anchors the TERMS the pool opens with (price, supply, action)
//
// Pure / deterministic. See PRD §9.3 (RiskPricingOracle.updatePricing,
// RWAOfferingPool.createOffering) and src/core/pricingSchema.js.

import { PRICING_ACTION_TO_UINT8, RISK_LEVEL_TO_UINT8 } from './contractHarness.js';
import { normalizeHash32, STATE_BY_PRICING_ACTION } from './pricingSchema.js';

// Actions RiskPricingOracle.updatePricing forwards to RWAOfferingPool.applyPricingAction
// (codes 0-6). 7-9 are lifecycle actions the pool reports itself and updatePricing rejects.
const UPDATE_PRICING_ACTIONS = Object.freeze(
  Object.keys(PRICING_ACTION_TO_UINT8).filter((name) => PRICING_ACTION_TO_UINT8[name] <= 6)
);

/**
 * The exact arguments for RiskPricingOracle.updatePricing(poolId, issuePrice, riskLevel, action,
 * evidenceHash, quoteHash). Shared by the MCP tool and the Agent's chain executor so both encode
 * a quote identically. An unknown risk level or action throws: silently mapping it to a default
 * would put a different decision on-chain than the one the quote describes.
 * @param {object} quote a PricingQuote (risk_level, pricing_action, final_issue_price_usd, hashes)
 * @param {{pool_id:number|string}} opts the on-chain pool id
 */
export function toChainPricingArgs(quote, opts = {}) {
  if (!quote || typeof quote !== 'object') throw new TypeError('pricing quote is required');
  const poolId = Number(opts.pool_id);
  if (!Number.isSafeInteger(poolId) || poolId < 1) {
    throw new RangeError('pool_id must be a positive integer');
  }
  const price = Number(quote.final_issue_price_usd);
  if (!Number.isFinite(price) || price <= 0) {
    throw new RangeError('final_issue_price_usd must be a positive number');
  }
  const riskLevel = RISK_LEVEL_TO_UINT8[quote.risk_level];
  if (riskLevel === undefined) throw new RangeError(`unknown risk_level: ${String(quote.risk_level)}`);
  if (!UPDATE_PRICING_ACTIONS.includes(quote.pricing_action)) {
    throw new RangeError(`unknown or unsupported pricing_action: ${String(quote.pricing_action)}`);
  }
  return {
    pool_id: poolId,
    issue_price_e6: Math.round(price * 1_000_000),
    risk_level: riskLevel,
    pricing_action: PRICING_ACTION_TO_UINT8[quote.pricing_action],
    evidence_hash: normalizeHash32(quote.evidence_hash, 'evidence_hash'),
    quote_hash: normalizeHash32(quote.quote_hash, 'quote_hash')
  };
}

/**
 * Build the RiskPricingOracle / RWAOfferingPool update payload from a quote.
 * @param {object} quote a validated PricingQuote
 * @param {object} [opts] { pool_id }
 * @returns the on-chain update payload (snake_case, JSON-serialisable)
 */
export function toOracleUpdate(quote, opts = {}) {
  return {
    pool_id: opts.pool_id ?? null,
    case_id: quote.case_id,
    bl_id: quote.bl_id,
    // RiskPricingOracle.updatePricing(poolId, issuePrice, riskLevel, action, evidenceHash)
    issue_price_usd: quote.final_issue_price_usd,
    risk_level: quote.risk_level,
    risk_score_bps: quote.risk_score_bps,
    pricing_action: quote.pricing_action,
    offering_state: STATE_BY_PRICING_ACTION[quote.pricing_action] ?? null,
    evidence_hash: normalizeHash32(quote.evidence_hash, 'evidence_hash'),
    quote_hash: normalizeHash32(quote.quote_hash, 'quote_hash'),
    // RWAOfferingPool.createOffering(eblId, tokenSupply, issuePrice, targetRedemptionValue)
    recommended_token_supply: quote.recommended_token_supply,
    target_redemption_value_usd: quote.target_redemption_value_usd,
    target_redemption_exposure_usd: quote.target_redemption_exposure_usd
  };
}
