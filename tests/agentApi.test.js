import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { listen, requestJson } from './helpers/http.js';

process.env.AGENTBL_RATE_LIMIT_PER_MIN = '0';
process.env.AGENTBL_WRITE_RATE_LIMIT_PER_MIN = '0';
delete process.env.AGENTBL_ADMIN_TOKEN;
delete process.env.XAPI_KEY;

const { createServer, closeActivityStreams, setAgentService, activityLog } = await import('../src/app/server.js');
const { createPool, resetStore, storeState } = await import('../src/app/store.js');
const { quoteFromCase } = await import('../src/core/pricingEngine.js');
const { loadAgentConfig } = await import('../src/agent/runtime/config.js');
const { createAgentService, loadChainConfig } = await import('../src/agent/runtime/factory.js');
const { demoModeController } = await import('../src/demo/mode.js');
const { createAgentRoutes } = await import('../src/app/agentRoutes.js');
const { ActivityLog } = await import('../src/agent/runtime/activityLog.js');

const iron = JSON.parse(await fs.readFile(new URL('../data/cases/ironore-au-tj.case.json', import.meta.url), 'utf8'));
const typhoon = [{ type: 'severe_weather', region: 'East China Sea', severity: 'warning', description: 'typhoon', date: '2026-10-12' }];
const warCrisis = [{ type: 'war_risk', region: 'Strait of Hormuz', severity: 'critical', description: 'closure', date: '2026-10-12' }];
const TOKEN = 'a-long-enough-admin-token-for-tests';
const bearer = { authorization: `Bearer ${TOKEN}` };

async function freshService(env = {}) {
  resetStore();
  storeState.agentActivities = [];
  createPool(iron.case_id, iron, quoteFromCase(iron, { payout_speed: 'BALANCED' }));
  const service = createAgentService({
    config: loadAgentConfig({ AGENT_COOLDOWN_SEC: '0', ...env }),
    demoModeController,
    ensurePools: async () => {},
    activity: activityLog,
    store: storeState,
    chainConfig: loadChainConfig(),
    sleep: async () => {}
  });
  activityLog.seq = 0;
  await service.start();
  setAgentService(service);
  return service;
}

const event = (type, extra = {}) => ({ type, case_id: iron.case_id, ...extra });

function openStream(base, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${pathname}`, { headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      resolve({
        response,
        text: () => text,
        waitFor: async (pattern, timeoutMs = 2000) => {
          const deadline = Date.now() + timeoutMs;
          while (!pattern.test(text)) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; got ${JSON.stringify(text)}`);
            await new Promise((r) => setTimeout(r, 15));
          }
          return text;
        },
        close: () => request.destroy()
      });
    });
    request.on('error', reject);
  });
}

test('agent API (Demo)', async (t) => {
  const app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); delete process.env.AGENTBL_ADMIN_TOKEN; });
  const api = (method, path, body, headers) => requestJson(app.base, method, path, body, headers);

  await t.test('GET /api/agent/status is public and reports the runtime without exposing keys', async () => {
    const service = await freshService();
    const res = await api('GET', '/api/agent/status');
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.running, true);
    assert.equal(res.data.mode, 'demo');
    assert.equal(res.data.executor, 'sim');
    assert.equal(res.data.autonomy.effective, 'auto');
    for (const signer of Object.values(res.data.signers)) assert.deepEqual(Object.keys(signer), ['configured']);
    const { version, ...anchoring } = res.data.anchoring;
    assert.deepEqual(Object.keys(version).sort(), ['code_commit', 'model_id', 'policy_hash', 'version_id']);
    for (const name of ['code_commit', 'policy_hash', 'version_id']) assert.match(version[name], /^0x[0-9a-f]{64}$/u);
    assert.equal(version.model_id, 'x-test-2');
    assert.doesNotMatch(JSON.stringify({ ...res.data, anchoring }), /PRIVATE_KEY|0x[0-9a-f]{64}/u);
    await service.stop();
  });

  await t.test('an injected world-risk event produces a decision, an executed simulated reprice and a trace', async () => {
    const service = await freshService();
    const res = await api('POST', '/api/agent/events?wait=1', event('WORLD_RISK_UPDATED', { event_id: 'api-1', data: { events: typhoon } }));
    assert.equal(res.status, 200);
    assert.equal(res.data.accepted, true);
    assert.equal(res.data.processing.status, 'DONE');
    const [decisionId] = res.data.processing.result.decisions;

    const list = await api('GET', '/api/agent/decisions');
    assert.equal(list.data.count, 1);
    assert.equal(list.data.decisions[0].decision_id, decisionId);

    const detail = await api('GET', `/api/agent/decisions/${decisionId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.decision.action, 'REPRICE');
    assert.equal(detail.data.decision.status, 'COMPLETED');
    assert.match(detail.data.decision.execution.reference, /^demo:/u);
    assert.equal(detail.data.decision.execution.tx_hash, undefined);
    assert.deepEqual(detail.data.activity.map((a) => a.action), ['DECISION_MADE', 'EXECUTION_SUBMITTED', 'EXECUTION_CONFIRMED']);
    assert.equal(detail.data.decision.input_snapshot.source, 'admin', 'the caller cannot pick the event source');

    const trace = await api('GET', `/api/agent/decisions/${decisionId}/trace`);
    assert.equal(trace.status, 200);
    assert.deepEqual(trace.data.trace.spans.map((s) => s.name).sort(), ['execute', 'monitor_pipeline', 'policy']);

    assert.equal(storeState.pools.get(iron.case_id).status, 'Open');
    await service.stop();
  });

  await t.test('the same event again is a duplicate and does not execute twice', async () => {
    const service = await freshService();
    await api('POST', '/api/agent/events?wait=1', event('WORLD_RISK_UPDATED', { event_id: 'dup', data: { events: typhoon } }));
    const again = await api('POST', '/api/agent/events?wait=1', event('WORLD_RISK_UPDATED', { event_id: 'dup', data: { events: typhoon } }));
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.accepted, false);
    assert.equal((await api('GET', '/api/agent/decisions')).data.count, 1);
    await service.stop();
  });

  await t.test('without ?wait the event is accepted (202) and processed in the background', async () => {
    const service = await freshService();
    const res = await api('POST', '/api/agent/events', event('WORLD_RISK_UPDATED', { event_id: 'bg', data: { events: typhoon } }));
    assert.equal(res.status, 202);
    assert.equal(res.data.status, 'RECEIVED');
    await service.bus.idle();
    assert.equal((await api('GET', '/api/agent/decisions')).data.count, 1);
    await service.stop();
  });

  await t.test('invalid input is refused with a 4xx and a readable reason', async () => {
    const service = await freshService();
    const bad = await api('POST', '/api/agent/events', { type: 'NOPE', case_id: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.code, 'invalid_event');
    assert.ok(Array.isArray(bad.data.details) && bad.data.details.length > 0);
    assert.equal((await api('POST', '/api/agent/events', [])).status, 400);
    assert.equal((await api('POST', '/api/agent/events', event('PAYMENT_RECEIVED', { data: {} }))).data.code, 'invalid_event');
    assert.equal((await api('GET', '/api/agent/decisions/decision_nope')).status, 404);
    assert.equal((await api('GET', '/api/agent/decisions/decision_nope/trace')).status, 404);
    assert.equal((await api('GET', '/api/agent/decisions/bad%20id%21')).status, 400);
    assert.equal((await api('GET', '/api/agent/decisions?limit=9999')).status, 400);
    assert.equal((await api('POST', '/api/agent/control', { action: 'dance' })).data.code, 'invalid_action');
    assert.equal((await api('POST', '/api/agent/control', 'not json')).status, 400);
    await service.stop();
  });

  await t.test('control: autonomy and emergency stop change what the agent does', async () => {
    const service = await freshService();
    const observe = await api('POST', '/api/agent/control', { action: 'set_autonomy', autonomy: 'observe' });
    assert.equal(observe.data.autonomy.effective, 'observe');
    await api('POST', '/api/agent/events?wait=1', event('WORLD_RISK_UPDATED', { event_id: 'c1', occurred_at: '2026-10-12T09:00:00Z', data: { events: typhoon } }));
    assert.equal((await api('GET', '/api/agent/decisions')).data.decisions[0].status, 'SKIPPED');
    await api('POST', '/api/agent/control', { action: 'set_autonomy', autonomy: 'auto' });
    const stop = await api('POST', '/api/agent/control', { action: 'emergency_stop' });
    assert.equal(stop.data.emergency_stop, true);
    await api('POST', '/api/agent/events?wait=1', event('WORLD_RISK_UPDATED', { event_id: 'c2', occurred_at: '2026-10-12T10:00:00Z', data: { events: typhoon } }));
    assert.equal((await api('GET', '/api/agent/decisions')).data.decisions[0].status, 'REJECTED');
    const stopped = await api('POST', '/api/agent/control', { action: 'stop' });
    assert.equal(stopped.data.running, false);
    await service.stop();
  });

  await t.test('approvals: list, approve and reject over HTTP; conflicting or malformed requests are 4xx', async () => {
    const service = await freshService({ AGENT_MAX_PRICE_MOVE_BPS: '10' });
    await api('POST', '/api/agent/events?wait=1', event('WORLD_RISK_UPDATED', { event_id: 'ap1', occurred_at: '2026-10-12T09:00:00Z', data: { events: typhoon } }));
    const list = await api('GET', '/api/agent/approvals?status=PENDING');
    assert.equal(list.status, 200);
    assert.equal(list.data.approvals.length, 1);
    const [approval] = list.data.approvals;
    assert.equal(approval.route, 'sim');

    const detail = await api('GET', `/api/agent/approvals/${approval.approval_id}`);
    assert.equal(detail.data.decision.status, 'PENDING_APPROVAL');

    const approved = await api('POST', `/api/agent/approvals/${approval.approval_id}/approve`, { note: 'looks right' });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.approval.status, 'EXECUTED');
    assert.equal(approved.data.decision.status, 'COMPLETED');
    assert.equal(storeState.pools.get(iron.case_id).status, 'Open');

    const twice = await api('POST', `/api/agent/approvals/${approval.approval_id}/approve`, {});
    assert.equal(twice.status, 409);
    assert.equal(twice.data.code, 'invalid_transition');
    assert.equal((await api('GET', '/api/agent/approvals/appr_missing')).status, 404);
    assert.equal((await api('POST', '/api/agent/approvals/appr_missing/reject', {})).status, 404);

    await api('POST', '/api/agent/events?wait=1', event('WORLD_RISK_UPDATED', { event_id: 'ap2', occurred_at: '2026-10-12T10:00:00Z', data: { events: warCrisis } }));
    // a second large price move: use a fresh pending approval to reject
    await api('POST', '/api/agent/control', { action: 'set_autonomy', autonomy: 'propose' });
    await api('POST', '/api/agent/events?wait=1', event('INSURANCE_EXPIRING', { event_id: 'ap3', occurred_at: '2026-10-12T11:00:00Z', data: { days_left: 2 } }));
    await api('POST', '/api/agent/events?wait=1', event('INSURANCE_EXPIRED', { event_id: 'ap4', occurred_at: '2026-10-12T12:00:00Z' }));
    const pending = (await api('GET', '/api/agent/approvals?status=PENDING')).data.approvals;
    for (const item of pending) {
      const rejected = await api('POST', `/api/agent/approvals/${item.approval_id}/reject`, { note: 'no' });
      assert.equal(rejected.data.approval.status, 'REJECTED');
    }

    // attach-tx is only for owner-signed approvals
    assert.equal((await api('POST', `/api/agent/approvals/${approval.approval_id}/attach-tx`, {})).status, 400);
    const wrongState = await api('POST', `/api/agent/approvals/${approval.approval_id}/attach-tx`, { tx_hash: `0x${'ab'.repeat(32)}` });
    assert.equal(wrongState.status, 409);
    await service.stop();
  });

  await t.test('the admin token protects control, events and the approval queue once it is configured', async () => {
    const service = await freshService();
    process.env.AGENTBL_ADMIN_TOKEN = TOKEN;
    try {
      assert.equal((await api('GET', '/api/agent/status')).status, 200, 'status stays public');
      assert.equal((await api('GET', '/api/agent/decisions')).status, 200, 'decisions stay public');
      for (const [method, path, body] of [
        ['POST', '/api/agent/events', event('RISK_CLEARED')],
        ['POST', '/api/agent/control', { action: 'tick' }],
        ['GET', '/api/agent/approvals'],
        ['POST', '/api/agent/approvals/x/approve', {}],
        ['POST', '/api/agent/pools/link', { case_id: iron.case_id, chain_pool_id: 2 }]
      ]) {
        const res = await api(method, path, body);
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.equal(res.data.code, 'admin_token_required');
      }
      assert.equal((await api('POST', '/api/agent/control', { action: 'tick' }, { authorization: 'Bearer wrong-token-wrong-token' })).status, 401);
      const ok = await api('POST', '/api/agent/control', { action: 'tick' }, bearer);
      assert.equal(ok.status, 200);
      const injected = await api('POST', '/api/agent/events?wait=1', event('WORLD_RISK_UPDATED', { event_id: 'tok', data: { events: typhoon } }), bearer);
      assert.equal(injected.status, 200);
      const approved = (await api('GET', '/api/agent/decisions')).data.decisions[0];
      assert.equal(approved.status, 'COMPLETED');
    } finally {
      delete process.env.AGENTBL_ADMIN_TOKEN;
      await service.stop();
    }
  });

  await t.test('the activity stream sends an id per event and replays what a reconnecting client missed', async () => {
    const service = await freshService();
    const first = await openStream(app.base, '/api/agent/activity/stream');
    let lastId;
    try {
      await first.waitFor(/"type":"connected"/u);
      await api('POST', '/api/agent/events?wait=1', event('WORLD_RISK_UPDATED', { event_id: 's1', occurred_at: '2026-10-12T09:00:00Z', data: { events: typhoon } }));
      const text = await first.waitFor(/EXECUTION_CONFIRMED/u);
      const ids = [...text.matchAll(/^id: (\d+)$/gmu)].map((m) => Number(m[1]));
      assert.ok(ids.length >= 3, `ids: ${ids}`);
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
      lastId = ids[0];
    } finally {
      first.close();
    }
    // Reconnect "after" the first id: everything after it is replayed, nothing before.
    const second = await openStream(app.base, '/api/agent/activity/stream', { 'Last-Event-ID': String(lastId) });
    try {
      const text = await second.waitFor(/EXECUTION_CONFIRMED/u);
      const ids = [...text.matchAll(/^id: (\d+)$/gmu)].map((m) => Number(m[1]));
      assert.ok(ids.every((id) => id > lastId));
      assert.ok(ids.length >= 2);
      assert.ok(!/AGENT_STARTED/u.test(text) || ids.every((id) => id > lastId));
    } finally {
      second.close();
    }
    // The REST feed offers the same resume: since_seq.
    const rest = await api('GET', `/api/agent/activity?since_seq=${lastId}`);
    assert.ok(rest.data.activities.every((a) => a.seq > lastId));
    assert.equal(rest.data.last_seq, activityLog.seq);
    await service.stop();
  });

  await t.test('POST /api/demo/reset clears what the agent recorded in Demo and rebuilds the pools', async () => {
    const service = await freshService();
    await api('POST', '/api/agent/events?wait=1', event('WORLD_RISK_UPDATED', { event_id: 'rs1', data: { events: typhoon } }));
    assert.equal((await api('GET', '/api/agent/decisions')).data.count, 1);
    const reset = await api('POST', '/api/demo/reset');
    assert.equal(reset.status, 200);
    assert.equal((await api('GET', '/api/agent/decisions')).data.count, 0);
    assert.equal(service.bus.get('event:rs1'), null);
    assert.ok((await api('GET', '/api/market/listings')).data.count > 0, 'the offchain pools are rebuilt on demand');
    await service.stop();
  });
});

test('agent API: in Live the admin token is mandatory even for actions Demo leaves open', async () => {
  const fakeService = {
    submitEvent: async () => ({ idempotency_key: 'k' }),
    control: async () => ({ ok: true }),
    status: async () => ({})
  };
  const routes = createAgentRoutes({ getService: () => fakeService, runtimeMode: () => ({ mode: 'live' }), activityLog: new ActivityLog() });
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (!(await routes(request, response, url))) { response.statusCode = 404; response.end('{}'); }
    } catch (error) {
      response.statusCode = error.status ?? 500;
      response.end(JSON.stringify({ code: error.code }));
    }
  });
  const app = await listen(server);
  try {
    delete process.env.AGENTBL_ADMIN_TOKEN;
    const noToken = await requestJson(app.base, 'POST', '/api/agent/control', { action: 'tick' });
    assert.equal(noToken.status, 403);
    assert.equal(noToken.data.code, 'admin_token_not_configured');
    process.env.AGENTBL_ADMIN_TOKEN = TOKEN;
    assert.equal((await requestJson(app.base, 'POST', '/api/agent/control', { action: 'tick' })).status, 401);
    assert.equal((await requestJson(app.base, 'POST', '/api/agent/control', { action: 'tick' }, bearer)).status, 200);
    assert.equal((await requestJson(app.base, 'GET', '/api/agent/status')).status, 200, 'status stays public in Live');
  } finally {
    delete process.env.AGENTBL_ADMIN_TOKEN;
    await app.close();
  }
});
