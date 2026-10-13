import crypto from 'node:crypto';
import { z } from 'zod';
import { readJson, writeJsonAtomic, createWriteQueue } from '../lib/jsonStore.js';
import { HttpError } from '../app/http.js';
import { maxTokensCap } from '../app/llmProxy.js';
import { chatCompletion, isConfigured } from '../agent/llm/openaiCompatClient.js';
import { constraintsSchema, softSchema, newContext, mergeContext } from './context.js';
import { routeIntent } from './intentRouter.js';
import { poolCandidate, retrieve } from './retrieval.js';
import { rankCandidates, diversify, recommendation } from './ranking.js';
import { narrate, templateNarrative } from './narrative.js';

export const querySchema = z.object({
  message: z.string().trim().min(1).max(2000), locale: z.enum(['zh', 'en']).optional(),
  limit: z.number().int().min(1).max(10).default(5),
  pool_ids: z.array(z.string().min(1).max(128)).max(5).optional()
});
const storedContext = z.object({
  session_id: z.uuid(), locale: z.enum(['zh', 'en']), mode: z.enum(['demo', 'live']), generation: z.number().int(),
  created_at: z.iso.datetime(), updated_at: z.iso.datetime(), expires_at: z.iso.datetime(),
  constraints: constraintsSchema, soft: softSchema, history: z.array(z.object({
    turn: z.number().int().positive(), intent: z.string().max(30), delta: constraintsSchema.partial(), overrides: z.array(z.string().max(60)).max(13)
  })).max(32), watchlist: z.array(z.string().max(128)).max(30),
  last_recommendation: z.object({ at: z.iso.datetime(), context_hash: z.string(), items: z.array(z.object({ pool_id: z.string(), rank: z.number(), score: z.number() })).max(10) }).optional()
});
const knob = (value, fallback, max) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Math.min(max, Number(value)) : fallback;

export class CopilotService {
  constructor({ getPools, getDecisions = async () => [], runtimeMode = () => ({ demoMode: true, generation: 0 }), file = null,
    env = process.env, now = () => Date.now(), chatFn = chatCompletion, llmConfigured = () => isConfigured(env) } = {}) {
    this.getPools = getPools;
    this.getDecisions = getDecisions;
    this.runtimeMode = runtimeMode;
    this.file = file;
    this.now = now;
    this.chatFn = chatFn;
    this.env = env;
    this.llmConfigured = () => String(env.LLM_PROXY_ENABLED ?? 'true').toLowerCase() !== 'false' && llmConfigured();
    this.modelInflight = 0;
    this.maxConcurrent = knob(env.LLM_PROXY_MAX_CONCURRENCY, 4, 64);
    this.ttlSec = knob(env.COPILOT_SESSION_TTL_SEC, 86400, 604800);
    this.maxSessions = knob(env.COPILOT_MAX_SESSIONS, 500, 5000);
    this.sessions = new Map();
    this.turnQueues = new Map();
    this.write = createWriteQueue();
  }

  mode() {
    const snapshot = this.runtimeMode();
    return { mode: snapshot.demoMode ? 'demo' : 'live', generation: snapshot.generation ?? 0 };
  }

  async init() {
    if (!this.initializing) this.initializing = (async () => {
      const saved = this.file ? await readJson(this.file, []) : [];
      if (!Array.isArray(saved)) throw new Error('Invalid Copilot session store');
      for (const entry of saved.slice(-this.maxSessions)) {
        const parsed = storedContext.safeParse(entry);
        if (parsed.success && Date.parse(parsed.data.expires_at) > this.now()) this.sessions.set(parsed.data.session_id, parsed.data);
      }
    })();
    return this.initializing;
  }

  persist() {
    return this.file ? this.write(() => writeJsonAtomic(this.file, [...this.sessions.values()])) : Promise.resolve();
  }

  prune() {
    for (const [id, context] of this.sessions) if (Date.parse(context.expires_at) <= this.now()) this.sessions.delete(id);
  }

  async create({ locale = 'zh' } = {}) {
    if (!['zh', 'en'].includes(locale)) throw new HttpError(400, 'invalid_locale', 'locale must be zh or en');
    await this.init();
    this.prune();
    if (this.sessions.size >= this.maxSessions) throw new HttpError(429, 'session_limit', 'Too many active Copilot sessions; delete an old session or retry after expiry');
    const context = newContext({ id: crypto.randomUUID(), locale, now: this.now(), ttlSec: this.ttlSec, ...this.mode() });
    this.sessions.set(context.session_id, context);
    await this.persist();
    return structuredClone(context);
  }

  async get(id) {
    await this.init();
    this.prune();
    const context = this.sessions.get(id);
    if (!context) throw new HttpError(404, 'session_not_found', 'Copilot session is missing or expired');
    const current = this.mode();
    if (current.mode !== context.mode || current.generation !== context.generation) {
      throw new HttpError(409, 'session_mode_changed', 'Runtime mode changed; start a new Copilot session');
    }
    return structuredClone(context);
  }

  async delete(id) {
    await this.get(id);
    // In-flight turns check this again before committing, so deletion cannot resurrect a session.
    this.sessions.delete(id);
    await this.persist();
  }

  async invalidateSessions() {
    await this.init();
    this.sessions.clear();
    await this.persist();
  }

  validate(input) {
    const parsed = querySchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'invalid_copilot_query', 'Provide a non-empty message (up to 2000 characters), locale zh/en and limit 1-10');
    return parsed.data;
  }

  async query(input, { sessionId, onStructured } = {}) {
    const query = this.validate(input);
    if (!sessionId) return this.#turn(query, newContext({ id: crypto.randomUUID(), locale: query.locale ?? 'zh', now: this.now(), ttlSec: this.ttlSec, ...this.mode() }), { onStructured });
    const prior = this.turnQueues.get(sessionId) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(async () => this.#turn(query, await this.get(sessionId), { sessionId, onStructured }));
    this.turnQueues.set(sessionId, run);
    try { return await run; }
    finally { if (this.turnQueues.get(sessionId) === run) this.turnQueues.delete(sessionId); }
  }

  async callModel(request) {
    if (this.modelInflight >= this.maxConcurrent) throw new Error('Copilot model capacity reached');
    this.modelInflight += 1;
    try { return await this.chatFn({ ...request, maxTokens: maxTokensCap(this.env) }, this.env); }
    finally { this.modelInflight -= 1; }
  }

  async #turn(query, previous, { sessionId, onStructured }) {
    const llmConfigured = this.llmConfigured();
    const options = { chatFn: (request) => this.callModel(request), llmConfigured };
    const turn = await routeIntent(query.message, previous, options);
    // Comparison, explanations, actions and out-of-scope messages do not silently rewrite filters.
    const changesFilters = ['TARGETED_SEARCH', 'EXPLORATORY_BROWSE', 'REFINE', 'OVERRIDE', 'RESET'].includes(turn.intent);
    let context;
    try { context = mergeContext(previous, changesFilters ? turn : { ...turn, constraints_delta: {}, soft_delta: {} }); }
    catch (error) {
      if (error instanceof z.ZodError) throw new HttpError(400, 'too_many_preferences', 'Too many distinct filters; replace a dimension or reset preferences');
      throw error;
    }
    context.locale = query.locale ?? context.locale;
    context.updated_at = new Date(this.now()).toISOString();
    context.expires_at = new Date(this.now() + this.ttlSec * 1000).toISOString();
    const pools = await this.getPools();
    const decisions = await this.getDecisions();
    const latest = new Map(), documentVerdicts = new Map();
    for (const decision of decisions) {
      const key = decision.pool_id ?? decision.case_id;
      if (!latest.has(key)) latest.set(key, decision);
      const isDocumentVerdict = ['HOLD_FOR_REVIEW', 'REJECT'].includes(decision.action)
        || ['DOCUMENTS_INGESTED', 'REVIEW_RESOLVED'].includes(decision.event_type) && ['OPEN', 'OPEN_WITH_WARNING'].includes(decision.action);
      if (isDocumentVerdict && !documentVerdicts.has(key)) documentVerdicts.set(key, decision);
    }
    let candidates = pools.filter((pool) => pool.quote).map((pool) => ({
      ...poolCandidate(pool, latest.get(pool.poolId) ?? latest.get(pool.caseData?.case_id), this.now()),
      document_verdict: documentVerdicts.get(pool.poolId) ?? documentVerdicts.get(pool.caseData?.case_id)
    }));
    if (query.pool_ids?.length) candidates = candidates.filter((candidate) => query.pool_ids.includes(candidate.pool_id));
    let retrievalContext = context;
    if (turn.intent === 'COMPARE' && turn.constraints_delta.commodities_include?.length) {
      retrievalContext = { ...context, constraints: { ...context.constraints, commodities_include: turn.constraints_delta.commodities_include } };
    }
    const { included, excluded } = retrieve(candidates, retrievalContext, query.message);
    const ranked = rankCandidates(included, context);
    const explore = turn.intent === 'EXPLORATORY_BROWSE' || context.soft.diversify;
    const selected = explore ? diversify(ranked, query.limit) : ranked.slice(0, query.limit);
    const emptyIntent = ['RESET', 'OUT_OF_SCOPE', 'PORTFOLIO', 'CLARIFY'].includes(turn.intent);
    const recommendations = emptyIntent ? [] : selected.map((item, index) => recommendation(item, index + 1, context.locale));
    const noteworthy = rankCandidates(excluded, context).slice(0, 3).map((item) => ({ pool_id: item.pool_id, label: item.label, reasons: item.exclusion_reasons, score: item.score }));
    const result = {
      intent: turn.intent, intent_mode: turn.mode, context, context_delta: turn.constraints_delta,
      recommendations, matched: included.length, excluded_notable: noteworthy,
      mode: context.mode, generation: context.generation, narrative_mode: 'template', narrative: ''
    };
    if (turn.intent === 'CLARIFY' || turn.ambiguities.length && (!recommendations.length || included.length > 10)) {
      result.clarifying_question = turn.ambiguities.includes('range_requires_clarification')
        ? context.locale === 'zh' ? '请把区间明确为最低收益、最长期限或单一投资额，我会保留原有条件。' : 'Please express the range as a minimum yield, maximum tenor or a single ticket amount; I will keep the previous preferences.'
        : context.locale === 'zh' ? '请明确风险上限、最低收益（百分比）或投资额（USD），我会保留其余条件。' : 'Please specify a risk ceiling, minimum yield (%) or budget (USD); I will keep your other preferences.';
    } else if (!emptyIntent && !recommendations.length) {
      result.clarifying_question = context.locale === 'zh' ? '没有标的符合全部条件。你想放宽哪项条件？可用“改成”替换该条件。' : 'No assets meet all constraints. Which limit should change? Use “instead” to replace it.';
    }
    if (turn.intent.startsWith('ACTION_')) {
      result.action_required = { type: turn.intent, confirmation_required: true, executed: false,
        pool_id: recommendations[0]?.pool_id ?? null };
    }
    result.narrative = templateNarrative(result, context.locale);
    const assertCurrent = async () => {
      const current = this.mode();
      if (current.mode !== context.mode || current.generation !== context.generation) throw new HttpError(409, 'session_mode_changed', 'Runtime mode changed during the query; retry in a new session');
      if (sessionId) await this.get(sessionId);
    };
    await assertCurrent();
    await onStructured?.(structuredClone(result));
    Object.assign(result, await narrate(result, context.locale, options));
    await assertCurrent();
    context.last_recommendation = { at: context.updated_at,
      context_hash: crypto.createHash('sha256').update(JSON.stringify(context.constraints)).digest('hex'),
      items: recommendations.map(({ pool_id, rank, score }) => ({ pool_id, rank, score })) };
    if (sessionId) { this.sessions.set(sessionId, context); await this.persist(); }
    return result;
  }
}
