// HTTP routes of the agent runtime (docs/agent-implementation-plan.md §4.6). They are thin on purpose:
// parse, authorise, call the AgentService, shape the reply. The older /api/agent/activity routes stay
// in server.js because they share the SSE plumbing there.
//
// Authorisation: reads of decisions, traces and status are public (nothing in them is secret). Anything
// that changes state, and the approval queue itself, needs the admin token -- except that in Demo mode,
// when no admin token is configured at all, they are open so the Demo works with zero setup.

import { proposeLiveSmoke } from '../agent/runtime/liveSmoke.js';
import { sanitizeAudit } from '../agent/security/privacy.js';
import { checkAdminToken, MIN_ADMIN_TOKEN_LENGTH } from './security.js';
import { HttpError, readJsonBody, sendJson } from './http.js';
import { createChainReader } from '../agent/runtime/poolRegistry.js';
import { isRecord } from './shapes.js';
import { withReferences } from '../agent/runtime/references.js';
import { publicAgentPolicy } from '../mcp/agentTools.js';
import { subscriptionAvailability } from '../core/subscription.js';
import { workspaceOwner, canReadWorkspaceCase, requireWorkspaceCase } from './workspaceAccess.js';

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

  /** Uploads and preferences are open in Demo (zero setup) and need the admin token in Live. */
  function authorizeIntake(request) {
    if (runtimeMode().mode === 'live') authorizeAdmin(request);
  }

  const CASE_PATH = /^\/api\/agent\/cases\/([^/]+)\/preferences$/u;
  const SCENARIO_PATH = /^\/api\/agent\/scenarios\/([^/]+)\/(start|step|run|stop)$/u;

  return async function handleAgentRoute(request, response, url) {
    const { pathname } = url;
    const method = request.method;
    if (!pathname.startsWith('/api/agent/')) return false;
    const service = getService();
    const caseFilter = (caseId) => canReadWorkspaceCase(service, request, caseId);

    if (method === 'GET' && pathname === '/api/agent/workspace/cases') {
      await service.ingest?.init?.();
      const cases = (await service.ingest?.listCases() ?? []).filter((data) => caseFilter(data.case_id));
      sendJson(response, 200, { ok: true, visibility: 'private', cases });
      return true;
    }

    if (method === 'GET' && pathname === '/api/agent/policy') {
      sendJson(response, 200, { ok: true, policy: await publicAgentPolicy(service) });
      return true;
    }

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

    if (method === 'POST' && pathname === '/api/agent/smoke/propose') {
      authorizeAdmin(request);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new HttpError(400, 'invalid_request', 'Body must contain a smoke action and run_id');
      sendJson(response, 200, { ok: true, ...(await proposeLiveSmoke(service, body)) });
      return true;
    }

    if (method === 'POST' && pathname === '/api/agent/events') {
      authorizeAdmin(request);
      const body = await readJsonBody(request);
      if (!isRecord(body)) throw new HttpError(400, 'invalid_request', 'Body must be an agent event object');
      if (body.case_id) requireWorkspaceCase(service, request, body.case_id);
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
        , caseFilter
      });
      sendJson(response, 200, { ok: true, ...result, decisions: result.decisions.map(withReferences) });
      return true;
    }

    if (method === 'GET' && pathname === '/api/agent/references') {
      const { decisions } = await service.listDecisions({ limit: service.config.maxDecisions, caseFilter });
      const seen = new Set();
      const current = decisions.filter((decision) => {
        if (decision.mode !== service.getMode() || decision.generation !== undefined && decision.generation !== service.getGeneration() || seen.has(decision.case_id)) return false;
        seen.add(decision.case_id); return true;
      });
      sendJson(response, 200, { ok: true, mode: service.getMode(), generation: service.getGeneration(), decisions: current.map(withReferences),
        pools: [...service.store.pools.values()]
          .filter((pool) => caseFilter(pool.caseData?.case_id ?? pool.poolId))
          .filter((pool) => service.getMode() === 'demo' || service.registry.get(pool.caseData?.case_id ?? pool.poolId)?.chain)
          .map((pool) => ({ case_id: pool.caseData?.case_id ?? pool.poolId, status: pool.status, quote: pool.quote,
            ...subscriptionAvailability(pool),
            quote_version: pool.quoteVersion ?? 1, subscribed_shares: pool.subscribedShares ?? null, token_supply: pool.tokenSupply ?? null,
            // The recorded subscription totals; the market shows these, never an estimate.
            subscribed_usd: Number.isFinite(pool.subscribedUsd) ? pool.subscribedUsd : null,
            target_usd: Number.isFinite(pool.targetUsd) ? pool.targetUsd : null,
            source_mode: service.getMode() === 'demo' ? 'demo' : 'chain-mirror' })) });
      return true;
    }

    const decisionMatch = /^\/api\/agent\/decisions\/([^/]+)(?:\/(trace|replay|anchor))?$/u.exec(pathname);
    if (method === 'GET' && decisionMatch) {
      const id = pathId(decisionMatch[1]);
      const privateDecision = await service.getDecision(id);
      if (privateDecision) requireWorkspaceCase(service, request, privateDecision.case_id);
      if (decisionMatch[2] === 'anchor') {
        sendJson(response, 200, { ok: true, anchor: await service.getDecisionAnchor(id) });
        return true;
      }
      if (decisionMatch[2] === 'replay') {
        if (runtimeMode().mode === 'live') authorizeAdmin(request);
        sendJson(response, 200, { ok: true, replay: await service.replayDecision(id) });
        return true;
      }
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
        decision: withReferences(decision),
        approvals: sanitizeAudit(service.approvals.list({ decision_id: id })),
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
        }).filter((approval) => caseFilter(approval.case_id))
      });
      return true;
    }

    const approvalMatch = /^\/api\/agent\/approvals\/([^/]+)(?:\/(approve|reject|attach-tx))?$/u.exec(pathname);
    if (approvalMatch) {
      authorizeAdmin(request);
      const id = pathId(approvalMatch[1]);
      const scopedApproval = service.approvals.get(id);
      if (scopedApproval) requireWorkspaceCase(service, request, scopedApproval.case_id);
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

    if (method === 'POST' && pathname === '/api/agent/ingest') {
      authorizeIntake(request);
      // A request may carry a few maximum-size documents; base64 inflates them by a third.
      const limit = Math.ceil(service.config.uploadMaxBytes * (4 / 3) * 3) + 65_536;
      const body = await readJsonBody(request, { limit });
      if (!isRecord(body)) throw new HttpError(400, 'invalid_request', 'Body must be an object with a documents array');
      if (body.case_id) requireWorkspaceCase(service, request, body.case_id);
      const result = await service.submitDocuments(body, { ownerId: workspaceOwner(request, response) });
      const wait = ['1', 'true'].includes(url.searchParams.get('wait') ?? '');
      if (wait && result.idempotency_key) await service.waitFor(result.idempotency_key, 30_000);
      const job = service.ingest.getJob(result.job.job_id);
      sendJson(response, result.created ? 202 : 200, {
        ok: true,
        created: result.created,
        job,
        documents: result.documents.map((document) => ({
          document_id: document.document_id, name: document.name, mime_type: document.mime_type, kind: document.kind,
          size: document.size, sha256: document.sha256, eni: document.eni, observed_at: document.observed_at, expires_at: document.expires_at, source_status: document.source_status
        }))
      });
      return true;
    }

    const reviewMatch = /^\/api\/agent\/jobs\/([^/]+)\/review$/u.exec(pathname);
    if (method === 'POST' && reviewMatch) {
      authorizeIntake(request);
      const previous = service.ingest?.getJob(pathId(reviewMatch[1]));
      if (previous) requireWorkspaceCase(service, request, previous.case_id);
      const body = await readJsonBody(request, { limit: Math.ceil(service.config.uploadMaxBytes * 4) + 65_536 });
      sendJson(response, 202, { ok: true, ...(await service.reviewDocuments(pathId(reviewMatch[1]), body)) });
      return true;
    }
    const jobMatch = /^\/api\/agent\/jobs\/([^/]+)$/u.exec(pathname);
    if (method === 'GET' && jobMatch) {
      const job = service.ingest?.getJob(pathId(jobMatch[1]));
      if (!job) throw new HttpError(404, 'job_not_found', 'Unknown ingest job');
      requireWorkspaceCase(service, request, job.case_id);
      sendJson(response, 200, { ok: true, job });
      return true;
    }
    if (method === 'GET' && pathname === '/api/agent/jobs') {
      sendJson(response, 200, { ok: true, jobs: (service.ingest?.listJobs({ case_id: url.searchParams.get('case_id') ?? undefined, limit: intParam(url, 'limit', { fallback: 50 }) }) ?? []).filter((job) => caseFilter(job.case_id)) });
      return true;
    }

    const caseMatch = CASE_PATH.exec(pathname);
    if (caseMatch) {
      const caseId = pathId(caseMatch[1]);
      requireWorkspaceCase(service, request, caseId);
      if (method === 'GET') {
        sendJson(response, 200, { ok: true, case_id: caseId, ...(service.preferences.describe(caseId) ?? { preferences: {}, updated_at: null }) });
        return true;
      }
      if (method === 'PUT') {
        authorizeIntake(request);
        const body = await readJsonBody(request);
        if (!isRecord(body)) throw new HttpError(400, 'invalid_request', 'Body must be an object of exporter preferences');
        sendJson(response, 200, { ok: true, case_id: caseId, ...(await service.setPreferences(caseId, body)) });
        return true;
      }
    }

    if (method === 'GET' && pathname === '/api/agent/scenarios') {
      sendJson(response, 200, { ok: true, scenarios: await service.scenarios.list(), current: service.scenarios.status() });
      return true;
    }
    if (pathname === '/api/agent/demo/run' && (method === 'GET' || method === 'POST')) {
      if (method === 'GET') {
        sendJson(response, 200, { ok: true, run: service.scenarios.playbackStatus() });
      } else {
        authorizeAdmin(request);
        const body = await readJsonBody(request);
        if (!isRecord(body) || Object.keys(body).some((key) => !['scenario', 'speed'].includes(key))) {
          throw new HttpError(400, 'invalid_request', 'Expected {scenario, speed}');
        }
        sendJson(response, 202, { ok: true, run: await service.scenarios.play(body.scenario ?? 'copper-lifecycle', { speed: body.speed ?? 1 }) });
      }
      return true;
    }
    if (pathname === '/api/agent/demo/stop' && method === 'POST') {
      authorizeAdmin(request);
      if (runtimeMode().mode !== 'demo') throw new HttpError(409, 'demo_only', 'Demo playback is disabled in Live');
      sendJson(response, 200, { ok: true, run: await service.scenarios.stopPlayback() });
      return true;
    }
    const scenarioMatch = SCENARIO_PATH.exec(pathname);
    if (method === 'POST' && scenarioMatch) {
      authorizeAdmin(request);
      const name = scenarioMatch[1];
      const verb = scenarioMatch[2];
      const body = (await readJsonBody(request)) ?? {};
      if (!isRecord(body)) throw new HttpError(400, 'invalid_request', 'Body must be an object');
      if (verb === 'start') sendJson(response, 200, { ok: true, ...(await service.scenarios.start(name, { reset: body.reset === true })) });
      else if (verb === 'step') sendJson(response, 200, { ok: true, ...(await service.scenarios.step()) });
      else if (verb === 'run') {
        if (service.scenarios.status().name !== name) await service.scenarios.start(name, { reset: body.reset === true });
        sendJson(response, 200, { ok: true, ...(await service.scenarios.run()) });
      } else sendJson(response, 200, { ok: true, ...(await service.scenarios.stop()) });
      return true;
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
