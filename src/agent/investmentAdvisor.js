import { z } from 'zod';
import { normalizeRiskLevel, riskLevelRank } from '../core/schema.js';
import { chatCompletion, isConfigured } from './llm/openaiCompatClient.js';

const SORT_KEYS = ['yield_desc', 'risk_asc', 'score_desc'];

// Whatever the LLM returns is untrusted: only these keys, with these types and ranges, can reach
// the filter. Unknown keys are dropped; any violation discards the whole answer (deterministic
// fallback). HIGH is accepted from the model and mapped to the engine's WARNING.
const riskMaxSchema = z.string().transform((value, ctx) => {
  const level = normalizeRiskLevel(value);
  if (!level) ctx.addIssue({ code: 'custom', message: 'unknown risk level' });
  return level;
});
const criteriaSchema = z.object({
  risk_max: riskMaxSchema.nullish(),
  yield_min: z.number().int().min(0).max(100_000).nullish(),
  commodity: z.string().trim().min(1).max(40).nullish(),
  financing_max: z.number().positive().max(1e12).nullish(),
  sort_by: z.enum(SORT_KEYS).nullish()
});

/**
 * Shape a market pool (src/app/store.js) the way recommend() expects. Shared with the HTTP route
 * so tests exercise the same mapping the server uses.
 */
export function poolToAdvisorCase(pool) {
  return {
    id: pool.poolId,
    caseEntry: {
      cargo: pool.caseData?.bill_of_lading?.cargo || 'Unknown',
      label: pool.caseData?.case_id || 'Unknown'
    },
    caseData: pool.caseData,
    riskLevel: pool.quote.risk_level,
    yieldBps: pool.quote.implied_gross_yield_bps,
    riskBps: pool.quote.risk_score_bps,
    score: pool.quote.implied_gross_yield_bps / Math.max(1, pool.quote.risk_score_bps),
    financingUsd: pool.quote.requested_cash_usd,
    price: pool.quote.final_issue_price_usd
  };
}

/** Validate an LLM-produced criteria object; returns a clean criteria object or null. */
export function parseLlmCriteria(raw) {
  const parsed = criteriaSchema.safeParse(raw);
  if (!parsed.success) return null;
  return Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== null && value !== undefined));
}

/**
 * AI-19: Investment Advisor
 * Recommends eBL cases based on natural language preferences.
 * 
 * @param {string} preference - Natural language preference (e.g., "High yield, medium risk")
 * @param {Array} availableCases - Array of pre-scored case objects, each containing:
 *   { caseEntry, score, riskLevel, yieldBps, financingUsd, price, riskBps }
 * @returns {Promise<Object>} - { recommendations: Array, reason: string }
 */
export async function recommend(preference, availableCases, options = {}) {
  const {
    chatFn = chatCompletion,
    llmConfigured = isConfigured(),
    criteria: explicitCriteria = null, // already-validated structured criteria (see parseLlmCriteria)
    limit = 3
  } = options;
  if (!preference && !explicitCriteria) {
    return { recommendations: [], reason: 'No preference provided.' };
  }
  if (!availableCases || !availableCases.length) {
    return { recommendations: [], reason: 'No available cases to recommend.' };
  }

  let criteria = {
    risk_max: null,
    yield_min: null,
    commodity: null,
    financing_max: null,
    sort_by: 'score_desc' // default
  };

  // 1. Structured criteria win; otherwise try the LLM, then the deterministic parser.
  if (explicitCriteria) {
    criteria = { ...criteria, ...explicitCriteria };
  } else if (llmConfigured) {
    try {
      const messages = [
        { role: 'system', content: `You are an AI investment advisor for an eBL RWA platform. 
Extract the user's investment preferences into a JSON object.
Valid keys:
- risk_max: "LOW", "MEDIUM", "WARNING", or "CRITICAL"
- yield_min: integer (in basis points, e.g. 500 for 5%)
- commodity: string (e.g. "copper", "soybeans")
- financing_max: number (in USD)
- sort_by: "yield_desc", "risk_asc", or "score_desc"

Only return valid JSON.` },
        { role: 'user', content: preference }
      ];

      const response = await chatFn({ messages, temperature: 0.1 });
      const content = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
      const validated = parseLlmCriteria(JSON.parse(content));
      criteria = validated ? { ...criteria, ...validated } : deterministicFallback(preference);
    } catch (e) {
      // Fallback to deterministic
      criteria = deterministicFallback(preference);
    }
  } else {
    // LLM not configured, use deterministic fallback
    criteria = deterministicFallback(preference);
  }

  // 2. Filter cases based on criteria
  let results = [...availableCases];

  const riskMaxRank = riskLevelRank(criteria.risk_max);
  if (riskMaxRank >= 0) {
    // A case with an unrecognised level is excluded rather than waved through.
    results = results.filter(r => {
      const rank = riskLevelRank(r.riskLevel);
      return rank >= 0 && rank <= riskMaxRank;
    });
  }
  if (criteria.yield_min) {
    results = results.filter(r => r.yieldBps >= criteria.yield_min);
  }
  if (criteria.commodity) {
    const kw = criteria.commodity.toLowerCase();
    results = results.filter(r => 
      (r.caseEntry.cargo || '').toLowerCase().includes(kw) ||
      (r.caseData?.bill_of_lading?.cargo || '').toLowerCase().includes(kw)
    );
  }
  if (criteria.financing_max) {
    results = results.filter(r => r.financingUsd <= criteria.financing_max);
  }

  // 3. Sort cases
  if (criteria.sort_by === 'yield_desc') {
    results.sort((a, b) => b.yieldBps - a.yieldBps);
  } else if (criteria.sort_by === 'risk_asc') {
    results.sort((a, b) => a.riskBps - b.riskBps);
  } else {
    // Default score_desc
    results.sort((a, b) => b.score - a.score);
  }

  const top = results.slice(0, Math.max(1, Math.min(10, Number(limit) || 3)));
  
  const reasonText = criteria.risk_max 
    ? `Filtered by Risk <= ${criteria.risk_max}` + (criteria.yield_min ? `, Yield >= ${(criteria.yield_min/100).toFixed(1)}%` : '')
    : `Ranked by ${criteria.sort_by === 'yield_desc' ? 'Yield' : 'Risk/Reward Score'}`;

  return {
    recommendations: top,
    matched: results.length,
    reason: `AI Recommendation based on "${preference ?? 'structured criteria'}" (${reasonText})`,
    criteria
  };
}

function deterministicFallback(pref) {
  const p = pref.toLowerCase();
  const criteria = { sort_by: 'score_desc' };

  if (p.includes('low risk') || p.includes('safe') || p.includes('稳健') || p.includes('低风险')) {
    criteria.risk_max = 'LOW';
    criteria.sort_by = 'risk_asc';
  } else if (p.includes('medium risk') || p.includes('中风险')) {
    criteria.risk_max = 'MEDIUM';
  } else if (p.includes('high yield') || p.includes('高收益')) {
    criteria.sort_by = 'yield_desc';
  }

  if (p.includes('copper') || p.includes('铜')) criteria.commodity = 'copper';
  if (p.includes('soybean') || p.includes('大豆')) criteria.commodity = 'soybean';

  return criteria;
}
