import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/app/server.js';
import { decodeBody, getRaw, listen, rawRequest, requestJson } from './helpers/http.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const distDir = path.resolve(publicDir, '../dist');

/** The JS/CSS files of the built frontend (empty before `npm run build`). */
function builtAssets() {
  const dir = path.join(distDir, 'assets');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /\.(?:js|css)$/u.test(name)).map((name) => `/assets/${name}`) : [];
}

test('HTTP hardening', async (t) => {
  const app = await listen(createServer());
  t.after(() => app.close());

  await t.test('a malformed request target answers 400 and never takes the process down', async () => {
    // "GET //" used to throw from new URL() outside the try/catch: an unhandled
    // rejection that killed the whole server with one packet.
    for (const target of ['//', '//evil.example/api/health', 'http://example.com/x', '*']) {
      const reply = await rawRequest(app.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      assert.match(reply.statusLine, /^HTTP\/1\.1 400 /u, `target ${target}: ${reply.statusLine || reply.error}`);
    }
    const health = await requestJson(app.base, 'GET', '/api/health');
    assert.equal(health.status, 200, 'server must still be alive');
  });

  await t.test('malformed percent-encoding is a 400, not a 500', async () => {
    for (const pathname of ['/api/x402/report/%E0%A4%A', '/api/mystery/%/proof', '/%zz']) {
      const res = await requestJson(app.base, 'GET', pathname);
      assert.equal(res.status, 400, pathname);
    }
  });

  await t.test('request bodies over the configured limit are rejected with 413', async () => {
    process.env.AGENTBL_MAX_BODY_BYTES = '2048';
    try {
      const res = await requestJson(app.base, 'POST', '/api/risk/analyze', JSON.stringify({ pad: 'x'.repeat(10_000) }));
      assert.equal(res.status, 413);
      assert.equal(res.data.code, 'payload_too_large');
      assert.equal(res.headers.get('connection'), 'close');
    } finally {
      delete process.env.AGENTBL_MAX_BODY_BYTES;
    }
  });

  await t.test('invalid JSON is a 400 with a stable error code', async () => {
    const res = await requestJson(app.base, 'POST', '/api/risk/analyze', '{not json');
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'invalid_json');
    assert.equal(res.data.ok, false);
  });

  await t.test('unknown API routes are a JSON 404 and non-GET static paths a 405', async () => {
    const unknown = await requestJson(app.base, 'GET', '/api/does-not-exist');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.data.code, 'not_found');

    const post = await requestJson(app.base, 'POST', '/chain-config.json', {});
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });

  await t.test('unexpected failures never leak internal error text', async () => {
    // An empty body on a route that dereferences it used to answer 500 with the raw TypeError message.
    const res = await requestJson(app.base, 'POST', '/api/pool/subscribe');
    assert.ok(res.status < 500);
    assert.ok(!/Cannot read properties|TypeError|at .*\.js/u.test(res.text));
  });

  await t.test('every response carries the baseline security headers; the dashboard also gets a CSP', async () => {
    const api = await getRaw(app.base, '/api/health');
    assert.equal(api.headers['x-content-type-options'], 'nosniff');
    assert.equal(api.headers['referrer-policy'], 'no-referrer');
    assert.equal(api.headers['x-frame-options'], 'DENY');
    assert.equal(api.headers['cache-control'], 'no-store');
    assert.match(api.headers['x-request-id'], /^[0-9a-f]{12}$/u);

    // 200 once the React frontend is built (dist/), 503 with the "not built" page before; both carry the CSP.
    const page = await getRaw(app.base, '/');
    assert.ok([200, 503].includes(page.status), `/ -> ${page.status}`);
    const csp = page.headers['content-security-policy'];
    assert.ok(csp, 'HTML must carry a Content-Security-Policy');
    assert.match(csp, /default-src 'self'/u);
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'(;|$)/u, 'scripts must be same-origin only (plus WebAssembly for the vendored Cosmos SDK)');
    assert.doesNotMatch(csp, /'unsafe-eval'/u, 'eval() must stay blocked');
    assert.doesNotMatch(csp.match(/script-src[^;]*/u)[0], /unsafe-inline/u);
    assert.match(csp, /frame-ancestors 'none'/u);
    assert.match(csp, /connect-src 'self'[^;]*https:\/\/k8s\.testnet\.json-rpc\.injective\.network/u);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');

    const script = await getRaw(app.base, '/vendor/ethers-6.17.0.min.js');
    assert.equal(script.status, 200);
    assert.equal(script.headers['content-security-policy'], undefined, 'CSP is only needed on HTML documents');
  });

  await t.test('the server-side LLM key is never sent to the browser', async () => {
    // Regression: server.js used to inject window.ENV = { DEEPSEEK_API_KEY } into every HTML page.
    const secrets = { DEEPSEEK_API_KEY: 'sk-unit-test-deepseek-SECRET', LLM_API_KEY: 'sk-unit-test-llm-SECRET', DASHSCOPE_API_KEY: 'sk-unit-test-qwen-SECRET' };
    Object.assign(process.env, secrets);
    try {
      for (const asset of ['/', '/chain-config.json', ...builtAssets()]) {
        const res = await getRaw(app.base, asset, { headers: { 'accept-encoding': 'identity' } });
        assert.ok(res.status === 200 || (asset === '/' && res.status === 503), `${asset} -> ${res.status}`);
        const text = decodeBody(res).toString('utf8');
        for (const secret of Object.values(secrets)) assert.ok(!text.includes(secret), `${asset} leaked ${secret}`);
      }
    } finally {
      for (const name of Object.keys(secrets)) delete process.env[name];
    }
  });

  await t.test('static files: ETag revalidation, per-type caching and HEAD', async () => {
    const first = await getRaw(app.base, '/chain-config.json');
    assert.equal(first.status, 200);
    assert.match(first.headers['content-type'], /^application\/json/u);
    assert.equal(first.headers['cache-control'], 'no-cache');
    assert.ok(first.headers.etag);

    const revalidated = await getRaw(app.base, '/chain-config.json', { headers: { 'if-none-match': first.headers.etag } });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body.length, 0);

    const head = await getRaw(app.base, '/favicon.svg', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.ok(Number(head.headers['content-length']) > 0);

    const image = fs.readdirSync(path.join(publicDir, 'img', 'cargo'))[0];
    const img = await getRaw(app.base, `/img/cargo/${image}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers['cache-control'], 'public, max-age=86400');
    assert.equal(img.headers['content-encoding'], undefined, 'images are already compressed');

    // Vite output has content-hashed names, so it can be cached forever.
    for (const asset of builtAssets().slice(0, 1)) {
      const built = await getRaw(app.base, asset);
      assert.equal(built.headers['cache-control'], 'public, max-age=31536000, immutable');
    }
  });

  await t.test('static text assets are served br/gzip-compressed and decode to the exact file bytes', async () => {
    const original = fs.readFileSync(path.join(publicDir, 'chain-config.json'));
    for (const encoding of ['br', 'gzip']) {
      const res = await getRaw(app.base, '/chain-config.json', { headers: { 'accept-encoding': encoding } });
      assert.equal(res.headers['content-encoding'], encoding);
      assert.equal(res.headers.vary, 'Accept-Encoding');
      assert.ok(res.body.length < original.length / 2, `${encoding} should shrink the chain config`);
      assert.deepEqual(decodeBody(res), original);
    }
    const identity = await getRaw(app.base, '/chain-config.json', { headers: { 'accept-encoding': 'identity' } });
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.deepEqual(identity.body, original);
  });

  await t.test('large JSON API responses are gzip-compressed on request', async () => {
    const res = await getRaw(app.base, '/api/cases', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    const parsed = JSON.parse(decodeBody(res).toString('utf8'));
    assert.equal(parsed.ok, true);
    assert.ok(parsed.count > 0);
  });

  await t.test('path traversal attempts never read files outside /public', async () => {
    const marker = '"agentbl-agent-starter"'; // the name field of the root package.json
    const attempts = [
      '/..%2f..%2fpackage.json',
      '/%2e%2e/%2e%2e/package.json',
      '/..%5c..%5cpackage.json',
      '/.%2e/package.json',
      '/img/..%2f..%2fpackage.json',
      '/%00',
      '/..%2f..%2f..%2f..%2f..%2f..%2fwindows%2fwin.ini',
      '/../package.json'
    ];
    for (const attempt of attempts) {
      const res = await getRaw(app.base, attempt);
      assert.ok([400, 403, 404].includes(res.status), `${attempt} -> ${res.status}`);
      assert.ok(!res.body.toString('utf8').includes(marker), `${attempt} exposed package.json`);
    }
  });

  await t.test('directories and missing files are 404s', async () => {
    for (const pathname of ['/img/', '/img', '/nope.js', '/vendor/missing.js']) {
      const res = await getRaw(app.base, pathname);
      assert.equal(res.status, 404, pathname);
    }
  });
});
