// HTTP routes of the agent runtime (docs/agent-implementation-plan.md §4.6). They are thin on purpose:
// parse, authorise, call the AgentService, shape the reply. The older /api/agent/activity routes stay
// in server.js because they share the SSE plumbing there.
//
// Authorisation: reads of decisions, traces and status are public (nothing in them is secret). Anything
// that changes state, and the approval queue itself, needs the admin token -- except that in Demo mode,
// when no admin token is configured at all, they are open so the Demo works with zero setup.

import { checkAdminToken, MIN_ADMIN_TOKEN_LENGTH } from './security.js';
import { HttpError, readJsonBody, sendJson } from './http.js';
import { createChainReader } from '../agent/runtime/poolRegistry.js';
import { isRecord } from './shapes.js';

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;

function pathId(value) {
  const id = decodeURIComponent(value);
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'invalid_id', 'The id in the path is not valid');
  return id;
}

function intParam(url, name, { min = 1, max = 200, fallback } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'invalid_parameter', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * @param {object} deps
 * @param {() => import('../agent/runtime/agentService.js').AgentService} deps.getService
 * @param {() => {mode:string}} deps.runtimeMode
 * @param {import('../agent/runtime/activityLog.js').ActivityLog} deps.activityLog
 * @returns {(request, response, url) => Promise<boolean>}  true when the request was an agent route
 */
export function createAgentRoutes({ getService, runtimeMode, activityLog }) {
  function authorizeAdmin(request) {
    const admin = checkAdminToken(request);
    if (runtimeMode().mode === 'demo' && !admin.configured) return;
    if (!admin.configured) {
      throw new HttpError(403, 'admin_token_not_configured',
        `This action requires AGENTBL_ADMIN_TOKEN (at least ${MIN_ADMIN_TOKEN_LENGTH} characters) to be set on the server`);
    }
    if (!admin.authorized) throw new HttpError(401, 'admin_token_required', 'A valid admin token is required');
  }

  const caller = (request) => (checkAdminToken(request).authorized ? 'admin' : 'demo');

  return async function handleAgentRoute(request, response, url) {
    const { pathname } = url;
    const method = request.method;
    if (!pathname.startsWith('/api/agent/')) return false;
    const service = getService();

    if (method === 'GET' && pathname === '/api/agent/status') {
      sendJson(response, 200, { ok: true, ...(await service.status()) });
      return true;
    }

    if (method === 'POST' && pathname === '/api/agent/control') {
      authorizeAdmin(request);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new HttpError(400, 'invalid_request', 'Body must be an object with an action');
      sendJson(response, 200, { ok: true, ...(await service.control(body)) });
      return true;
    }

    if (method === 'POST' && pathname === '/api/agent/events') {
      authorizeAdmin(request);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new HttpError(400, 'invalid_request', 'Body must be an agent event object');
      // The caller names the event; where it came from is not up to the caller.
      const accepted = await service.submitEvent({ ...body, source: 'admin' }, { origin: 'api' });
      const wait = ['1', 'true'].includes(url.searchParams.get('wait') ?? '');
      const settled = wait ? await service.waitFor(accepted.idempotency_key) : null;
      sendJson(response, wait ? 200 : 202, { ok: true, ...accepted, ...(settled ? { processing: settled } : {}) });
      return true;
    }

    if (method === 'GET' && pathname === '/api/agent/decisions') {
      const result = await service.listDecisions({
        case_id: url.searchParams.get('case_id') ?? undefined,
        pool_id: url.searchParams.get('pool_id') ?? undefined,
        status: url.searchParams.get('status') ?? undefined,
        action: url.searchParams.get('action') ?? undefined,
        limit: intParam(url, 'limit', { fallback: 50 }),
        cursor: url.searchParams.get('cursor') ?? undefined
      });
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }

    const decisionMatch = /^\/api\/agent\/decisions\/([^/]+)(?:\/(trace))?$/u.exec(pathname);
    if (method === 'GET' && decisionMatch) {
      const id = pathId(decisionMatch[1]);
      if (decisionMatch[2] === 'trace') {
        const trace = await service.getTrace(id);
        if (!trace) throw new HttpError(404, 'trace_not_found', 'No trace is recorded for this decision');
        sendJson(response, 200, { ok: true, trace });
        return true;
      }
      const decision = await service.getDecision(id);
      if (!decision) throw new HttpError(404, 'decision_not_found', 'Unknown decision');
      sendJson(response, 200, {
        ok: true,
        decision,
        approvals: service.approvals.list({ decision_id: id }),
        activity: activityLog.list({ limit: 1000 }).filter((record) => record.decision_id === id)
      });
      return true;
    }

    if (method === 'GET' && pathname === '/api/agent/approvals') {
      authorizeAdmin(request);
      await service.approvals.expireStale();
      sendJson(response, 200, {
        ok: true,
        approvals: service.approvals.list({
          status: url.searchParams.get('status') ?? undefined,
          case_id: url.searchParams.get('case_id') ?? undefined,
          limit: intParam(url, 'limit', { fallback: 100 })
        })
      });
      return true;
    }

    const approvalMatch = /^\/api\/agent\/approvals\/([^/]+)(?:\/(approve|reject|attach-tx))?$/u.exec(pathname);
    if (approvalMatch) {
      authorizeAdmin(request);
      const id = pathId(approvalMatch[1]);
      const verb = approvalMatch[2];
      if (method === 'GET' && !verb) {
        const approval = service.approvals.get(id);
        if (!approval) throw new HttpError(404, 'approval_not_found', 'Unknown approval');
        sendJson(response, 200, { ok: true, approval, decision: await service.getDecision(approval.decision_id) });
        return true;
      }
      if (method === 'POST' && verb) {
        const body = (await readJsonBody(request)) ?? {};
        if (!isRecord(body)) throw new HttpError(400, 'invalid_request', 'Body must be an object');
        const note = typeof body.note === 'string' ? body.note.slice(0, 300) : null;
        if (verb === 'approve') {
          sendJson(response, 200, { ok: true, ...(await service.approve(id, { by: caller(request), note })) });
        } else if (verb === 'reject') {
          sendJson(response, 200, { ok: true, ...(await service.reject(id, { by: caller(request), note })) });
        } else {
          if (typeof body.tx_hash !== 'string') throw new HttpError(400, 'invalid_request', 'tx_hash is required');
          const stepIndex = body.step_index === undefined ? 0 : Number(body.step_index);
          if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 10) throw new HttpError(400, 'invalid_request', 'step_index must be a small non-negative integer');
          sendJson(response, 200, { ok: true, ...(await service.attachTx(id, { tx_hash: body.tx_hash.trim(), step_index: stepIndex })) });
        }
        return true;
      }
    }

    if (method === 'GET' && pathname === '/api/agent/pools') {
      sendJson(response, 200, { ok: true, pools: service.registry.list() });
      return true;
    }

    if (method === 'POST' && pathname === '/api/agent/pools/link') {
      authorizeAdmin(request);
      const body = await readJsonBody(request);
      if (!isRecord(body) || typeof body.case_id !== 'string') throw new HttpError(400, 'invalid_request', 'case_id is required');
      const context = await service.getChainContext();
      if (!context) throw new HttpError(503, 'chain_unavailable', 'The chain is not reachable, so the pool cannot be verified');
      const entry = await service.registry.linkChain({
        case_id: body.case_id,
        chain_pool_id: Number(body.chain_pool_id),
        ebl_id: body.ebl_id === undefined ? undefined : Number(body.ebl_id),
        protected: body.protected === true,
        source: 'api-link'
      }, createChainReader(context));
      service.activity.append({ type: 'SYSTEM', action: 'POOL_LINKED', caseId: entry.case_id, details: { chain_pool_id: entry.chain.pool_id, protected: entry.protected } });
      sendJson(response, 200, { ok: true, pool: entry });
      return true;
    }

    return false;
  };
}
