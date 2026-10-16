import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { listenOnUsablePort } from '../scripts/lib/listen.mjs';
import { handleRequest } from '../src/app/server.js';
import { resetStore, storeState, subscribeToPool } from '../src/app/store.js';

// WP0.1 — nothing simulated may look real. A simulated result carries mode:'demo' and a `demo:`
// reference; a 0x transaction hash, an explorer link or an "autonomous agent" claim must only ever
// come from something that actually happened (docs/agent-implementation-plan.md §2.2 principle 2).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      out.push(...await sourceFiles(full));
    } else if (/\.(?:js|mjs|jsx)$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = [...await sourceFiles(path.join(root, 'src')), ...await sourceFiles(path.join(root, 'web', 'src')), ...await sourceFiles(path.join(root, 'public'))];
const sources = new Map();
for (const file of files) sources.set(path.relative(root, file).replaceAll('\\', '/'), await fs.readFile(file, 'utf8'));

test('WP0.1: no source builds a hex hash out of Math.random()', () => {
  const offenders = [];
  for (const [file, text] of sources) {
    const lines = text.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (!line.includes('Math.random')) return;
      // Look at the statement around the call: a hex digit generator or a 0x prefix is a fake hash.
      const window = lines.slice(Math.max(0, index - 2), index + 3).join('\n');
      if (/toString\(16\)|['"`]0x['"`]|0x\$\{/u.test(window)) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('WP0.1: randomBytes(32) is only used for real secrets (Mystery fairness)', () => {
  const allowed = new Set(['src/mystery/fairness.js']);
  const offenders = [...sources]
    .filter(([file, text]) => /randomBytes\(\s*32\s*\)/u.test(text) && !allowed.has(file))
    .map(([file]) => file);
  assert.deepEqual(offenders, [], 'a random 32-byte value looks exactly like a transaction hash');
});

test('WP0.1: no source claims behaviour that does not exist', () => {
  const forbidden = [
    [/每\s*5\s*分钟巡检/u, 'claims a 5-minute patrol process'],
    [/Cross-checked with OFAC/iu, 'claims an OFAC lookup'],
    [/Cleared EAR99/iu, 'claims an export classification'],
    [/合约将自动兑付/u, 'claims the contract pays out automatically'],
    [/认购成功/u, 'calls a simulated subscription a success'],
    [/YOUR wallet/u, 'claims a simulated payment came from the user wallet'],
    [/logX402PaymentOnChain/u, 'calls a PaymentOracle method that does not exist in v2'],
    [/initSampleAgentActivities/u, 'seeds fake agent activity'],
    [/injective_testnet_mock/u, 'labels the mock ENI as an Injective network']
  ];
  const offenders = [];
  for (const [file, text] of sources) {
    for (const [pattern, why] of forbidden) {
      if (pattern.test(text)) offenders.push(`${file}: ${why}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('WP0.1: the browser never builds an explorer link by itself', () => {
  // Explorer links must come from a real result (explorerUrl from the chain layer), so a
  // simulated hash cannot be turned into one by string concatenation in the page.
  const offenders = [];
  for (const [file, text] of sources) {
    if (!file.startsWith('public/') && !file.startsWith('web/')) continue;
    if (/blockscout[^\n]*\/tx\/\$\{/u.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('WP0.1: the Demo wallet x402 flow no longer shows a link or a "your wallet" claim', () => {
  const x402 = sources.get('web/src/pages/deal/x402.js');
  const start = x402.indexOf('async function purchaseWithWalletDemo(');
  const end = x402.indexOf('async function purchaseWithWalletLive(');
  assert.ok(start > 0 && end > start);
  const demoFlow = x402.slice(start, end);
  assert.doesNotMatch(demoFlow, /View on Injective Explorer/u);
  assert.doesNotMatch(demoFlow, /tx from YOUR wallet/iu);
  assert.doesNotMatch(demoFlow, /explorerUrl/u);
  assert.match(demoFlow, /x402_demo_receipt_note/u);
});

test('WP0.1: a simulated mint has no hash-shaped placeholder', () => {
  const web3 = sources.get('web/src/lib/web3.js');
  const start = web3.indexOf('export async function simulatedMint');
  const body = web3.slice(start, web3.indexOf('\n}', start));
  assert.doesNotMatch(body, /0x['"` ]*\+/u);
  assert.match(body, /txHash: tx\.tx_hash \?\? null/u);
});

test('WP0.1: a Demo subscription gets a demo: reference and no transaction hash', () => {
  resetStore();
  const first = (poolId, amount) => subscribeToPool('0xabc', poolId, amount);
  storeState.pools.set('P', { poolId: 'P', status: 'Open', subscribedUsd: 0, targetUsd: 1e6, quote: { final_issue_price_usd: 0.8, implied_gross_yield_bps: 500, risk_level: 'LOW' }, caseData: {} });
  const a = first('P', 1000);
  const b = first('P', 1000);
  for (const result of [a, b]) {
    assert.equal(result.mode, 'demo');
    assert.equal(result.txHash, null);
    assert.match(result.reference, /^demo:sub:[0-9a-f]{16}$/u);
    assert.equal(result.investment.mode, 'demo');
    assert.doesNotMatch(JSON.stringify(result), /0x[0-9a-fA-F]{64}/u);
  }
  assert.notEqual(a.reference, b.reference, 'two identical subscriptions are still distinct records');
  resetStore();
});

test('WP0.1: /api/x402/smoke labels every step as a Demo simulation', async () => {
  const server = http.createServer(handleRequest);
  const port = await listenOnUsablePort(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/x402/smoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.steps.length >= 4);
    for (const step of body.steps) {
      assert.equal(step.mode, 'demo', `step ${step.action} must be marked as a demo`);
    }
    const text = body.steps.map((step) => step.detail).join(' ');
    assert.doesNotMatch(text, /White Agent|Facilitator settled/u);
    assert.match(text, /simulated/iu);
    assert.equal(body.payment.live, false);
    assert.equal(body.payment.onchain, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---- the floating assistant reads the server instead of inventing records ----

const { toolExecutors } = await import('../web/src/lib/assistant-tools.js');

function stubFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = String(url).split('?')[0];
    if (!(key in routes)) throw new Error(`unexpected fetch ${key}`);
    const body = routes[key];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = original; };
}

test('WP0.1: with no activity the assistant says so instead of inventing decisions', async () => {
  const restore = stubFetch({ '/api/agent/activity': { ok: true, activities: [], count: 0 } });
  try {
    const text = await toolExecutors.getAgentActivity({});
    assert.match(text, /暂无决策记录/u);
    assert.doesNotMatch(text, /0x[0-9a-f]{16}/iu);
    assert.doesNotMatch(text, /OPEN_OFFERING|REPRICE_DOWN|MONITORING|巡检/u);
  } finally {
    restore();
  }
});

test('WP0.1: the assistant only shows a transaction when the server recorded one', async () => {
  const realHash = `0x${'ab'.repeat(32)}`;
  const restore = stubFetch({
    '/api/agent/activity': {
      ok: true,
      count: 2,
      activities: [
        { id: 'a1', timestamp: '2026-10-12T00:00:00.000Z', type: 'INVESTMENT', action: 'SUBSCRIPTION', caseId: 'C1', details: { amountUsd: 10 } },
        { id: 'a2', timestamp: '2026-10-12T00:01:00.000Z', type: 'PRICING', action: 'REPRICE', caseId: 'C1', tx_hash: realHash, details: {} }
      ]
    }
  });
  try {
    const text = await toolExecutors.getAgentActivity({ limit: 5 });
    assert.match(text, /SUBSCRIPTION/u);
    assert.equal(text.split(realHash).length - 1, 1, 'exactly the one recorded hash appears');
    assert.equal((text.match(/0x[0-9a-f]{64}/giu) ?? []).length, 1);
  } finally {
    restore();
  }
});

test('WP0.1: the assistant portfolio comes from the server and labels subscriptions as Demo', async () => {
  const restore = stubFetch({
    '/api/investors/portfolio': {
      ok: true,
      investments: [{ label: 'Copper', amountUsd: 1000, tokenCount: 1250, price: 0.8, yieldBps: 600, riskLevel: 'WARNING', timestamp: 't', reference: 'demo:sub:0123456789abcdef', mode: 'demo' }],
      summary: { totalInvestedUsd: 1000, avgYieldBps: 600 }
    }
  });
  try {
    const text = await toolExecutors.getPortfolio();
    assert.match(text, /demo:sub:0123456789abcdef/u);
    assert.match(text, /Demo 模拟/u);
    assert.match(text, /🟠/u, 'WARNING renders with the high-risk marker');
  } finally {
    restore();
  }
});
