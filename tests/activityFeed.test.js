// The agent activity feed used to be plumbing with no producers: nothing in the
// server ever called logAgentActivity, so /api/agent/activity and the SSE stream
// were always empty. These tests pin the producers plus the SSE hardening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listen, requestJson } from './helpers/http.js';

process.env.AGENTBL_RATE_LIMIT_PER_MIN = '0';
process.env.AGENTBL_WRITE_RATE_LIMIT_PER_MIN = '0';
delete process.env.XAPI_KEY;

const { createServer, closeActivityStreams } = await import('../src/app/server.js');
const { resetStore, storeState } = await import('../src/app/store.js');

/** Open an SSE stream and collect what arrives. */
function openStream(base, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${pathname}`, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      const handle = {
        response,
        text: () => text,
        waitFor: async (pattern, timeoutMs = 2000) => {
          const deadline = Date.now() + timeoutMs;
          while (!pattern.test(text)) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}; got: ${JSON.stringify(text)}`);
            await new Promise((r) => setTimeout(r, 15));
          }
          return text;
        },
        close: () => request.destroy()
      };
      resolve(handle);
    });
    request.on('error', reject);
  });
}

const activities = async (base, query = '') => (await requestJson(base, 'GET', `/api/agent/activity${query}`)).data.activities;

test('agent activity feed', async (t) => {
  const app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); });
  t.beforeEach(() => { resetStore(); storeState.agentActivities = []; });

  await t.test('a priced quote is recorded as PRICING_QUOTE with its price', async () => {
    const quote = await requestJson(app.base, 'POST', '/api/pricing/quote', {});
    assert.equal(quote.status, 200);
    const [entry] = await activities(app.base, `?case_id=${quote.data.case_id}`);
    assert.equal(entry.action, 'PRICING_QUOTE');
    assert.equal(entry.type, 'PRICING');
    assert.equal(entry.details.price, quote.data.final_issue_price_usd);
    assert.ok(entry.id && entry.timestamp);
  });

  await t.test('a quote over a case the caller posted is answered but never written to the public feed', async () => {
    const demoCase = (await requestJson(app.base, 'GET', '/api/demo-data')).data;
    const quote = await requestJson(app.base, 'POST', '/api/pricing/quote', { case: { ...demoCase, case_id: 'CASE-FORGED-BY-CALLER' } });
    assert.equal(quote.status, 200);
    assert.equal(quote.data.case_id, 'CASE-FORGED-BY-CALLER');
    assert.deepEqual(await activities(app.base, '?case_id=CASE-FORGED-BY-CALLER'), []);
  });

  await t.test('a subscription is recorded without publishing the full wallet address', async () => {
    const listings = await requestJson(app.base, 'GET', '/api/market/listings');
    const pool = listings.data.pools[0];
    const wallet = '0x1234567890abcdef1234567890abcdef12345678';
    const res = await requestJson(app.base, 'POST', '/api/pool/subscribe', { wallet_address: wallet, pool_id: pool.poolId, amount_usd: 500 });
    assert.equal(res.status, 200);

    const [entry] = await activities(app.base, `?pool_id=${encodeURIComponent(pool.poolId)}`);
    assert.equal(entry.action, 'SUBSCRIPTION');
    assert.equal(entry.details.amountUsd, res.data.investment.amountUsd);
    assert.equal(entry.details.wallet, '0x1234…5678');
    assert.ok(!JSON.stringify(entry).includes(wallet), 'the feed is public; do not leak the whole address');
  });

  await t.test('a document upload and a world-risk escalation are recorded', async () => {
    const upload = await requestJson(app.base, 'POST', '/api/ebl/upload', {
      file: { name: '../../etc/invoice.pdf', type: 'application/pdf', size: 1000 },
      case_id: 'CASE-EBL-2026-CU-SG-SHA'
    });
    assert.equal(upload.status, 200);
    assert.equal(upload.data.document.fileName, 'invoice.pdf', 'path components are stripped');

    const risk = await requestJson(app.base, 'POST', '/api/intel/world-risk', {});
    assert.equal(risk.status, 200);
    assert.ok(risk.data.events.length > 0);

    const all = await activities(app.base);
    assert.deepEqual(all.map((entry) => entry.action).sort(), ['RISK_ESCALATION', 'eBL_UPLOADED']);
    assert.equal(all.find((entry) => entry.action === 'RISK_ESCALATION').details.events, risk.data.events.length);
  });

  await t.test('subscribers receive a connected frame, then live activity, filtered by case', async () => {
    const demoCase = (await requestJson(app.base, 'GET', '/api/demo-data')).data;
    const stream = await openStream(app.base, `/api/agent/activity/stream?case_id=${encodeURIComponent(demoCase.case_id)}`);
    try {
      assert.equal(stream.response.statusCode, 200);
      assert.equal(stream.response.headers['content-type'], 'text/event-stream');
      assert.equal(stream.response.headers['x-accel-buffering'], 'no');
      await stream.waitFor(/"type":"connected"/u);
      assert.match(stream.text(), /^retry: 3000/u);

      await requestJson(app.base, 'POST', '/api/pricing/quote', { case: { ...demoCase, case_id: 'CASE-OTHER' } });
      await requestJson(app.base, 'POST', '/api/pricing/quote', {}); // the demo case matches the subscriber's filter
      const text = await stream.waitFor(/"action":"PRICING_QUOTE"/u);
      assert.ok(text.includes('"type":"activity"'));
      assert.ok(text.includes('"activityType":"PRICING"'));
      assert.ok(!text.includes('CASE-OTHER'), 'events for other cases must not reach this subscriber');
    } finally {
      stream.close();
    }
  });

  await t.test('idle streams get heartbeat comments so proxies do not drop them', async () => {
    process.env.AGENTBL_SSE_HEARTBEAT_MS = '40';
    const stream = await openStream(app.base, '/api/agent/activity/stream');
    try {
      await stream.waitFor(/: ping/u, 1500);
    } finally {
      stream.close();
      delete process.env.AGENTBL_SSE_HEARTBEAT_MS;
    }
  });

  await t.test('the number of concurrent subscribers is capped', async () => {
    process.env.AGENTBL_MAX_SSE_CLIENTS = '1';
    const first = await openStream(app.base, '/api/agent/activity/stream');
    try {
      await first.waitFor(/connected/u);
      const second = await requestJson(app.base, 'GET', '/api/agent/activity/stream');
      assert.equal(second.status, 503);
      assert.equal(second.data.code, 'sse_capacity');
    } finally {
      first.close();
      delete process.env.AGENTBL_MAX_SSE_CLIENTS;
    }
  });

  await t.test('closed subscribers are removed from the registry', async () => {
    const stream = await openStream(app.base, '/api/agent/activity/stream');
    await stream.waitFor(/connected/u);
    assert.equal(storeState.sseClients.length, 1);
    stream.close();
    const deadline = Date.now() + 1500;
    while (storeState.sseClients.length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(storeState.sseClients.length, 0);
  });

  await t.test('closeActivityStreams ends every open stream (graceful shutdown)', async () => {
    const stream = await openStream(app.base, '/api/agent/activity/stream');
    await stream.waitFor(/connected/u);
    const ended = new Promise((resolve) => stream.response.on('end', resolve));
    closeActivityStreams();
    await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('stream was not closed')), 1500))]);
    assert.deepEqual(storeState.sseClients, []);
  });
});
