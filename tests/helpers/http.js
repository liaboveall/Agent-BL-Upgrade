// Shared helpers for HTTP-level tests. Lives outside tests/*.test.js so the
// node test runner does not treat it as a test file.
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { listenOnUsablePort } from '../../scripts/lib/listen.mjs';

/** Start an http.Server on a random loopback port that fetch accepts; `close()` also drops keep-alive/SSE sockets. */
export async function listen(server) {
  const port = await listenOnUsablePort(server, '127.0.0.1');
  return {
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })
  };
}

/** Send raw bytes over TCP and return the response head + body text (for malformed-request tests). */
export function rawRequest(port, payload, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let received = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    socket.on('data', (chunk) => { received += chunk; });
    socket.on('error', (error) => resolve({ error: error.code, statusLine: '', text: received }));
    socket.on('close', () => resolve({ statusLine: received.split('\r\n')[0], text: received }));
    setTimeout(() => socket.destroy(), timeoutMs).unref();
  });
}

/**
 * GET without transparent decompression so tests can inspect Content-Encoding
 * and the exact bytes on the wire.
 */
export function getRaw(base, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}${pathname}`, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: response.statusCode, headers: response.headers, body });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

/** Decode a getRaw() body according to its Content-Encoding. */
export function decodeBody({ headers, body }) {
  switch (headers['content-encoding']) {
    case 'gzip': return zlib.gunzipSync(body);
    case 'br': return zlib.brotliDecompressSync(body);
    default: return body;
  }
}

/** JSON request helper returning { status, headers, data } (data is null for non-JSON bodies). */
export async function requestJson(base, method, pathname, body, headers = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, data, text };
}

/** Forget any LLM provider env vars so a developer's real .env cannot leak into a test. */
export function clearLlmEnv(env = process.env) {
  for (const name of [
    'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT',
    'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_PROVIDER', 'LLM_PROXY_ENABLED', 'LLM_PROXY_MAX_CONCURRENCY',
    'LLM_MAX_TOKENS_CAP', 'LLM_REASONING_EFFORT',
    'Tencent_API_KEY', 'Tencent_BASE_URL', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL',
    'Ali_API_KEY', 'Ali_BASE_URL', 'OPENAI_API_KEY'
  ]) delete env[name];
}
