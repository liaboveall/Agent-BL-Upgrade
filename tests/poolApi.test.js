import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { handleRequest } from '../src/app/server.js';
import { resetStore, storeState } from '../src/app/store.js';

function request(method, path, body = null) {
  return new Promise((resolve) => {
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: 8081,
      path,
      headers: body ? { 'Content-Type': 'application/json' } : {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

test('BE-12: Pool API Tests', async (t) => {
  // Start server
  const server = http.createServer(handleRequest);
  await new Promise(res => server.listen(8081, res));

  try {
    resetStore();

    // First ensure pools are loaded by calling market/listings
    await request('GET', '/api/market/listings');
    const firstPoolId = Array.from(storeState.pools.keys())[0];

    await t.test('POST /api/pool/subscribe works for valid amount', async () => {
      const res = await request('POST', '/api/pool/subscribe', {
        wallet_address: '0xTest',
        pool_id: firstPoolId,
        amount_usd: 1000
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.ok, true);
      // A mock subscription has no transaction: a demo reference, never a 0x hash.
      assert.strictEqual(res.data.mode, 'demo');
      assert.match(res.data.reference, /^demo:sub:[0-9a-f]{16}$/u);
      assert.strictEqual(res.data.txHash, null);
      assert.strictEqual(res.data.investment.reference, res.data.reference);
      assert.doesNotMatch(JSON.stringify(res.data), /0x[0-9a-fA-F]{64}/u);
      assert.strictEqual(res.data.investment.amountUsd, 1000);
    });

    await t.test('GET /api/pool/status returns correct subscription state', async () => {
      const res = await request('GET', `/api/pool/status?pool_id=${firstPoolId}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.ok, true);
      assert.strictEqual(res.data.subscribedUsd, 1000);
    });

    await t.test('POST /api/pool/subscribe rejects over-subscription', async () => {
      const pool = storeState.pools.get(firstPoolId);
      const remaining = pool.targetUsd - pool.subscribedUsd;
      
      const res = await request('POST', '/api/pool/subscribe', {
        wallet_address: '0xTest',
        pool_id: firstPoolId,
        amount_usd: remaining + 1000 // Exceed target
      });
      // A business-rule conflict, not a server fault: 409, not 500.
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.data.ok, false);
      assert.strictEqual(res.data.code, 'subscription_exceeds_target');
      assert.ok(res.data.error.includes('Subscription exceeds target amount'));
    });

    await t.test('POST /api/pool/subscribe rejects missing, non-numeric and non-finite amounts without corrupting the pool', async () => {
      const before = storeState.pools.get(firstPoolId).subscribedUsd;
      const bad = [
        {},                                  // amount_usd missing used to turn subscribedUsd into NaN
        { amount_usd: '100' },               // numeric string used to be string-concatenated
        { amount_usd: null },
        { amount_usd: -5 },
        { amount_usd: 0 },
        { amount_usd: Number.POSITIVE_INFINITY }, // serialises to null -> must still be rejected
        { amount_usd: [5] }
      ];
      for (const extra of bad) {
        const res = await request('POST', '/api/pool/subscribe', { wallet_address: '0xTest', pool_id: firstPoolId, ...extra });
        assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(extra)}`);
        assert.strictEqual(res.data.ok, false);
      }
      const after = storeState.pools.get(firstPoolId).subscribedUsd;
      assert.strictEqual(typeof after, 'number');
      assert.strictEqual(after, before, 'pool total must be untouched by rejected requests');
    });

    await t.test('POST /api/pool/subscribe validates the request envelope', async () => {
      const empty = await request('POST', '/api/pool/subscribe');
      assert.strictEqual(empty.status, 400);
      assert.strictEqual(empty.data.ok, false);
      assert.ok(!/Cannot read properties/u.test(empty.data.error), 'internal error text must not leak');

      const noPool = await request('POST', '/api/pool/subscribe', { amount_usd: 10 });
      assert.strictEqual(noPool.status, 400);

      const unknown = await request('POST', '/api/pool/subscribe', { pool_id: 'NO-SUCH-POOL', amount_usd: 10 });
      assert.strictEqual(unknown.status, 404);
      assert.strictEqual(unknown.data.code, 'pool_not_found');
    });

    await t.test('POST /api/pool/subscribe refuses wallet strings that could carry markup', async () => {
      for (const wallet of ['<img src=x onerror=alert(1)>', '0x<script>', 'javascript:alert(1)', '0x' + 'a'.repeat(65), 42, '']) {
        const res = await request('POST', '/api/pool/subscribe', { wallet_address: wallet, pool_id: firstPoolId, amount_usd: 1 });
        assert.strictEqual(res.status, 400, `wallet ${JSON.stringify(wallet)}`);
        assert.strictEqual(res.data.code, 'invalid_wallet');
      }
      const ok = await request('POST', '/api/pool/subscribe', { wallet_address: '0xAbC123', pool_id: firstPoolId, amount_usd: 1 });
      assert.strictEqual(ok.status, 200);
    });

    await t.test('GET /api/pool/status answers 404 for an unknown pool', async () => {
      const res = await request('GET', '/api/pool/status?pool_id=NO-SUCH-POOL');
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.data.ok, false);
    });
  } finally {
    server.close();
  }
});
