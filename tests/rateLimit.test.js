// Limiters are created at import time from the environment, so configure first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listen, requestJson } from './helpers/http.js';

process.env.AGENTBL_RATE_LIMIT_PER_MIN = '8';
process.env.AGENTBL_WRITE_RATE_LIMIT_PER_MIN = '3';
process.env.LLM_RATE_LIMIT_PER_MIN = '2';
delete process.env.TRUST_PROXY;

const { createServer, resetRateLimiters } = await import('../src/app/server.js');

test('per-IP rate limiting', async (t) => {
  const app = await listen(createServer());
  t.after(() => app.close());
  t.beforeEach(() => resetRateLimiters());

  await t.test('API requests beyond the per-minute budget get 429 with Retry-After; health and static are exempt', async () => {
    for (let i = 0; i < 8; i += 1) {
      assert.equal((await requestJson(app.base, 'GET', '/api/demo/mode')).status, 200, `request ${i + 1}`);
    }
    const limited = await requestJson(app.base, 'GET', '/api/demo/mode');
    assert.equal(limited.status, 429);
    assert.equal(limited.data.code, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);

    assert.equal((await requestJson(app.base, 'GET', '/api/health')).status, 200, 'health checks are never throttled');
    assert.equal((await fetch(`${app.base}/application-config.json`)).status, 200, 'static assets are not API traffic');
  });

  await t.test('writes have a tighter budget than reads', async () => {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await requestJson(app.base, 'POST', '/api/demo/reset')).status, 200, `write ${i + 1}`);
    }
    const limited = await requestJson(app.base, 'POST', '/api/demo/reset');
    assert.equal(limited.status, 429);
    assert.equal((await requestJson(app.base, 'GET', '/api/demo/mode')).status, 200, 'reads are still within their own budget');
  });

  await t.test('the LLM relay is throttled separately (and counted even when it answers an error)', async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await requestJson(app.base, 'POST', '/api/llm/chat', { messages: [] });
      assert.notEqual(res.status, 429, `llm request ${i + 1}`);
    }
    const limited = await requestJson(app.base, 'POST', '/api/llm/chat', { messages: [] });
    assert.equal(limited.status, 429);
  });

  await t.test('X-Forwarded-For is ignored unless TRUST_PROXY is set (cannot be used to dodge the limit)', async () => {
    const spoofed = async (n) => requestJson(app.base, 'GET', '/api/demo/mode', undefined, { 'x-forwarded-for': `203.0.113.${n}` });
    for (let i = 0; i < 8; i += 1) assert.equal((await spoofed(i)).status, 200);
    assert.equal((await spoofed(99)).status, 429, 'rotating the header must not mint fresh budgets');

    resetRateLimiters();
    process.env.TRUST_PROXY = '1';
    try {
      for (let i = 0; i < 8; i += 1) assert.equal((await spoofed(1)).status, 200);
      assert.equal((await spoofed(1)).status, 429, 'same forwarded client shares one budget');
      assert.equal((await spoofed(2)).status, 200, 'a different forwarded client gets its own');
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });
});
