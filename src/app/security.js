// Cross-cutting security controls for the HTTP server: response headers + CSP,
// a small in-memory rate limiter, and admin-token verification.
import crypto from 'node:crypto';
import { HttpError, trustedHops } from './http.js';

// RPC hosts the browser wallet flow talks to that are not (yet) in application-config.json.
const BUILTIN_CONNECT_ORIGINS = Object.freeze([
  'https://k8s.testnet.json-rpc.injective.network',
  'https://testnet.sentry.chain.json-rpc.injective.network'
]);

function originOf(value) {
  try {
    const { origin } = new URL(String(value));
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Collect every origin the page may legitimately call, from application-config.json. */
export function connectOriginsFromChainConfig(registry) {
  const origins = new Set(BUILTIN_CONNECT_ORIGINS);
  for (const network of Object.values(registry?.networks ?? {})) {
    for (const candidate of [
      ...(network.rpcUrls ?? []),
      ...(network.wsUrls ?? []),
      network.cosmosRpcUrl,
      network.explorerApi,
      network.explorerBase
    ]) {
      const origin = originOf(candidate);
      if (origin) origins.add(origin);
    }
  }
  return [...origins].sort();
}

/**
 * Content-Security-Policy for the dashboard. Scripts are same-origin only
 * (ethers/cosmjs are vendored under /vendor); inline *styles* stay allowed
 * because the UI renders style="" attributes and one injected <style> block.
 *
 * 'wasm-unsafe-eval' lets the vendored Cosmos SDK instantiate its libsodium
 * WebAssembly module. Unlike 'unsafe-eval' it does NOT permit eval()/new Function.
 */
export function buildContentSecurityPolicy({ connectSrc = [] } = {}) {
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...connectSrc],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"]
  };
  return Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/** Headers every response carries. API responses are additionally never cached. */
export function applySecurityHeaders(response, { isApi = false } = {}) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  // same-origin-allow-popups keeps wallet / WalletConnect popups working.
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (isApi) response.setHeader('Cache-Control', 'no-store');
}

/**
 * Fixed-window counter per key. Memory is bounded: expired windows are swept
 * lazily and the table never grows past `maxKeys`.
 */
export function createRateLimiter({ windowMs = 60_000, max = 60, maxKeys = 10_000, now = () => Date.now() } = {}) {
  const windows = new Map();
  let lastSweep = now();

  function sweep(timestamp) {
    if (timestamp - lastSweep < windowMs && windows.size <= maxKeys) return;
    lastSweep = timestamp;
    for (const [key, entry] of windows) if (entry.resetAt <= timestamp) windows.delete(key);
    // Still over capacity (many distinct live keys): drop the oldest windows.
    for (const key of windows.keys()) {
      if (windows.size <= maxKeys) break;
      windows.delete(key);
    }
  }

  return {
    max,
    take(key) {
      const timestamp = now();
      sweep(timestamp);
      let entry = windows.get(key);
      if (!entry || entry.resetAt <= timestamp) {
        entry = { count: 0, resetAt: timestamp + windowMs };
        windows.set(key, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= max,
        limit: max,
        remaining: Math.max(0, max - entry.count),
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000))
      };
    },
    reset() { windows.clear(); },
    get size() { return windows.size; }
  };
}

/** Positive-integer env knob with a default; 0 or invalid values fall back. */
export function envInt(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export const MIN_ADMIN_TOKEN_LENGTH = 16;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function suppliedAdminToken(request) {
  const authorization = request.headers?.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
    if (match) return match[1];
  }
  const header = request.headers?.['x-admin-token'];
  return typeof header === 'string' ? header : '';
}

/**
 * Verify the AGENTBL_ADMIN_TOKEN. `configured` is false when the variable is
 * unset or too short to be a real secret, so callers can fail closed.
 */
export function checkAdminToken(request, env = process.env) {
  const expected = String(env.AGENTBL_ADMIN_TOKEN ?? '').trim();
  if (expected.length < MIN_ADMIN_TOKEN_LENGTH) return { configured: false, authorized: false };
  const supplied = suppliedAdminToken(request);
  const authorized = supplied !== '' && crypto.timingSafeEqual(digest(supplied), digest(expected));
  return { configured: true, authorized };
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '[::1]']);
const isLoopbackHostname = (name) => LOOPBACK_HOSTNAMES.has(name) || /^127(?:\.\d{1,3}){3}$/u.test(name);
const isLoopbackAddress = (address) => {
  const value = String(address ?? '').replace(/^::ffff:/iu, '');
  return value === '::1' || value.startsWith('127.');
};
function hostnameOf(header) {
  const value = String(header ?? '').trim().toLowerCase();
  return value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0];
}

/**
 * DNS rebinding: another site can point its own hostname at 127.0.0.1 and then call this API from the
 * visitor's browser as if it were same-origin. A request that arrives over loopback must therefore name
 * a loopback host. Operators who serve other names list them in AGENTBL_ALLOWED_HOSTS (enforced on every
 * interface once set); behind a declared reverse proxy (TRUST_PROXY) the proxy owns the Host check.
 */
export function assertAllowedHost(request, env = process.env) {
  const name = hostnameOf(request.headers?.host);
  if (name === '' || isLoopbackHostname(name)) return;
  const allowed = String(env.AGENTBL_ALLOWED_HOSTS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (allowed.length > 0) {
    if (allowed.includes(name)) return;
  } else if (trustedHops(env.TRUST_PROXY) > 0 || !isLoopbackAddress(request.socket?.localAddress)) {
    return;
  }
  throw new HttpError(421, 'host_not_allowed', 'This server does not answer for that host name; add it to AGENTBL_ALLOWED_HOSTS');
}

/**
 * Browsers label a request another site started (Sec-Fetch-Site: cross-site). No route here is meant
 * to be written to from another site's page, so those writes are refused before any handler runs.
 */
export function assertNotCrossSiteWrite(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  if (String(request.headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    throw new HttpError(403, 'cross_site_request', 'Requests started by another site cannot change state here');
  }
}
