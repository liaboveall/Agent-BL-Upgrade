// Shared plumbing for the free public data sources (src/realdata/*): one switch, one timeout, one cache.
//
//   REAL_DATA=off|on       default: on, except under `node --test` (NODE_TEST_CONTEXT) where it is off
//   REAL_DATA_TIMEOUT_MS   per request, default 6000
//
// Every fetcher returns plain data or throws; callers decide what the fallback is and label it.

const DEFAULT_TIMEOUT_MS = 6000;
const USER_AGENT = 'Mozilla/5.0 (compatible; AgentBL-demo/0.1; +https://github.com/liaboveall/Agent-BL-Upgrade)';

/** Whether the server may call the free public data sources. Tests never do unless REAL_DATA=on. */
export function realDataEnabled(env = process.env) {
  const flag = String(env.REAL_DATA ?? '').trim().toLowerCase();
  if (['off', '0', 'false', 'no'].includes(flag)) return false;
  if (['on', '1', 'true', 'yes'].includes(flag)) return true;
  // A test that hands in its own env object is still a test: check the process too.
  const underTest = Boolean(env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT) || env.NODE_ENV === 'test';
  return !underTest;
}

export function timeoutMs(env = process.env) {
  const value = Number(env.REAL_DATA_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 500 ? value : DEFAULT_TIMEOUT_MS;
}

/** GET a URL as text with a timeout. `fetchImpl` is the test seam. */
export async function fetchText(url, { env = process.env, fetchImpl = globalThis.fetch, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(env));
  try {
    const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: '*/*', ...headers }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('response was not JSON');
  }
}

/**
 * A small TTL cache that also remembers the last good value: when a refresh fails, callers get the old
 * value marked `stale` (up to `staleMs`) instead of nothing. Concurrent misses share one request.
 */
export class TtlCache {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.entries = new Map();
    this.pending = new Map();
  }

  async get(key, ttlMs, load, { staleMs = 24 * 3_600_000 } = {}) {
    const hit = this.entries.get(key);
    const time = this.now();
    if (hit && time - hit.at < ttlMs) return { value: hit.value, fetched_at: new Date(hit.at).toISOString(), stale: false };
    if (this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      try {
        const value = await load();
        const at = this.now();
        this.entries.set(key, { value, at });
        return { value, fetched_at: new Date(at).toISOString(), stale: false };
      } catch (error) {
        if (hit && time - hit.at < staleMs) return { value: hit.value, fetched_at: new Date(hit.at).toISOString(), stale: true, error: error.message };
        throw error;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, task);
    return task;
  }

  clear() {
    this.entries.clear();
    this.pending.clear();
  }
}

/** The process-wide cache the real-data sources share. */
export const sharedCache = new TtlCache();
