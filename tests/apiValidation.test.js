import { listenOnUsablePort } from '../scripts/lib/listen.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from '../src/app/server.js';

// BE-7: the AI-pricing endpoints must reject malformed input with HTTP 400 and a
// structured { ok:false, details:[...] } body — never a 500 or a silent bad quote.

const copperCase = JSON.parse(
  await fs.readFile(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url), 'utf8')
);

/** Start a throwaway server and run `fn(baseUrl)`, always closing it after. */
async function withServer(fn) {
  const server = createServer();
  await listenOnUsablePort(server);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const postJson = (baseUrl, pathname, payload) =>
  fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

test('BE-7: invalid payout_speed is rejected with 400', async () => {
  await withServer(async (baseUrl) => {
    const res = await postJson(baseUrl, '/api/pricing/quote', { payout_speed: 'INSTANT' });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.details.some((d) => d.includes('payout_speed')));
  });
});

test('BE-7: a non-positive requested_cash_usd is rejected (price/amount not valid)', async () => {
  await withServer(async (baseUrl) => {
    for (const bad of [0, -5000, 'lots']) {
      const res = await postJson(baseUrl, '/api/pricing/quote', { requested_cash_usd: bad });
      const body = await res.json();
      assert.equal(res.status, 400, `requested_cash_usd=${bad}`);
      assert.ok(body.details.some((d) => d.includes('requested_cash_usd')));
    }
  });
});

test('BE-7: a negative subscription_usd is rejected on /api/offering/simulate', async () => {
  await withServer(async (baseUrl) => {
    const res = await postJson(baseUrl, '/api/offering/simulate', { subscription_usd: -1 });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.ok(body.details.some((d) => d.includes('subscription_usd')));
  });
});

test('BE-7: a case whose target redemption is not 1.00 is rejected (exceeds the fixed target)', async () => {
  await withServer(async (baseUrl) => {
    const tampered = structuredClone(copperCase);
    tampered.financing.target_redemption_value_usd = 2; // would over-promise vs collateral
    const res = await postJson(baseUrl, '/api/pricing/quote', tampered);
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.ok(body.details.some((d) => d.includes('target_redemption_value_usd')));
  });
});

test('BE-7: events must be an array', async () => {
  await withServer(async (baseUrl) => {
    const res = await postJson(baseUrl, '/api/offering/simulate', { events: 'typhoon' });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.ok(body.details.some((d) => d.includes('events')));
  });
});

test('BE-7: a well-formed override still succeeds (validation is not over-eager)', async () => {
  await withServer(async (baseUrl) => {
    const res = await postJson(baseUrl, '/api/pricing/quote', { payout_speed: 'FAST', requested_cash_usd: 3_000_000 });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.final_issue_price_usd > 0 && body.final_issue_price_usd <= 1);
  });
});

test('retired Oracle tool cannot be invoked with any supplied commitment', async () => {
  await withServer(async (baseUrl) => {
    const quoteResponse = await postJson(baseUrl, '/api/pricing/quote', { payout_speed: 'FAST' });
    const quote = await quoteResponse.json();
    const malformed = { ...quote, evidence_hash: `${quote.evidence_hash}7` };

    const res = await postJson(baseUrl, '/api/mcp/call', {
      tool: 'push_pricing_to_oracle',
      params: { case_id: quote.case_id, pricing_quote: malformed }
    });
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /Unknown tool/u);
    assert.ok(!body.error.includes('confirmed'));
  });
});

test('BE-7: an invalid min_acceptable_issue_price is rejected instead of silently ignored', async () => {
  await withServer(async (baseUrl) => {
    for (const value of ['abc', '-5']) {
      const res = await fetch(`${baseUrl}/api/pricing/quote?min_acceptable_issue_price=${value}`, { method: 'POST' });
      const body = await res.json();
      assert.equal(res.status, 400, value);
      assert.ok(body.details.some((d) => d.includes('min_acceptable_issue_price')));
    }
    assert.equal((await fetch(`${baseUrl}/api/pricing/quote?min_acceptable_issue_price=0.95`, { method: 'POST' })).status, 200);
  });
});

test('a caller-supplied case analysed by world-risk never writes its id or price into the public feed', async () => {
  await withServer(async (baseUrl) => {
    const spoofed = { ...copperCase, case_id: 'CALLER-SUPPLIED-CASE' };
    assert.equal((await postJson(baseUrl, '/api/intel/world-risk', spoofed)).status, 200);
    assert.equal((await postJson(baseUrl, '/api/intel/world-risk', { case: spoofed })).status, 200);
    const feed = await (await fetch(`${baseUrl}/api/agent/activity?case_id=CALLER-SUPPLIED-CASE`)).json();
    assert.equal(feed.count, 0);
  });
});

test('legacy capital-layer intent routes point to the controlled workflow when no pool is configured', async () => {
  await withServer(async (baseUrl) => {
    for (const route of ['/api/positions/subscription-intents', '/api/positions/claim-intents', `/api/positions/subscription-intents/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/transaction`]) {
      const res = await postJson(baseUrl, route, {});
      assert.equal(res.status, 404, route);
      assert.equal((await res.json()).code, 'legacy_capital_unconfigured');
    }
  });
});

test('the market references list its pools on the very first request after a start', async () => {
  const { resetStore } = await import('../src/app/store.js');
  resetStore();
  await withServer(async (baseUrl) => {
    const references = await (await fetch(`${baseUrl}/api/agent/references`)).json();
    assert.ok(references.pools.length >= 10);
    assert.ok(references.pools.every((pool) => pool.quote && typeof pool.quote.final_issue_price_usd === 'number'));
  });
});
