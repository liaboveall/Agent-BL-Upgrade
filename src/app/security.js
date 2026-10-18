// Cross-cutting security controls for the HTTP server: response headers + CSP,
// a small in-memory rate limiter, and admin-token verification.
import crypto from 'node:crypto';

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
