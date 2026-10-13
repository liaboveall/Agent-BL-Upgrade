import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CopilotService } from '../src/copilot/service.js';
import { pool } from './helpers/copilot.js';

const service = (options = {}) => new CopilotService({
  getPools: async () => [pool('C', { risk: 'LOW' }), pool('A', { commodity: 'Aluminium', risk: 'LOW' }), pool('S', { commodity: 'Soybean' })],
  now: () => 0, env: {}, llmConfigured: () => false, ...options
});

test('Copilot service: multiple turns preserve constraints and return current evidence and exclusions', async () => {
  const runtime = service(); const context = await runtime.create();
  const send = (message) => runtime.query({ message }, { sessionId: context.session_id });
  const first = await send('低风险铜，预算1000美元');
  assert.deepEqual(first.recommendations.map((item) => item.pool_id), ['C']);
  assert.equal(first.context.constraints.ticket_usd, 1000);
  const switched = await send('算了，换成铝');
  assert.deepEqual(switched.recommendations.map((item) => item.pool_id), ['A']);
  assert.equal(switched.context.constraints.risk_max, 'LOW');
  assert.equal(switched.context.history.length, 2);
  assert.equal(switched.recommendations[0].quote_hash, 'quote-A');
  const empty = await send('收益至少99%');
  assert.equal(empty.recommendations.length, 0);
  assert.ok(empty.clarifying_question);
  assert.ok(empty.excluded_notable.some((item) => item.reasons.includes('yield_min_bps')));
  const reset = await send('重新开始');
  assert.equal(reset.context.constraints.ticket_usd, undefined);
  assert.equal(reset.recommendations.length, 0);
});

test('Copilot service: a decision hold and a changed quote affect the next query, without stale catalogue hints', async () => {
  const pools = [pool('C'), pool('A', { commodity: 'Aluminium' })]; let decisions = [];
  const runtime = service({ getPools: async () => pools, getDecisions: async () => decisions });
  const first = await runtime.query({ message: 'copper' });
  assert.equal(first.recommendations[0].price_usd, 0.8);
  pools[0].quote.final_issue_price_usd = 0.7; pools[0].quote.quote_hash = 'new-quote';
  decisions = [{ pool_id: 'C', case_id: 'C', action: 'REPRICE', decision_id: 'D1' }];
  const next = await runtime.query({ message: 'copper' });
  assert.equal(next.recommendations[0].price_usd, 0.7);
  assert.equal(next.recommendations[0].decision_id, 'D1');
  decisions = [{ pool_id: 'C', action: 'HOLD_FOR_REVIEW', decision_id: 'D2' }, ...decisions];
  assert.equal((await runtime.query({ message: 'copper' })).recommendations.length, 0);
  decisions.unshift({ pool_id: 'C', action: 'WARNING', decision_id: 'D3', event_type: 'WORLD_RISK_UPDATED' });
  assert.equal((await runtime.query({ message: 'copper' })).recommendations.length, 0, 'a monitor warning cannot clear an unresolved document hold');
  decisions.unshift({ pool_id: 'C', action: 'OPEN', decision_id: 'D4', event_type: 'REVIEW_RESOLVED' });
  assert.equal((await runtime.query({ message: 'copper' })).recommendations.length, 1, 'a new validated document verdict can resolve the hold');
});

test('Copilot service: compare/explain/action turns do not silently modify persisted filters or execute', async () => {
  const runtime = service(); const context = await runtime.create(); const sessionId = context.session_id;
  await runtime.query({ message: 'low risk copper' }, { sessionId });
  const compared = await runtime.query({ message: 'compare copper and aluminium' }, { sessionId });
  assert.equal(compared.recommendations.length, 2);
  assert.deepEqual(compared.context.constraints.commodities_include, ['copper']);
  const explain = await runtime.query({ message: 'explain', pool_ids: ['C'] }, { sessionId });
  assert.deepEqual(explain.recommendations.map((item) => item.pool_id), ['C']);
  for (const message of ['subscribe USD 1000', 'buy report']) {
    const result = await runtime.query({ message }, { sessionId });
    assert.equal(result.action_required.executed, false);
    assert.equal(result.action_required.confirmation_required, true);
    assert.equal(result.context.constraints.ticket_usd, undefined);
  }
  const portfolio = await runtime.query({ message: 'portfolio' }, { sessionId });
  assert.equal(portfolio.recommendations.length, 0);
  assert.ok((await runtime.query({ message: '收益大概百分之八' })).clarifying_question === undefined, 'ambiguity only asks when too broad or empty');
});

test('Copilot service: sessions persist only bounded structured context, expire and respect capacity', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-copilot-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sessions.json'); let now = 0;
  const runtime = service({ file, now: () => now, env: { COPILOT_MAX_SESSIONS: '1', COPILOT_SESSION_TTL_SEC: '60' } });
  const context = await runtime.create({ locale: 'en' });
  await runtime.query({ message: 'low risk copper, my secret phrase' }, { sessionId: context.session_id });
  await assert.rejects(runtime.create(), { code: 'session_limit' });
  const serialized = await fs.readFile(file, 'utf8');
  assert.ok(!serialized.includes('secret phrase'));
  const recovered = service({ file, now: () => now });
  assert.equal((await recovered.get(context.session_id)).constraints.risk_max, 'LOW');
  await recovered.delete(context.session_id);
  await assert.rejects(recovered.get(context.session_id), { status: 404 });
  now = 60_001;
  await assert.rejects(runtime.get(context.session_id), { status: 404 });
  assert.ok((await runtime.create()).session_id);
});

test('Copilot service: runtime invalidation persists, so restarting generation numbering cannot revive an old session', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-copilot-mode-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sessions.json');
  const runtime = service({ file }); const context = await runtime.create();
  await runtime.invalidateSessions();
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), []);
  await assert.rejects(service({ file }).get(context.session_id), { status: 404 });
});

test('Copilot service: concurrent messages serialize and cannot lose a preference update', async () => {
  const runtime = service(); const context = await runtime.create();
  await Promise.all(['低风险', '铜', '预算1000美元'].map((message) => runtime.query({ message }, { sessionId: context.session_id })));
  const final = await runtime.get(context.session_id);
  assert.equal(final.history.length, 3); assert.equal(final.constraints.ticket_usd, 1000);
  assert.equal(final.constraints.risk_max, 'LOW'); assert.deepEqual(final.constraints.commodities_include, ['copper']);
});

test('Copilot service: deletion or runtime change during a model call cannot resurrect stale context', async () => {
  for (const change of ['delete', 'mode']) {
    let release, entered;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    let mode = { demoMode: true, generation: 1 };
    const runtime = service({ runtimeMode: () => mode, llmConfigured: () => true,
      chatFn: async () => { entered(); await blocked; return { content: '{"intent":"REFINE","confidence":0.1}' }; } });
    const context = await runtime.create();
    const running = runtime.query({ message: 'copper' }, { sessionId: context.session_id });
    await waiting;
    if (change === 'delete') await runtime.delete(context.session_id);
    else mode = { demoMode: false, generation: 2 };
    release();
    await assert.rejects(running, { code: change === 'delete' ? 'session_not_found' : 'session_mode_changed' });
    if (change === 'delete') assert.equal(runtime.sessions.size, 0);
    else await assert.rejects(runtime.get(context.session_id), { status: 409 });
  }
});

test('Copilot service: structured recommendations arrive before slow narrative; invalid queries never call a model', async () => {
  let calls = 0, structured = false;
  const runtime = service({ llmConfigured: () => true, chatFn: async () => {
    calls += 1; if (calls === 2) assert.equal(structured, true);
    return { content: calls === 1 ? '{"intent":"TARGETED_SEARCH","confidence":0.9}' : 'Current price is 0.8.' };
  } });
  const result = await runtime.query({ message: 'copper' }, { onStructured: (value) => { structured = true; assert.equal(value.narrative_mode, 'template'); } });
  assert.equal(result.narrative_mode, 'llm');
  for (const input of [null, {}, { message: '' }, { message: 'x', limit: 11 }, { message: 'x', locale: 'xx' }]) await assert.rejects(runtime.query(input), { status: 400 });
  await assert.rejects(runtime.create({ locale: 'xx' }), { status: 400 });
  assert.equal(calls, 2);
});

test('Copilot service: the LLM disable switch, output cap and bounded concurrency apply to the new endpoints', async () => {
  let calls = 0;
  const disabled = service({ env: { LLM_PROXY_ENABLED: 'false' }, llmConfigured: () => true, chatFn: async () => { calls += 1; } });
  assert.equal((await disabled.query({ message: 'copper' })).intent_mode, 'deterministic');
  assert.equal(calls, 0);
  const capped = service({ env: { LLM_MAX_TOKENS_CAP: '8192' }, llmConfigured: () => true, chatFn: async (request) => {
    assert.equal(request.maxTokens, 8192); return { content: '{}' };
  } });
  await capped.query({ message: 'copper' });
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const limited = service({ env: { LLM_PROXY_MAX_CONCURRENCY: '1' }, llmConfigured: () => true, chatFn: async () => {
    entered(); await pending; return { content: '{}' };
  } });
  const first = limited.query({ message: 'copper' }); await waiting;
  const second = await limited.query({ message: 'aluminium' });
  assert.equal(second.intent_mode, 'deterministic'); assert.equal(second.narrative_mode, 'template');
  assert.equal(limited.modelInflight, 1); release(); await first;
  assert.equal(limited.modelInflight, 0);
});

test('Copilot service: unsupported numeric intervals ask for clarification without weakening saved limits', async () => {
  const runtime = service(); const context = await runtime.create();
  await runtime.query({ message: 'low risk, budget USD 1000' }, { sessionId: context.session_id });
  const result = await runtime.query({ message: '收益8%-12%' }, { sessionId: context.session_id });
  assert.equal(result.intent, 'CLARIFY'); assert.ok(result.clarifying_question);
  assert.equal(result.context.constraints.yield_min_bps, undefined);
  assert.equal(result.context.constraints.ticket_usd, 1000);
});

test('Copilot service: exceeding a cumulative filter limit is rejected without dropping the new hard constraint silently', async () => {
  const runtime = service(); const context = await runtime.create();
  runtime.sessions.get(context.session_id).constraints.regions_include = Array.from({ length: 12 }, (_, index) => `port-${index}`);
  await assert.rejects(runtime.query({ message: 'Shanghai' }, { sessionId: context.session_id }), { code: 'too_many_preferences', status: 400 });
  assert.equal((await runtime.get(context.session_id)).constraints.regions_include.length, 12);
  assert.equal((await runtime.get(context.session_id)).history.length, 0);
});
