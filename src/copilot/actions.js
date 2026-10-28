import crypto from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../app/http.js';
import { parseIntent, commodityOf } from './intentRouter.js';
import { poolCandidate, exclusionReasons } from './retrieval.js';

export const actionSchema = z.object({
  id: z.uuid(), type: z.enum(['ACTION_SUBSCRIBE', 'ACTION_BUY_REPORT']), mode: z.enum(['demo', 'live']), generation: z.number().int(),
  status: z.enum(['PENDING', 'CONFIRMING', 'COMPLETED', 'CANCELLED']), expires_at: z.iso.datetime(),
  pool_id: z.string(), case_id: z.string(), label: z.string(), route: z.string(),
  amount_usd: z.number().positive(), budget_usd: z.number().positive().nullable(), price_usd: z.number().positive(),
  shares: z.string().nullable(), quote_hash: z.string().nullable(), risk_level: z.string(),
  service_id: z.string().optional(), endpoint: z.string().optional(), service_title: z.string().optional(),
  chain: z.object({ pool_id: z.number().int().positive(), chain_id: z.number().int().positive(), contract: z.string(), price_e6: z.string(),
    protocol_version: z.number().optional(), settlement_asset: z.string().nullable().optional() }).optional(),
  result: z.object({ mode: z.enum(['demo', 'chain']), reference: z.string().optional(), txHash: z.string().nullable().optional(),
    amountUsd: z.number().optional(), tokenCount: z.number().optional(), price: z.number().optional(), poolStatus: z.string().optional() }).optional()
});

const blocked = (type, code, extra = {}) => ({ type, confirmation_required: true, executed: false, blocked: code, ...extra });

// Convert the decimal value to whole USDC micros without rounding up or multiplying a float.
export function usdMicros(value) {
  const [, whole, fraction = '', exponent = '0'] = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u);
  const coefficient = BigInt(whole + fraction), shift = 6 - fraction.length + Number(exponent);
  return shift >= 0 ? coefficient * 10n ** BigInt(shift) : coefficient / 10n ** BigInt(-shift);
}

export async function proposeAction({ query, turn, context, recommendations, getLiveOffering, services, now }) {
  const type = turn.intent;
  if (!context.history.length || !recommendations.length) return blocked(type, 'select_pool');
  // A rank alone does not express consent to a particular asset.
  if (recommendations.length !== 1 && query.pool_ids?.length !== 1) return blocked(type, 'select_pool');
  const item = recommendations[0];
  const explicit = parseIntent(query.message, context).constraints_delta;
  if (explicit.commodities_include?.length && !explicit.commodities_include.includes(commodityOf(item.label))) return blocked(type, 'select_pool');
  const budget = context.constraints.ticket_usd ?? null;
  // Money for an action is parsed again without any model involvement.
  const explicitAmount = explicit.ticket_usd;
  const base = { id: crypto.randomUUID(), type, mode: context.mode, generation: context.generation, status: 'PENDING',
    expires_at: new Date(Math.min(now + 300_000, Date.parse(context.expires_at))).toISOString(),
    pool_id: item.pool_id, case_id: item.case_id, label: item.label, route: item.route, quote_hash: item.quote_hash,
    risk_level: item.risk_level, budget_usd: budget, shares: null };
  if (type === 'ACTION_BUY_REPORT') {
    const requested = query.service_id ?? (/估值|valuation/iu.test(query.message) ? 'premium-valuation' : /反欺诈|fraud|document/iu.test(query.message) ? 'fraud-review' : 'premium-risk');
    const service = services.find((entry) => entry.serviceId === requested);
    if (!service) return blocked(type, 'service_unavailable');
    if (budget !== null && service.priceUSDC > budget) return blocked(type, 'budget_exceeded');
    return actionSchema.parse({ ...base, amount_usd: service.priceUSDC, price_usd: service.priceUSDC,
      service_id: service.serviceId, service_title: service.title, endpoint: service.endpoint });
  }
  const amount = explicitAmount ?? budget;
  if (amount === undefined || amount === null || !(amount > 0)) return blocked(type, 'amount_required');
  if (budget !== null && amount > budget) return blocked(type, 'budget_exceeded');
  if (item.warnings.some((warning) => ['not_subscribable', 'compliance_review', 'stale_quote'].includes(warning))) return blocked(type, 'pool_unavailable');
  if (amount > item.remaining_usd) return blocked(type, 'capacity_exceeded');
  if (context.mode === 'demo') return actionSchema.parse({ ...base, amount_usd: amount, price_usd: item.price_usd, shares: String(amount / item.price_usd) });
  let live;
  try { live = await getLiveOffering(item.pool_id); } catch { return blocked(type, 'chain_unavailable'); }
  // Research cases are not mapped to the controlled testnet pools; Live wallet financing starts from a pool's full terms.
  if (!live) return blocked(type, 'live_wallet_flow');
  if (!live.exists || live.emergency_stopped || !['Open', 'Repriced', 'Subscribed'].includes(live.status)) return blocked(type, 'pool_unavailable');
  const price = BigInt(live.price_e6);
  const atomicBudget = usdMicros(amount);
  const shares = price > 0n ? atomicBudget / price : 0n;
  if (!shares) return blocked(type, 'amount_too_small');
  if (shares > BigInt(live.remaining_shares)) return blocked(type, 'capacity_exceeded');
  return actionSchema.parse({ ...base, amount_usd: Number(shares * price) / 1_000_000, price_usd: Number(price) / 1_000_000,
    shares: shares.toString(), chain: { pool_id: live.pool_id, chain_id: live.chain_id, contract: live.contract, price_e6: live.price_e6,
      protocol_version: live.protocol_version, settlement_asset: live.settlement_asset } });
}

export async function validateAction({ action, context, pools, decisions, services, getLiveOffering, now }) {
  if (Date.parse(action.expires_at) <= now) throw new HttpError(409, 'action_expired', 'Request a fresh action card');
  if (context.mode !== action.mode || context.generation !== action.generation) throw new HttpError(409, 'session_mode_changed', 'Runtime changed');
  const budget = context.constraints.ticket_usd;
  if (budget !== undefined && action.amount_usd > budget) throw new HttpError(409, 'budget_exceeded', 'Action exceeds the saved budget');
  const pool = pools.find((entry) => entry.poolId === action.pool_id);
  if (!pool) throw new HttpError(404, 'pool_not_found', 'Pool not found');
  if (action.type === 'ACTION_BUY_REPORT') {
    const service = services.find((entry) => entry.serviceId === action.service_id);
    if (!service || service.priceUSDC !== action.amount_usd || service.endpoint !== action.endpoint) throw new HttpError(409, 'quote_changed', 'Report price changed; request a new card');
    return { caseData: structuredClone(pool.caseData) };
  }
  const current = decisions.filter((decision) => (!decision.mode || decision.mode === context.mode)
    && (decision.generation === undefined || decision.generation === context.generation)
    && (decision.pool_id === action.pool_id || decision.case_id === action.case_id));
  const candidate = poolCandidate(pool, current[0], now);
  candidate.document_verdict = current.find((decision) => ['HOLD_FOR_REVIEW', 'REJECT'].includes(decision.action)
    || ['DOCUMENTS_INGESTED', 'REVIEW_RESOLVED'].includes(decision.event_type) && ['OPEN', 'OPEN_WITH_WARNING'].includes(decision.action));
  if (exclusionReasons(candidate, context.constraints).length || pool.complianceStatus !== 'CLEARED'
    || !['Open', 'Repriced', 'Subscribed'].includes(pool.status)) throw new HttpError(409, 'pool_unavailable', 'Pool no longer meets the saved constraints');
  if (pool.quote.quote_hash !== action.quote_hash || pool.quote.risk_level !== action.risk_level) throw new HttpError(409, 'quote_changed', 'Quote changed; request a new card');
  if (context.mode === 'demo') {
    if (pool.quote.final_issue_price_usd !== action.price_usd) throw new HttpError(409, 'quote_changed', 'Price changed; request a new card');
    if (action.amount_usd > candidate.remaining_usd) throw new HttpError(409, 'capacity_exceeded', 'Pool has insufficient capacity');
  } else {
    const live = await getLiveOffering(action.pool_id);
    if (!live || !live.exists || live.emergency_stopped || !['Open', 'Repriced', 'Subscribed'].includes(live.status)) throw new HttpError(409, 'pool_unavailable', 'Live pool is unavailable');
    if (live.price_e6 !== action.chain.price_e6 || live.contract !== action.chain.contract || live.pool_id !== action.chain.pool_id || live.chain_id !== action.chain.chain_id) throw new HttpError(409, 'quote_changed', 'Live price or mapping changed');
    if (BigInt(live.remaining_shares) < BigInt(action.shares)) throw new HttpError(409, 'capacity_exceeded', 'Live pool has insufficient shares');
  }
  return {};
}
