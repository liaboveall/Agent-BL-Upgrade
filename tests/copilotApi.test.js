import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCopilotRoutes } from '../src/app/copilotRoutes.js';
import { CopilotService } from '../src/copilot/service.js';
import { sendError } from '../src/app/http.js';
import { listen, requestJson, clearLlmEnv } from './helpers/http.js';
import { pool } from './helpers/copilot.js';
import { readCopilotStream, copilotQuery, resetCopilotSession } from '../web/src/lib/copilot-api.js';

async function setup(t) {
  const service = new CopilotService({ getPools: async () => [pool('C')], now: () => 0, env: {}, llmConfigured: () => false });
  const route = createCopilotRoutes({ service });
  const handle = http.createServer((request, response) => {
    route(request, response, new URL(request.url, 'http://localhost')).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    }).catch((error) => sendError(response, error));
  });
  const server = await listen(handle); t.after(server.close);
  return { ...server, service };
}

test('Copilot API: create/read/message/delete session lifecycle and privacy', async (t) => {
  const { base } = await setup(t);
  const created = await requestJson(base, 'POST', '/api/copilot/sessions', { locale: 'en', wallet_address: 'do-not-store' });
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.data).includes('do-not-store'), false);
  const path = `/api/copilot/sessions/${created.data.context.session_id}`;
  assert.equal((await requestJson(base, 'GET', path)).data.context.locale, 'en');
  const queried = await requestJson(base, 'POST', `${path}/messages`, { message: 'copper' });
  assert.equal(queried.status, 200); assert.equal(queried.data.recommendations[0].pool_id, 'C');
  assert.equal(queried.data.context.history.length, 1);
  assert.equal((await requestJson(base, 'DELETE', path)).data.deleted, true);
  assert.equal((await requestJson(base, 'GET', path)).status, 404);
});

test('Copilot API: a follow-up introduction streams no asset recommendations and a greeted reset clears filters', async (t) => {
  const { base } = await setup(t);
  const created = await requestJson(base, 'POST', '/api/copilot/sessions', { locale: 'en' });
  const path = `/api/copilot/sessions/${created.data.context.session_id}`;
  const first = await requestJson(base, 'POST', `${path}/messages`, { message: 'copper, budget USD 1000' });
  assert.equal(first.data.recommendations[0].pool_id, 'C');
  const response = await fetch(`${base}${path}/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ message: 'hello, who are you?' }) });
  const events = [];
  const result = await readCopilotStream(response, (event) => events.push(event));
  assert.deepEqual(events, ['result', 'narrative', 'done']);
  assert.equal(result.intent, 'OUT_OF_SCOPE');
  assert.deepEqual(result.recommendations, []);
  assert.deepEqual(result.context.constraints, first.data.context.constraints);
  assert.match(result.narrative, /I am the AgentBL investor Copilot/u);
  const portfolio = await requestJson(base, 'POST', `${path}/messages`, { message: '你好，查看持仓' });
  assert.equal(portfolio.data.intent, 'PORTFOLIO');
  const reset = await requestJson(base, 'POST', `${path}/messages`, { message: '你好，清空条件' });
  assert.equal(reset.data.intent, 'RESET');
  assert.deepEqual(reset.data.context.constraints.commodities_include, []);
  assert.equal(reset.data.context.constraints.ticket_usd, undefined);
});

test('Copilot API: SSE sends structured results then validated narrative and completion', async (t) => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/api/copilot/query`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ message: '铜' }) });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events = [];
  const result = await readCopilotStream(response, (event) => events.push(event));
  assert.deepEqual(events, ['result', 'narrative', 'done']);
  assert.equal(result.recommendations[0].label, 'Copper Cathodes');
  assert.equal(result.narrative_mode, 'template');
});

test('Copilot API: malformed, oversized and unknown routes return errors before any stream opens', async (t) => {
  const { base } = await setup(t);
  for (const [path, body, status] of [
    ['/api/copilot/query', '{', 400], ['/api/copilot/query', {}, 400],
    ['/api/copilot/query', { message: 'x'.repeat(20000) }, 413], ['/api/copilot/sessions', [], 400],
    ['/api/copilot/sessions', { locale: 'invalid' }, 400], ['/api/copilot/unknown', {}, 404]
  ]) assert.equal((await requestJson(base, 'POST', path, body)).status, status);
  const missing = await requestJson(base, 'POST', '/api/copilot/sessions/00000000-0000-0000-0000-000000000000/messages', { message: 'copper' }, { accept: 'text/event-stream' });
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/u);
});

test('Copilot API: real server routes use latest market pools and positions expose current state', async (t) => {
  clearLlmEnv();
  const { createServer, closeActivityStreams, copilotService } = await import('../src/app/server.js');
  const { storeState, resetStore, createPool, subscribeToPool } = await import('../src/app/store.js');
  resetStore(); t.after(() => { closeActivityStreams(); resetStore(); });
  copilotService.llmConfigured = () => false;
  const initial = pool('CASE-COPILOT-CU');
  createPool(initial.poolId, initial.caseData, initial.quote);
  subscribeToPool('0xDemoWallet', initial.poolId, 1000);
  storeState.pools.get(initial.poolId).status = 'Paused';
  storeState.pools.get(initial.poolId).quote.final_issue_price_usd = 0.7;
  const server = await listen(createServer()); t.after(server.close);
  const result = await requestJson(server.base, 'POST', '/api/copilot/query', { message: 'copper' });
  assert.ok(!result.data.recommendations.some((item) => item.pool_id === initial.poolId), 'paused pools cannot be offered as investments');
  const positions = (await requestJson(server.base, 'GET', '/api/investors/portfolio')).data;
  assert.equal(positions.investments[0].current_status, 'Paused');
  assert.equal(positions.investments[0].current_price_usd, 0.7);
  assert.equal(positions.investments[0].source_label, 'Market');
  assert.equal(positions.investments[0].price, 0.8, 'original entry price is preserved');
  assert.equal(positions.investments[0].txHash, null);
  const session = (await requestJson(server.base, 'POST', '/api/copilot/sessions', {})).data.context.session_id;
  assert.equal((await requestJson(server.base, 'POST', '/api/demo/reset', {})).status, 200);
  assert.equal((await requestJson(server.base, 'GET', `/api/copilot/sessions/${session}`)).status, 404);
});

test('Copilot browser SSE parser: split bytes preserve Chinese text; truncated streams are errors', async () => {
  const text = 'event: result\ndata: {"recommendations":[],"narrative":"中文"}\n\nevent: narrative\ndata: {"narrative":"解释"}\n\nevent: done\ndata: {"ok":true}\n\n';
  for (const source of [text, text.replaceAll('\n', '\r\n')]) {
    const encoded = new TextEncoder().encode(source);
    const body = new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    assert.equal((await readCopilotStream(new Response(body))).narrative, '解释');
  }
  await assert.rejects(readCopilotStream(new Response('event: result\ndata: {}\n\n')), /interrupted/u);
});

test('Copilot browser: a result from another mode generation is never rendered or accepted', async () => {
  const original = globalThis.fetch;
  let rendered = false;
  globalThis.fetch = async () => new Response('event: result\ndata: {"mode":"demo","generation":999,"recommendations":[]}\n\nevent: narrative\ndata: {"narrative":"stale"}\n\nevent: done\ndata: {"ok":true}\n\n');
  try {
    await assert.rejects(copilotQuery('copper', { stateless: true, onResult: () => { rendered = true; } }), { code: 'session_mode_changed' });
    assert.equal(rendered, false);
  } finally { globalThis.fetch = original; resetCopilotSession(); }
});
