import { RISK_LEVELS, normalizeRiskLevel } from '../core/schema.js';
import { chatCompletion as realChatCompletion, configuredProviders } from './llm/openaiCompatClient.js';

// Ordinal scale for the median: LOW=1 ... CRITICAL=4 (the engine's RISK_LEVELS order).
const SCORE_BY_LEVEL = Object.fromEntries(RISK_LEVELS.map((level, index) => [level, index + 1]));
const LEVEL_BY_SCORE = Object.fromEntries(RISK_LEVELS.map((level, index) => [index + 1, level]));

/**
 * AI-20: Multi-LLM Consensus Evaluator
 * Evaluates a case using multiple providers independently.
 * Aggregates results using median. Falls back to deterministic engine if all fail or variance is too high.
 *
 * Only providers the operator actually configured (an API key in the environment) are contacted;
 * pass `options.providers` to restrict or extend the list. Nothing is called with a placeholder key.
 */
export async function evaluateWithConsensus(messages, deterministicFallbackFn, options = {}) {
  const {
    providers = configuredProviders(),
    timeoutMs = 15000,
    maxDisagreement = 2, // If max - min >= this, we fallback
    chatFn = realChatCompletion
  } = options;

  if (providers.length === 0) {
    return {
      consensus: deterministicFallbackFn(),
      usedFallback: true,
      reason: 'No LLM provider is configured.',
      details: []
    };
  }

  const promises = providers.map(async (provider) => {
    // Pin this call to one built-in provider. A custom LLM_BASE_URL/LLM_API_KEY pair would
    // otherwise win in resolveProvider() and make every "provider" the same endpoint.
    const env = { ...process.env, LLM_PROVIDER: provider };
    delete env.LLM_BASE_URL;
    delete env.LLM_API_KEY;

    try {
      const response = await chatFn({ messages, timeoutMs, temperature: 0.2 }, env);
      const content = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(content);
      return { provider, result: parsed, success: true };
    } catch (e) {
      return { provider, error: e.message, success: false };
    }
  });

  const results = await Promise.all(promises);

  const successful = results.filter(r => r.success);

  if (successful.length === 0) {
    return {
      consensus: deterministicFallbackFn(),
      usedFallback: true,
      reason: 'All providers failed.',
      details: results
    };
  }

  const validScores = successful
    .map(r => SCORE_BY_LEVEL[normalizeRiskLevel(r.result?.riskLevel)] ?? null)
    .filter(s => s !== null);

  if (validScores.length === 0) {
    return {
      consensus: deterministicFallbackFn(),
      usedFallback: true,
      reason: 'No provider returned a valid riskLevel.',
      details: successful
    };
  }

  const maxScore = Math.max(...validScores);
  const minScore = Math.min(...validScores);

  // If one provider says LOW(1) and another says WARNING(3) or CRITICAL(4), maxDisagreement will be reached (e.g. 3-1 = 2)
  if (maxScore - minScore >= maxDisagreement) {
    return {
      consensus: deterministicFallbackFn(),
      usedFallback: true,
      reason: `Disagreement too large (max ${maxScore} - min ${minScore} >= ${maxDisagreement}).`,
      details: successful,
      warning: true
    };
  }

  validScores.sort((a, b) => a - b);
  const mid = Math.floor(validScores.length / 2);
  const medianScore = validScores.length % 2 !== 0
    ? validScores[mid]
    : Math.round((validScores[mid - 1] + validScores[mid]) / 2.0);

  const consensusRisk = LEVEL_BY_SCORE[medianScore] || 'CRITICAL';
  const allIssues = [...new Set(successful.flatMap(r => r.result.issues || []))];

  return {
    consensus: {
      riskLevel: consensusRisk,
      issues: allIssues,
      score: medianScore
    },
    usedFallback: false,
    reason: `Consensus reached across ${successful.length} provider(s).`,
    details: successful
  };
}
