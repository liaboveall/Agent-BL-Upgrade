import crypto from 'node:crypto';
import { z } from 'zod';
import { readJson, writeJsonAtomic, createWriteQueue } from '../lib/jsonStore.js';
import { HttpError } from '../app/http.js';
import { maxTokensCap } from '../app/llmProxy.js';
import { chatCompletion, isConfigured } from '../agent/llm/openaiCompatClient.js';
import { constraintsSchema, softSchema, newContext, mergeContext } from './context.js';
import { routeIntent } from './intentRouter.js';
import { searchSpec, rankSnapshot, recommendationItems, rankChanges } from './snapshot.js';
import { narrate, templateNarrative } from './narrative.js';
import { actionSchema, proposeAction, validateAction } from './actions.js';
import { X402_SERVICES } from '../x402/config.js';

export const querySchema = z.object({
  message: z.string().trim().min(1).max(2000), locale: z.enum(['zh', 'en']).optional(),
  limit: z.number().int().min(1).max(10).default(5),
  pool_ids: z.array(z.string().min(1).max(128)).max(5).optional(),
  service_id: z.enum(['premium-risk', 'premium-valuation', 'fraud-review']).optional()
});
const storedContext = z.object({
  session_id: z.uuid(), locale: z.enum(['zh', 'en']), mode: z.enum(['demo', 'live']), generation: z.number().int(),
  created_at: z.iso.datetime(), updated_at: z.iso.datetime(), expires_at: z.iso.datetime(),
  constraints: constraintsSchema, soft: softSchema, history: z.array(z.object({
    turn: z.number().int().positive(), intent: z.string().max(30), delta: constraintsSchema.partial(), overrides: z.array(z.string().max(60)).max(13)
  })).max(32), watchlist: z.array(z.string().max(128)).max(30),
  last_recommendation: z.object({ at: z.iso.datetime(), context_hash: z.string(),
    items: z.array(z.object({ pool_id: z.string(), rank: z.number(), score: z.number() }).passthrough()).max(10),
    spec: z.object({ terms: z.array(z.string().max(60)).max(128), limit: z.number().int().min(1).max(10),
      pool_ids: z.array(z.string().max(128)).max(5), constraints: constraintsSchema, explore: z.boolean(),
      tracked_pool_ids: z.array(z.string().max(128)).max(30).default([]) }).optional(),
    intent: z.string().max(30).optional()
  }).optional(),
  update_seq: z.number().int().nonnegative().default(0),
  action: actionSchema.optional(),
  last_update: z.object({ seq: z.number().int().positive(), at: z.iso.datetime(), mode: z.enum(['demo', 'live']), generation: z.number().int(),
    decision_id: z.string().max(128), action: z.string().max(60), phase: z.string().max(60), pool_id: z.string().max(128),
    label: z.string(), route: z.string(), reasoning_summary: z.string().max(600),
    changes: z.array(z.object({ pool_id: z.string(), previous_rank: z.number().nullable(), rank: z.number().nullable(),
      previous_price_usd: z.number().nullable(), price_usd: z.number().nullable() })).max(20),
    result: z.object({ intent: z.string(), recommendations: z.array(z.object({ pool_id: z.string() }).passthrough()).max(10),
      matched: z.number(), excluded_notable: z.array(z.object({ pool_id: z.string() }).passthrough()).max(3) })
  }).optional()
});
const knob = (value, fallback, max) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Math.min(max, Number(value)) : fallback;

export class CopilotService {
  constructor({ getPools, getDecisions = async () => [], runtimeMode = () => ({ demoMode: true, generation: 0 }), file = null,
    env = process.env, now = () => Date.now(), chatFn = chatCompletion, llmConfigured = () => isConfigured(env),
    getLiveOffering = async () => null, subscribeDemo, services = X402_SERVICES } = {}) {
    this.getPools = getPools;
    this.getDecisions = getDecisions;
    this.runtimeMode = runtimeMode;
    this.file = file;
    this.now = now;
    this.chatFn = chatFn;
    this.env = env;
    this.getLiveOffering = getLiveOffering;
    this.subscribeDemo = subscribeDemo;
    this.services = services.filter((entry) => ['premium-risk', 'premium-valuation', 'fraud-review'].includes(entry.serviceId));
    this.llmConfigured = () => String(env.LLM_PROXY_ENABLED ?? 'true').toLowerCase() !== 'false' && llmConfigured();
    this.modelInflight = 0;
    this.maxConcurrent = knob(env.LLM_PROXY_MAX_CONCURRENCY, 4, 64);
    this.ttlSec = knob(env.COPILOT_SESSION_TTL_SEC, 86400, 604800);
    this.maxSessions = knob(env.COPILOT_MAX_SESSIONS, 500, 5000);
    this.sessions = new Map();
    this.turnQueues = new Map();
    this.subscribers = new Map();
    this.maxSubscribers = knob(env.AGENTBL_MAX_SSE_CLIENTS, 200, 5000);
    this.pendingUpdates = Promise.resolve();
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
    for (const [id, context] of this.sessions) if (Date.parse(context.expires_at) <= this.now()) {
      this.sessions.delete(id); this.closeSessionStreams(id);
    }
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
    this.closeSessionStreams(id);
    await this.persist();
  }

  async invalidateSessions() {
    await this.init();
    this.sessions.clear();
    this.closeStreams();
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
    return this.enqueue(sessionId, async () => this.#turn(query, await this.get(sessionId), { sessionId, onStructured }));
  }

  async enqueue(id, task) {
    const prior = this.turnQueues.get(id) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(task);
    this.turnQueues.set(id, run);
    try { return await run; }
    finally { if (this.turnQueues.get(id) === run) this.turnQueues.delete(id); }
  }

  async watch(id, poolIds) {
    if (!Array.isArray(poolIds) || poolIds.length > 30 || poolIds.some((pool) => typeof pool !== 'string' || !pool || pool.length > 128)) {
      throw new HttpError(400, 'invalid_watchlist', 'Provide up to 30 pool IDs');
    }
    return this.enqueue(id, async () => {
      const context = await this.get(id);
      const pools = await this.getPools();
      if (poolIds.some((id) => !pools.some((pool) => pool.poolId === id))) throw new HttpError(404, 'pool_not_found', 'Unknown watched pool');
      await this.get(id);
      context.watchlist = [...new Set(poolIds)];
      if (!context.last_recommendation?.spec) context.last_recommendation = {
        at: new Date(this.now()).toISOString(), context_hash: crypto.createHash('sha256').update(JSON.stringify(context.constraints)).digest('hex'),
        items: [], intent: 'EXPLORATORY_BROWSE', spec: { terms: [], limit: 5, pool_ids: [], constraints: context.constraints, explore: true, tracked_pool_ids: [] }
      };
      this.sessions.set(id, context); await this.persist(); return structuredClone(context);
    });
  }

  subscribe(id, callback) {
    const count = [...this.subscribers.values()].reduce((sum, set) => sum + set.size, 0);
    if (count >= this.maxSubscribers) throw new HttpError(503, 'sse_capacity', 'Too many Copilot streams');
    const set = this.subscribers.get(id) ?? new Set(); set.add(callback); this.subscribers.set(id, set);
    return () => { set.delete(callback); if (!set.size) this.subscribers.delete(id); };
  }

  publish(id, event, data) {
    for (const callback of this.subscribers.get(id) ?? []) {
      try { callback(event, structuredClone(data)); } catch { /* One disconnected client cannot stop other sessions. */ }
    }
  }

  closeSessionStreams(id) { this.publish(id, 'SESSION_CLOSED', { code: 'session_not_found' }); this.subscribers.delete(id); }
  closeStreams() { for (const id of [...this.subscribers.keys()]) this.closeSessionStreams(id); }

  notifyDecision(activity) {
    if (!activity.decision_id || !['DECISION_MADE', 'DECISION_REJECTED', 'DECISION_RECORDED', 'EXECUTION_CONFIRMED'].includes(activity.action)) return this.pendingUpdates;
    const run = this.pendingUpdates.catch(() => {}).then(() => this.rerank(activity));
    this.pendingUpdates = run;
    return run;
  }

  async rerank(activity) {
    await this.init(); this.prune();
    const decisions = await this.getDecisions();
    const decision = decisions.find((entry) => entry.decision_id === activity.decision_id);
    const mode = this.mode();
    if (!decision || decision.mode && decision.mode !== mode.mode || decision.generation !== undefined && decision.generation !== mode.generation) return;
    const poolId = decision.pool_id ?? activity.poolId ?? decision.case_id;
    const targets = [...this.sessions.values()].filter((context) => context.mode === mode.mode && context.generation === mode.generation
      && context.last_recommendation?.spec && (context.watchlist.includes(poolId) || context.last_recommendation.spec.tracked_pool_ids.includes(poolId)));
    for (const target of targets) await this.enqueue(target.session_id, async () => {
      let context;
      try { context = await this.get(target.session_id); } catch (error) { if ([404, 409].includes(error.status)) return; throw error; }
      const previous = context.last_recommendation;
      if (!previous?.spec || !(context.watchlist.includes(poolId) || previous.spec.tracked_pool_ids.includes(poolId))) return;
      if (context.last_update?.decision_id === decision.decision_id && context.last_update.phase === activity.action) return;
      const pools = await this.getPools();
      const currentDecisions = await this.getDecisions();
      const observed = currentDecisions.find((entry) => entry.decision_id === decision.decision_id) ?? decision;
      const phase = observed.status === 'COMPLETED' ? 'EXECUTION_CONFIRMED' : activity.action;
      if (context.last_update?.decision_id === decision.decision_id && context.last_update.phase === phase) return;
      const snapshot = rankSnapshot(pools, currentDecisions, context, previous.spec, this.now());
      await this.get(target.session_id);
      const items = recommendationItems(snapshot.recommendations);
      const pool = pools.find((entry) => entry.poolId === poolId);
      const seq = (context.update_seq ?? 0) + 1;
      const update = { seq, at: new Date(this.now()).toISOString(), ...mode, decision_id: decision.decision_id,
        action: decision.action, phase, pool_id: poolId,
        label: pool?.caseData?.bill_of_lading?.cargo ?? poolId,
        route: [pool?.caseData?.bill_of_lading?.port_of_loading, pool?.caseData?.bill_of_lading?.port_of_discharge].filter(Boolean).join(' → '),
        reasoning_summary: String(decision.reasoning_summary ?? '').slice(0, 600),
        changes: rankChanges(previous.items, items, context.last_update?.decision_id === decision.decision_id ? context.last_update.changes : []),
        result: { intent: previous.intent, ...snapshot } };
      context.last_recommendation = { ...previous, items, at: update.at,
        spec: { ...previous.spec, tracked_pool_ids: [...new Set([...previous.spec.tracked_pool_ids, ...items.map((item) => item.pool_id)])].slice(-30) } };
      context.update_seq = seq; context.last_update = update;
      this.sessions.set(context.session_id, context); await this.persist();
      this.publish(context.session_id, 'COPILOT_RERANK', { ...update, result: { ...update.result, context: this.publicContext(context), ...mode } });
    }).catch((error) => { if (![404, 409].includes(error.status)) throw error; });
  }

  publicContext(context) { const result = structuredClone(context); delete result.last_update; return result; }

  async confirmAction(id, actionId, { confirm, wallet_address } = {}) {
    if (confirm !== true) throw new HttpError(400, 'confirmation_required', 'Explicit confirmation is required');
    if (wallet_address !== undefined && (typeof wallet_address !== 'string' || !/^0x[a-zA-Z0-9]{1,64}$/u.test(wallet_address))) throw new HttpError(400, 'invalid_wallet', 'Invalid wallet address');
    return this.enqueue(id, async () => {
      const context = await this.get(id), action = context.action;
      if (!action || action.id !== actionId) throw new HttpError(409, 'action_superseded', 'Request a new action card');
      if (action.status === 'COMPLETED') return { ...action.result, action };
      if (action.status !== 'PENDING') throw new HttpError(409, 'action_not_pending', 'Action has already started or was cancelled');
      const prepared = await validateAction({ action, context, pools: await this.getPools(), decisions: await this.getDecisions(),
        services: this.services, getLiveOffering: this.getLiveOffering, now: this.now() });
      await this.get(id);
      // No asynchronous gap between the final mode check and the in-memory Demo mutation.
      if (action.type === 'ACTION_SUBSCRIBE' && action.mode === 'demo') {
        if (!this.subscribeDemo) throw new HttpError(503, 'action_unavailable', 'Demo subscription is unavailable');
        const result = this.subscribeDemo(wallet_address ?? '0xDemoWallet', action.pool_id, action.amount_usd,
          { kind: 'COPILOT', action_id: action.id });
        action.status = 'COMPLETED';
        action.result = { mode: 'demo', reference: result.reference, txHash: null, amountUsd: result.investment.amountUsd,
          tokenCount: result.investment.tokenCount, price: result.investment.price, poolStatus: result.poolStatus };
        this.sessions.set(id, context); await this.persist();
        return { ...action.result, action };
      }
      action.status = 'CONFIRMING';
      this.sessions.set(id, context); await this.persist();
      return { action, ...prepared };
    });
  }

  async cancelAction(id, actionId) {
    return this.enqueue(id, async () => {
      const context = await this.get(id);
      if (!context.action || context.action.id !== actionId) throw new HttpError(409, 'action_superseded', 'Action is no longer current');
      if (context.action.status !== 'PENDING') throw new HttpError(409, 'action_not_pending', 'Started actions require reconciliation');
      context.action.status = 'CANCELLED'; this.sessions.set(id, context); await this.persist();
      return { cancelled: true };
    });
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
    delete context.action;
    delete context.last_update;
    context.updated_at = new Date(this.now()).toISOString();
    context.expires_at = new Date(this.now() + this.ttlSec * 1000).toISOString();
    const pools = await this.getPools();
    const decisions = await this.getDecisions();
    const spec = searchSpec(query, context, turn, pools);
    const snapshot = rankSnapshot(pools, decisions, context, spec, this.now());
    const emptyIntent = ['RESET', 'OUT_OF_SCOPE', 'PORTFOLIO', 'CLARIFY'].includes(turn.intent);
    const recommendations = emptyIntent ? [] : snapshot.recommendations;
    const result = {
      intent: turn.intent, intent_mode: turn.mode, context, context_delta: turn.constraints_delta,
      recommendations, matched: snapshot.matched, excluded_notable: snapshot.excluded_notable,
      mode: context.mode, generation: context.generation, narrative_mode: 'template', narrative: ''
    };
    if (turn.intent === 'CLARIFY' || turn.ambiguities.length && (!recommendations.length || snapshot.matched > 10)) {
      result.clarifying_question = turn.ambiguities.includes('range_requires_clarification')
        ? context.locale === 'zh' ? '请把区间明确为最低收益、最长期限或单一投资额，我会保留原有条件。' : 'Please express the range as a minimum yield, maximum tenor or a single ticket amount; I will keep the previous preferences.'
        : context.locale === 'zh' ? '请明确风险上限、最低收益（百分比）或投资额（USD），我会保留其余条件。' : 'Please specify a risk ceiling, minimum yield (%) or budget (USD); I will keep your other preferences.';
    } else if (!emptyIntent && !recommendations.length) {
      result.clarifying_question = context.locale === 'zh' ? '没有标的符合全部条件。你想放宽哪项条件？可用“改成”替换该条件。' : 'No assets meet all constraints. Which limit should change? Use “instead” to replace it.';
    }
    if (turn.intent.startsWith('ACTION_')) {
      result.action_required = { type: turn.intent, confirmation_required: true, executed: false,
        pool_id: recommendations[0]?.pool_id ?? null };
      result.action_proposal = await proposeAction({ query, turn, context, recommendations,
        getLiveOffering: this.getLiveOffering, services: this.services, now: this.now() });
      if (result.action_proposal.id && sessionId) context.action = result.action_proposal;
      else if (result.action_proposal.id) result.action_proposal = { type: turn.intent, blocked: 'session_required', confirmation_required: true, executed: false };
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
      items: recommendationItems(recommendations), ...!emptyIntent ? { spec: { ...spec, tracked_pool_ids: recommendations.map((item) => item.pool_id) }, intent: turn.intent } : {} };
    delete context.last_update;
    if (sessionId) { this.sessions.set(sessionId, context); await this.persist(); }
    return result;
  }
}
