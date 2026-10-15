import crypto from 'node:crypto';
import { z } from 'zod';
import { delegatePricingJsonSchema } from '../interop/delegation.js';
import { A2A_VERSION, createAgentCard } from '../interop/agentCard.js';
import { checkedInterop, publicOrigin } from '../interop/validation.js';
import { discoveryCatalog } from '../x402/discovery.js';
import { clientIp, configuredBodyLimit, describeError, HttpError, readJsonBody, sendJson } from './http.js';
import { createRateLimiter, envInt } from './security.js';

const rpcEnvelope = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number().finite()]),
  method: z.string().min(1).max(128), params: z.unknown().optional() }).strict();
const label = z.string().min(1).max(128);
const sendMessage = z.object({
  message: z.object({ messageId: label, contextId: label.optional(), role: z.literal('ROLE_USER'),
    parts: z.array(z.object({ data: z.record(z.string(), z.unknown()), mediaType: z.literal('application/json').optional() }).strict()).length(1)
  }).strict(),
  configuration: z.object({ acceptedOutputModes: z.array(z.string()).min(1).max(10).optional(),
    returnImmediately: z.boolean().optional(), historyLength: z.number().int().min(0).optional() }).strict().optional()
}).strict();
const catalogQuery = z.object({ type: z.enum(['http', 'mcp']).default('http'),
  limit: z.coerce.number().int().min(1).max(100).default(100), offset: z.coerce.number().int().min(0).max(1_000_000).default(0) }).strict();
const CARD_PATHS = new Set(['/.well-known/agent-card.json', '/.well-known/agent.json']);
const DISCOVERY_PATHS = new Set(['/api/x402/discovery', '/discovery/resources']);

export function createInteropRoutes({ context, runtimeMode, env = process.env }) {
  const limiter = createRateLimiter({ max: envInt(env, 'AGENT_API_RATE_LIMIT_PER_MIN', 30) });
  return async (request, response, url) => {
    const path = url.pathname;
    const mode = runtimeMode().mode;
    if (CARD_PATHS.has(path) || DISCOVERY_PATHS.has(path) || path === '/api/interop/schemas/delegate-pricing') {
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'method_not_allowed', 'Discovery accepts GET or HEAD');
      const origin = publicOrigin(request, env);
      response.setHeader('Cache-Control', 'no-store');
      let result;
      if (CARD_PATHS.has(path)) result = createAgentCard({ origin, env, mode });
      else if (DISCOVERY_PATHS.has(path)) result = discoveryCatalog({ origin, env, mode,
        ...checkedInterop(catalogQuery, Object.fromEntries(url.searchParams)) });
      else result = { ...delegatePricingJsonSchema,
        description: 'Supply exactly one of case_id or case_data. paid_report_ids must identify unexpired reports previously delivered by this server. Quotation is free and never executes payments or protocol actions.' };
      if (request.method === 'HEAD') { response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(); }
      else sendJson(response, 200, result);
      return true;
    }
    if (!['/api/a2a', '/api/agent/delegate-pricing'].includes(path)) return false;
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Delegation accepts POST');
    const taken = limiter.take(clientIp(request, env));
    if (limiter.max > 0 && !taken.allowed) {
      response.setHeader('Retry-After', String(taken.retryAfterSeconds));
      throw new HttpError(429, 'interop_rate_limited', 'Interoperability request budget exceeded');
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(String(request.headers['content-type'] ?? ''))) {
      throw new HttpError(415, 'json_required', 'Content-Type must be application/json');
    }
    if (path !== '/api/a2a') {
      const input = await readJsonBody(request, { limit: Math.min(configuredBodyLimit(env), 1_048_576) });
      sendJson(response, 200, { ok: true, ...await context.delegate(input) });
      return true;
    }
    response.setHeader('A2A-Version', A2A_VERSION);
    let id = null;
    let code = -32600;
    try {
      let input;
      try { input = await readJsonBody(request, { limit: Math.min(configuredBodyLimit(env), 1_048_576) }); }
      catch (error) { code = error.code === 'invalid_json' ? -32700 : -32600; throw error; }
      // Preserve an otherwise valid request id even when the rest of the envelope is malformed.
      if (typeof input?.id === 'string' || typeof input?.id === 'number' && Number.isFinite(input.id)) id = input.id;
      const rpc = checkedInterop(rpcEnvelope, input);
      id = rpc.id;
      if (request.headers['a2a-version'] !== A2A_VERSION) {
        code = -32009;
        throw new HttpError(400, 'version_not_supported', 'Send A2A-Version: 1.0; an omitted version denotes legacy 0.3, which this interface does not support');
      }
      if (rpc.method !== 'SendMessage') { code = -32601; throw new HttpError(400, 'method_not_found', 'This synchronous interface supports SendMessage'); }
      code = -32602;
      const params = checkedInterop(sendMessage, rpc.params);
      if (params.configuration?.acceptedOutputModes && !params.configuration.acceptedOutputModes.includes('application/json')) {
        code = -32005;
        throw new HttpError(400, 'content_type_not_supported', 'This skill returns application/json');
      }
      const priced = await context.delegate(params.message.parts[0].data);
      sendJson(response, 200, { jsonrpc: '2.0', id, result: { message: {
        messageId: crypto.randomUUID(), contextId: params.message.contextId ?? crypto.randomUUID(),
        role: 'ROLE_AGENT', parts: [{ data: priced, mediaType: 'application/json' }]
      } } });
    } catch (error) {
      const mapped = describeError(error);
      if (mapped.status >= 500) code = -32603;
      sendJson(response, mapped.status === 413 || mapped.status === 429 ? mapped.status : 200,
        { jsonrpc: '2.0', id, error: { code, message: mapped.message, data: { code: mapped.code, ...(mapped.details ? { issues: mapped.details } : {}) } } });
    }
    return true;
  };
}
