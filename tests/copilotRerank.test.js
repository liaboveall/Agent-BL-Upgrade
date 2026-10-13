import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CopilotService } from '../src/copilot/service.js';
import { createCopilotRoutes } from '../src/app/copilotRoutes.js';
import { sendError } from '../src/app/http.js';
import { listen, requestJson } from './helpers/http.js';
import { pool } from './helpers/copilot.js';

function fixture(extra = {}) {
  const pools = [pool('C', { score: 0, yieldBps: 2000 }), pool('A', { commodity: 'Aluminium', score: 2000 })];
  const decisions = [];
  const service = new CopilotService({ getPools: async () => pools, getDecisions: async () => decisions,
    env: {}, now: () => 0, llmConfigured: () => false, ...extra });
  const change = async (action, { phase = 'EXECUTION_CONFIRMED', id = `D${decisions.length}`, poolId = 'C' } = {}) => {
    decisions.unshift({ pool_id: poolId, decision_id: id, action, reasoning_summary: 'Observed risk evidence', mode: 'demo', generation: 0 });
    await service.notifyDecision({ decision_id: id, action: phase });
  };
  return { service, pools, decisions, change };
}

test('Copilot rerank: pause drops a rank and resume restores it without another message or LLM call', async () => {
  const { service, pools, change } = fixture({ chatFn: async () => { throw new Error('rerank must not call a model'); } });
  const context = await service.create();
  const initial = await service.query({ message: 'compare copper aluminium' }, { sessionId: context.session_id });
  assert.equal(initial.recommendations[0].pool_id, 'C');
  const events = []; service.subscribe(context.session_id, (type, event) => events.push({ type, event }));
  pools[0].status = 'Paused'; pools[0].quote.risk_score_bps = 9000;
  await change('PAUSE');
  assert.equal(events[0].type, 'COPILOT_RERANK');
  assert.equal(events[0].event.result.recommendations[0].pool_id, 'A');
  assert.deepEqual(events[0].event.changes.find((entry) => entry.pool_id === 'C'), { pool_id: 'C', previous_rank: 1, rank: 2, previous_price_usd: 0.8, price_usd: 0.8 });
  pools[0].status = 'Open'; pools[0].quote.risk_score_bps = 0;
  await change('RESUME');
  assert.equal(events[1].event.result.recommendations[0].pool_id, 'C');
  const saved = await service.get(context.session_id);
  assert.equal(saved.history.length, 1); assert.deepEqual(saved.constraints.commodities_include, []);
});

test('Copilot rerank: hard filters, explicit pool scope, watchlists and removed recommendations remain consistent', async () => {
  const { service, pools, change } = fixture();
  const filtered = await service.create();
  const filteredResult = await service.query({ message: 'medium risk copper', pool_ids: ['C'] }, { sessionId: filtered.session_id });
  assert.equal(filteredResult.context.constraints.risk_max, 'MEDIUM');
  const other = await service.create();
  await service.query({ message: 'aluminium' }, { sessionId: other.session_id });
  const watching = await service.create(); await service.watch(watching.session_id, ['C']);
  const filteredEvents = [], otherEvents = [], watchedEvents = [];
  service.subscribe(filtered.session_id, (_type, data) => filteredEvents.push(data));
  service.subscribe(other.session_id, (_type, data) => otherEvents.push(data));
  service.subscribe(watching.session_id, (_type, data) => watchedEvents.push(data));
  pools[0].quote.risk_level = 'CRITICAL'; await change('PAUSE');
  assert.equal(filteredEvents[0].result.recommendations.length, 0);
  assert.equal(filteredEvents[0].changes[0].rank, null);
  assert.equal(otherEvents.length, 0); assert.equal(watchedEvents.length, 1);
  pools[0].quote.risk_level = 'MEDIUM'; await change('RESUME');
  assert.deepEqual(filteredEvents[1].result.recommendations.map((entry) => entry.pool_id), ['C']);
  assert.equal(filteredEvents[1].changes[0].previous_rank, null);
  await assert.rejects(service.watch(watching.session_id, ['unknown']), { status: 404 });
  await assert.rejects(service.watch(watching.session_id, [null]), { status: 400 });
});

test('Copilot rerank: recorded proposals retain the actual price, completed actions use the changed price and duplicate notifications are idempotent', async () => {
  const { service, pools, decisions, change } = fixture();
  const context = await service.create(); await service.query({ message: 'copper' }, { sessionId: context.session_id });
  const events = []; service.subscribe(context.session_id, (_type, data) => events.push(data));
  await change('REPRICE', { phase: 'DECISION_MADE', id: 'D1' });
  assert.equal(events[0].result.recommendations[0].price_usd, 0.8);
  pools[0].quote.final_issue_price_usd = 0.7; pools[0].quote.quote_hash = 'new';
  await service.notifyDecision({ decision_id: 'D1', action: 'EXECUTION_CONFIRMED' });
  await service.notifyDecision({ decision_id: 'D1', action: 'EXECUTION_CONFIRMED' });
  assert.equal(events.length, 2); assert.equal(events[1].result.recommendations[0].price_usd, 0.7);
  decisions.unshift({ decision_id: 'OLD', pool_id: 'C', action: 'PAUSE', mode: 'live', generation: 999 });
  await service.notifyDecision({ decision_id: 'OLD', action: 'EXECUTION_CONFIRMED' });
  assert.equal(events.length, 2);
});

test('Copilot rerank: deletion, expiry and mode invalidation close streams and cannot resurrect a session', async () => {
  let now = 0;
  const { service, change } = fixture({ now: () => now, env: { COPILOT_SESSION_TTL_SEC: '1', AGENTBL_MAX_SSE_CLIENTS: '1' } });
  const context = await service.create(); await service.query({ message: 'copper' }, { sessionId: context.session_id });
  const events = []; service.subscribe(context.session_id, (type) => events.push(type));
  assert.throws(() => service.subscribe(context.session_id, () => {}), { code: 'sse_capacity' });
  now = 1001; await change('PAUSE');
  assert.deepEqual(events, ['SESSION_CLOSED']); assert.equal(service.sessions.size, 0);
  const next = await service.create(); service.subscribe(next.session_id, (type) => events.push(type));
  await service.invalidateSessions(); assert.equal(service.subscribers.size, 0);
});

test('Copilot rerank: two subscribers retain the decision baseline when execution beats or follows the first notification', async () => {
  for (const completedEarly of [true, false]) {
    const { service, pools, decisions } = fixture();
    const contexts = await Promise.all([service.create(), service.create()]);
    for (const context of contexts) await service.query({ message: 'compare copper aluminium' }, { sessionId: context.session_id });
    const events = [[], []]; contexts.forEach((context, index) => service.subscribe(context.session_id, (_type, event) => events[index].push(event)));
    pools[0].status = 'Paused'; pools[0].quote.risk_score_bps = 9000;
    decisions.unshift({ pool_id: 'C', decision_id: 'FAST', action: 'PAUSE', status: completedEarly ? 'COMPLETED' : 'EXECUTING' });
    await service.notifyDecision({ decision_id: 'FAST', action: 'DECISION_MADE' });
    decisions[0].status = 'COMPLETED';
    await service.notifyDecision({ decision_id: 'FAST', action: 'EXECUTION_CONFIRMED' });
    for (const stream of events) {
      const last = stream.at(-1);
      assert.equal(last.phase, 'EXECUTION_CONFIRMED');
      const change = last.changes.find((item) => item.pool_id === 'C');
      assert.equal(change.previous_rank, 1); assert.equal(change.rank, 2);
      assert.equal(stream.length, completedEarly ? 1 : 2);
    }
  }
});

test('Copilot rerank: messages and notifications serialize; deletion during a snapshot does not restore state', async () => {
  const { service, change } = fixture();
  const context = await service.create(); await service.query({ message: 'copper' }, { sessionId: context.session_id });
  await Promise.all([change('PAUSE'), service.query({ message: 'instead aluminium' }, { sessionId: context.session_id })]);
  assert.deepEqual((await service.get(context.session_id)).constraints.commodities_include, ['aluminium']);
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  await service.watch(context.session_id, ['C']);
  const other = await service.create(); await service.query({ message: 'copper' }, { sessionId: other.session_id });
  const deliveries = []; service.subscribe(other.session_id, (type) => deliveries.push(type));
  const getPools = service.getPools;
  service.getPools = async () => { enter(); await waiting; return getPools(); };
  const pending = change('RESUME'); await entered; await service.delete(context.session_id); release();
  await pending; assert.equal(service.sessions.has(context.session_id), false);
  assert.deepEqual(deliveries, ['COPILOT_RERANK'], 'deleting one subscriber must not starve another session');
});

test('Copilot rerank: persisted snapshots resume after restart and store no private query vocabulary', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-rerank-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sessions.json');
  const { service, pools, decisions, change } = fixture({ file });
  const context = await service.create();
  await service.query({ message: 'copper, secretphrase myemail@example.invalid' }, { sessionId: context.session_id });
  pools[0].status = 'Paused'; await change('PAUSE');
  const serialized = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(serialized, /secretphrase|myemail|example\.invalid/u);
  const recovered = fixture({ file, getPools: async () => pools, getDecisions: async () => decisions }).service;
  const loaded = await recovered.get(context.session_id);
  assert.equal(loaded.last_update.seq, 1); assert.equal(loaded.last_update.decision_id, 'D0');
  assert.deepEqual(loaded.last_recommendation.spec.terms, ['copper', 'example']);
});

test('Copilot stream: real SSE push, cursor replay, capacity and session deletion have bounded lifecycles', async (t) => {
  const fixtureData = fixture({ env: { AGENTBL_MAX_SSE_CLIENTS: '1' } });
  const { service, change } = fixtureData;
  const route = createCopilotRoutes({ service });
  const server = await listen(http.createServer((req, res) => { route(req, res, new URL(req.url, 'http://localhost')).catch((error) => sendError(res, error)); }));
  t.after(() => { service.closeStreams(); return server.close(); });
  const context = await service.create(); await service.query({ message: 'copper' }, { sessionId: context.session_id });
  const endpoint = `${server.base}/api/copilot/sessions/${context.session_id}/stream`;
  const response = await fetch(endpoint), reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const decoder = new TextDecoder();
  const readUntil = async (source, pattern) => {
    let buffer = '';
    while (!pattern.test(buffer)) {
      const chunk = await source.read();
      if (chunk.done) throw new Error('SSE ended before the expected event');
      buffer += decoder.decode(chunk.value);
    }
    return buffer;
  };
  assert.match(await readUntil(reader, /event: connected/u), /event: connected/u);
  await change('PAUSE');
  const pushed = await readUntil(reader, /"decision_id":"D0"/u);
  assert.match(pushed, /event: COPILOT_RERANK/u); assert.match(pushed, /"decision_id":"D0"/u);
  assert.equal((await fetch(endpoint)).status, 503);
  assert.equal((await fetch(endpoint, { headers: { 'last-event-id': '999' } })).status, 400);
  await service.delete(context.session_id);
  assert.match(decoder.decode((await reader.read()).value), /SESSION_CLOSED/u);
  assert.equal((await reader.read()).done, true); assert.equal(service.subscribers.size, 0);
  assert.equal((await requestJson(server.base, 'GET', `/api/copilot/sessions/${context.session_id}`)).status, 404);
  const next = await service.create(); await service.query({ message: 'copper' }, { sessionId: next.session_id });
  await change('RESUME');
  const replay = await fetch(`${server.base}/api/copilot/sessions/${next.session_id}/stream?last_event_id=0`);
  const replayReader = replay.body.getReader();
  const snapshot = await readUntil(replayReader, /"replayed":true/u);
  assert.match(snapshot, /"replayed":true/u); assert.match(snapshot, /id: 1/u);
  await replayReader.cancel();
});
