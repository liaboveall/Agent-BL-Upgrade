import { createAgentApi, AGENT_API_OPERATIONS } from '../agent/api.js';
import { HttpError, clientIp, configuredBodyLimit, readJsonBody, sendJson } from './http.js';
import { createRateLimiter, envInt } from './security.js';

export function createAgentApiRoutes({ env = process.env, run = createAgentApi({ env }) } = {}) {
  const limiter = createRateLimiter({ max: envInt(env, 'AGENT_API_RATE_LIMIT_PER_MIN', 30) });
  const maxConcurrent = Math.min(64, Math.max(1, envInt(env, 'AGENT_API_MAX_CONCURRENCY', 4)));
  const paths = new Map(AGENT_API_OPERATIONS.map((name) => [`/api/agent/${name}`, name]));
  let active = 0;
  return async (request, response, url) => {
    const operation = paths.get(url.pathname);
    if (!operation) return false;
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'This Agent API accepts POST only');
    const budget = limiter.take(clientIp(request, env));
    if (limiter.max > 0 && !budget.allowed) {
      response.setHeader('Retry-After', String(budget.retryAfterSeconds));
      throw new HttpError(429, 'agent_api_rate_limited', 'Agent API request budget exceeded');
    }
    if (active >= maxConcurrent) {
      response.setHeader('Retry-After', '1');
      throw new HttpError(429, 'agent_api_busy', 'Too many concurrent Agent API requests');
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(String(request.headers['content-type'] ?? ''))) {
      throw new HttpError(415, 'json_required', 'Content-Type must be application/json');
    }
    active += 1;
    try {
      const body = await readJsonBody(request, { limit: configuredBodyLimit(env) });
      sendJson(response, 200, { ok: true, ...(await run(operation, body)) });
    } finally {
      active -= 1;
    }
    return true;
  };
}
