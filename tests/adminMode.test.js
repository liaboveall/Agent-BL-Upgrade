// Runtime mode switching is an admin operation. The singleton mode controller reads
// DEMO_MODE at import time, so the environment is prepared before the dynamic imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listen, requestJson } from './helpers/http.js';

const TOKEN = 'unit-test-admin-token-0123456789';
const LIVE_ENV = {
  X402_MODE: 'live',
  X402_FACILITATOR_URL: 'https://facilitator.example',
  X402_PAY_TO: '0x000000000000000000000000000000000000dEaD'
};

process.env.DEMO_MODE = 'false'; // boot in Live
for (const name of Object.keys(LIVE_ENV)) delete process.env[name]; // ...but not Live-ready yet
process.env.AGENTBL_ADMIN_TOKEN = TOKEN;

const { createServer } = await import('../src/app/server.js');
const { demoModeController } = await import('../src/demo/mode.js');

const bearer = (token) => ({ authorization: `Bearer ${token}` });

test('runtime mode switching requires the admin token', async (t) => {
  const app = await listen(createServer());
  t.after(() => app.close());
  const post = (mode, headers) => requestJson(app.base, 'POST', '/api/demo/mode', { mode }, headers);

  assert.equal(demoModeController.snapshot().mode, 'live', 'precondition: server booted in Live mode');

  await t.test('an anonymous caller cannot leave Live mode (the paywall-bypass chain is closed)', async () => {
    const anonymous = await post('demo');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.data.code, 'admin_token_required');

    const wrong = await post('demo', bearer('definitely-not-the-token'));
    assert.equal(wrong.status, 401);
    const wrongHeader = await post('demo', { 'x-admin-token': `${TOKEN}-nope` });
    assert.equal(wrongHeader.status, 401);

    assert.equal(demoModeController.snapshot().mode, 'live', 'mode must be unchanged by rejected requests');
    // With the server still in Live mode the simulated (personal_sign) payment transport stays off.
    const paid = await requestJson(app.base, 'POST', '/api/x402/intel/premium-risk', {}, {
      'x402-signature': '0x00', 'x402-signer': '0x0000000000000000000000000000000000000001'
    });
    assert.notEqual(paid.status, 200, 'paid report must not be delivered by a Live server to an unpaid caller');
  });

  await t.test('the correct token (Bearer or X-Admin-Token) switches the mode', async () => {
    const viaBearer = await post('demo', bearer(TOKEN));
    assert.equal(viaBearer.status, 200);
    assert.equal(viaBearer.data.mode, 'demo');
    assert.equal(demoModeController.snapshot().mode, 'demo');
    assert.equal(process.env.DEMO_MODE, 'true');
  });

  await t.test('Demo -> Live on a server that is not Live-ready is refused by the controller, token or not', async () => {
    const anonymous = await post('live');
    assert.equal(anonymous.status, 409);
    assert.equal(anonymous.data.code, 'live_mode_unavailable');
    assert.deepEqual(anonymous.data.missing.sort(), ['X402_FACILITATOR_URL', 'X402_MODE=live', 'X402_PAY_TO']);
    assert.equal((await post('live', bearer(TOKEN))).status, 409);
  });

  await t.test('no-op requests and invalid modes need no token', async () => {
    assert.equal((await post('demo')).status, 200, 'already in demo: nothing to protect');
    const invalid = await post('chaos');
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.code, 'invalid_mode');
    assert.equal((await requestJson(app.base, 'POST', '/api/demo/mode', {})).status, 400);
  });

  await t.test('once Live is configured, entering Live is protected as well', async () => {
    Object.assign(process.env, LIVE_ENV);
    try {
      const anonymous = await post('live');
      assert.equal(anonymous.status, 401);
      assert.equal(demoModeController.snapshot().mode, 'demo');

      const authorised = await post('live', bearer(TOKEN));
      assert.equal(authorised.status, 200);
      assert.equal(authorised.data.mode, 'live');
      assert.equal(process.env.DEMO_MODE, 'false');
    } finally {
      // leave the controller in Live for the next steps; env stays configured
    }
  });

  await t.test('demo reset is unavailable in Live mode', async () => {
    const anonymous = await requestJson(app.base, 'POST', '/api/demo/reset');
    assert.equal(anonymous.status, 401, 'the admin token is checked first');
    const reset = await requestJson(app.base, 'POST', '/api/demo/reset', undefined, bearer(TOKEN));
    assert.equal(reset.status, 409);
    assert.equal(reset.data.code, 'demo_reset_live_forbidden');
  });

  await t.test('in Live the legacy upload needs the token, like POST /api/agent/ingest', async () => {
    const file = { name: 'bl.png', type: 'image/png', size: 68, content: 'iVBORw0KGgo=' };
    const anonymous = await requestJson(app.base, 'POST', '/api/ebl/upload', { case_id: 'CASE-LIVE-UPLOAD', file });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.data.code, 'admin_token_required');
    const metadataOnly = await requestJson(app.base, 'POST', '/api/ebl/upload', { file: { name: 'bl.pdf', type: 'application/pdf', size: 10 } });
    assert.equal(metadataOnly.status, 401, 'metadata-only uploads are not an exception');
  });

  await t.test('in Live the simulated subscription ledger is closed', async () => {
    const res = await requestJson(app.base, 'POST', '/api/pool/subscribe', { pool_id: 'CASE-EBL-2026-CU-SG-SHA', amount_usd: 100 });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'demo_only');
  });

  await t.test('without a configured (or with a too-short) token, leaving Live is impossible at runtime', async () => {
    delete process.env.AGENTBL_ADMIN_TOKEN;
    const unconfigured = await post('demo', bearer(TOKEN));
    assert.equal(unconfigured.status, 403);
    assert.equal(unconfigured.data.code, 'admin_token_not_configured');

    process.env.AGENTBL_ADMIN_TOKEN = 'short';
    const tooShort = await post('demo', bearer('short'));
    assert.equal(tooShort.status, 403, 'a token under 16 characters is not accepted as a secret');
    assert.equal(demoModeController.snapshot().mode, 'live');
  });

  t.after(() => {
    for (const name of Object.keys(LIVE_ENV)) delete process.env[name];
    delete process.env.AGENTBL_ADMIN_TOKEN;
    delete process.env.DEMO_MODE;
  });
});

test('a pure demo deployment (nothing Live configured) keeps the toggle open and harmless', async (t) => {
  const app = await listen(createServer());
  t.after(() => app.close());
  delete process.env.AGENTBL_ADMIN_TOKEN;
  for (const name of Object.keys(LIVE_ENV)) delete process.env[name];
  demoModeController.setMode('demo');

  const toLive = await requestJson(app.base, 'POST', '/api/demo/mode', { mode: 'live' });
  assert.equal(toLive.status, 409, 'cannot enter an unconfigured Live mode');
  const toDemo = await requestJson(app.base, 'POST', '/api/demo/mode', { mode: 'demo' });
  assert.equal(toDemo.status, 200);
  const reset = await requestJson(app.base, 'POST', '/api/demo/reset');
  assert.equal(reset.status, 200);
});

test('a Demo server with a configured admin token protects the shared reset', async (t) => {
  const app = await listen(createServer());
  t.after(() => { app.close(); delete process.env.AGENTBL_ADMIN_TOKEN; });
  for (const name of Object.keys(LIVE_ENV)) delete process.env[name];
  demoModeController.setMode('demo');
  process.env.AGENTBL_ADMIN_TOKEN = TOKEN;

  const anonymous = await requestJson(app.base, 'POST', '/api/demo/reset');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.data.code, 'admin_token_required');
  const authorised = await requestJson(app.base, 'POST', '/api/demo/reset', undefined, bearer(TOKEN));
  assert.equal(authorised.status, 200);
  const upload = await requestJson(app.base, 'POST', '/api/ebl/upload', { file: { name: 'bl.pdf', type: 'application/pdf', size: 10 } });
  assert.equal(upload.status, 200, 'Demo uploads stay open for zero-setup demos');
});
