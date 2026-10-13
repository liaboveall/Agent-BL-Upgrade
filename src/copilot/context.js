import { z } from 'zod';
import { riskLevelRank } from '../core/schema.js';

export const COMMODITIES = ['copper', 'aluminium', 'crude', 'refined', 'soybean', 'rubber', 'iron_ore', 'copper_concentrate'];
const names = z.array(z.string().trim().min(1).max(60)).max(12);
export const constraintsSchema = z.object({
  risk_max: z.enum(['LOW', 'MEDIUM', 'WARNING', 'CRITICAL']).optional(),
  yield_min_bps: z.number().int().min(0).max(100_000).optional(),
  tenor_days_max: z.number().int().min(1).max(3650).optional(),
  commodities_include: z.array(z.enum(COMMODITIES)).max(8).default([]),
  commodities_exclude: z.array(z.enum(COMMODITIES)).max(8).default([]),
  regions_include: names.default([]),
  regions_exclude: names.default([]),
  chokepoints_avoid: names.default([]),
  ticket_usd: z.number().positive().max(1e12).optional(),
  financing_max_usd: z.number().positive().max(1e12).optional(),
  insurance_coverage_min: z.number().min(0).max(10).optional(),
  payout_speed: z.enum(['FAST', 'BALANCED', 'LOW_COST']).optional()
});
const deltaShape = { ...constraintsSchema.shape };
for (const key of ['commodities_include', 'commodities_exclude', 'regions_include', 'regions_exclude', 'chokepoints_avoid']) {
  deltaShape[key] = deltaShape[key].removeDefault();
}
export const deltaSchema = z.object(deltaShape).partial();
export const softSchema = z.object({
  prefer_low_volatility: z.boolean().optional(),
  prefer_short_tenor: z.boolean().optional(),
  diversify: z.boolean().optional()
});

export function newContext({ id, locale = 'zh', now, ttlSec, mode, generation }) {
  const at = new Date(now).toISOString();
  return {
    session_id: id, locale, mode, generation, created_at: at, updated_at: at,
    expires_at: new Date(now + ttlSec * 1000).toISOString(),
    constraints: constraintsSchema.parse({}), soft: {}, history: [], watchlist: []
  };
}

const union = (a, b) => [...new Set([...a, ...b])];
const tighterMin = new Set(['tenor_days_max', 'financing_max_usd']);
const tighterMax = new Set(['yield_min_bps', 'insurance_coverage_min']);

/** Merge only validated, structured preferences. No raw chat or personal data is stored. */
export function mergeContext(context, turn) {
  const next = structuredClone(context);
  const delta = deltaSchema.parse(turn.constraints_delta ?? {});
  const overrides = turn.intent === 'OVERRIDE' ? [...new Set(turn.override_dims ?? [])] : [];
  if (turn.intent === 'RESET') {
    next.constraints = constraintsSchema.parse({});
    next.soft = {};
    next.watchlist = [];
    delete next.last_recommendation;
  } else {
    const c = next.constraints;
    if (overrides.includes('commodities_include')) {
      // Port-specific preferences belonged to the previous commodity; risk and budget survive.
      c.regions_include = [];
    }
    for (const dim of overrides) {
      if (!(dim in constraintsSchema.shape)) continue;
      if (Array.isArray(c[dim])) c[dim] = [];
      else delete c[dim];
    }
    for (const [key, value] of Object.entries(delta)) {
      if (Array.isArray(value)) c[key] = union(c[key] ?? [], value);
      else if (c[key] !== undefined && !overrides.includes(key)) {
        if (key === 'risk_max') c[key] = riskLevelRank(value) < riskLevelRank(c[key]) ? value : c[key];
        else if (tighterMin.has(key)) c[key] = Math.min(c[key], value);
        else if (tighterMax.has(key)) c[key] = Math.max(c[key], value);
        else c[key] = value;
      } else c[key] = value;
    }
    for (const prefix of ['commodities', 'regions']) {
      const include = `${prefix}_include`, exclude = `${prefix}_exclude`;
      const added = delta[include] ?? [], removed = delta[exclude] ?? [];
      c[exclude] = c[exclude].filter((item) => !added.includes(item) || removed.includes(item));
      c[include] = c[include].filter((item) => !c[exclude].includes(item));
    }
    next.constraints = constraintsSchema.parse(c);
    next.soft = { ...next.soft, ...softSchema.parse(turn.soft_delta ?? {}) };
  }
  next.history.push({ turn: (next.history.at(-1)?.turn ?? 0) + 1, intent: turn.intent, delta, overrides });
  next.history = next.history.slice(-32);
  return next;
}
