import { RightsService } from '../rights/service.js';
import { loadRightsChain } from '../rights/chain.js';
import { checkAdminToken } from './security.js';
import { HttpError, readJsonBody, sendJson } from './http.js';

const tokenFor = (request) => String(request.headers['x-rights-session'] ?? '');
function requireAdmin(request, env) {
  const admin = checkAdminToken(request, env);
  if (!admin.configured || !admin.authorized) throw new HttpError(401, 'admin_token_required', 'Configured administrator authorization is required');
}
export function createRightsRoutes({ env = process.env, getVersion = null, service = new RightsService({ env, getVersion }), streamInterval = 1000 } = {}) {
  let chainLoading;
  return async (request, response, url) => {
    if (!url.pathname.startsWith('/api/rights/')) return false;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'x-rights-session, authorization');
    const path = url.pathname.slice('/api/rights/'.length), method = request.method;
    const body = () => readJsonBody(request, { limit: 1_048_576 });
    const token = tokenFor(request);
    const match = /^materials\/([a-f0-9-]{36})(?:\/(download|review|publish|events|terms))?$/u.exec(path);
    if (!service.chain && env.AGENTBL_RIGHTS_CONFIG && (path === 'status' || path.startsWith('transaction-plans'))) {
      if (path !== 'status') await service.principal(token);
      chainLoading ??= loadRightsChain(env.AGENTBL_RIGHTS_CONFIG).catch(() => { chainLoading = null; throw new HttpError(503, 'rights_chain_unavailable', 'W3 instance verification failed'); });
      service.chain = await chainLoading;
    }
    let result;
    if (path === 'status' && method === 'GET') result = await service.status();
    else if (path === 'subjects' && method === 'POST') { requireAdmin(request, env); result = await service.createSubject(await body()); }
    else if (/^subjects\/[a-f0-9-]{36}$/u.test(path) && method === 'DELETE') { requireAdmin(request, env); result = await service.revokeSubject(path.split('/')[1]); }
    else if (path === 'session-challenges' && method === 'POST') { requireAdmin(request, env); result = await service.createChallenge((await body())?.subject_id); }
    else if (path === 'sessions' && method === 'POST') result = await service.openSession(await body());
    else if (/^sessions\/[a-f0-9-]{36}$/u.test(path) && method === 'DELETE') { requireAdmin(request, env); result = await service.revokeSession(path.split('/')[1]); }
    else if (path === 'me' && method === 'GET') result = await service.principal(token);
    else if (path === 'materials' && method === 'POST') result = await service.createMaterial(token, await body());
    else if (path === 'evidence' && method === 'POST') result = await service.createEvidence(token, await body());
    else if (/^evidence\/[a-f0-9-]{36}\/download$/u.test(path) && method === 'GET') {
      result = await service.exportEvidence(token, path.split('/')[1]);
      response.setHeader('Content-Disposition', `attachment; filename="evidence-${path.split('/')[1]}.json"`);
    }
    else if (/^evidence\/[a-f0-9-]{36}\/review$/u.test(path) && method === 'POST') result = await service.requestEvidenceReview(token, path.split('/')[1], await body());
    else if (/^evidence-reviews\/[a-f0-9-]{36}\/resolve$/u.test(path) && method === 'POST') result = await service.resolveEvidenceReview(token, path.split('/')[1], await body());
    else if (/^transaction-plans\/[a-f0-9-]{36}$/u.test(path) && method === 'GET') result = await service.getPlan(token, path.split('/')[1]);
    else if (/^transaction-plans\/[a-f0-9-]{36}\/transaction$/u.test(path) && method === 'POST') result = await service.attachTransaction(token, path.split('/')[1], (await body())?.tx_hash);
    else if (/^publications\/[a-f0-9-]{36}$/u.test(path) && method === 'GET') result = await service.publication(path.split('/')[1]);
    else if (path === 'transaction-plans' && method === 'POST') {
      const input = await body();
      if (['register_title', 'pledge', 'create_offering', 'acknowledge_terms', 'disburse'].includes(input?.operation)
        && request.socket.server?.operations && !request.socket.server.operations.readiness().ok) {
        throw new HttpError(503, 'operations_not_ready', 'New rights intake is paused pending operational reconciliation');
      }
      result = await service.prepareTransaction(token, input);
    } else if (match) {
      const [, materialId, action] = match;
      if (method === 'GET' && action === 'events') {
        const first = await service.invoke(token, 'read_material', materialId, 'sse');
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const emit = (item) => response.write(`event: revision\ndata: ${JSON.stringify({ material_id: item.material_id, revision: item.revision, document_hash: item.document_hash })}\n\n`);
        emit(first);
        let pending = false;
        const timer = setInterval(async () => {
          if (pending) return; pending = true;
          try { const record = await service.invoke(token, 'read_material', materialId, 'sse'); emit(record); }
          catch { response.end(); clearInterval(timer); }
          finally { pending = false; }
        }, streamInterval);
        timer.unref(); response.once('close', () => clearInterval(timer));
        return true;
      }
      if (method === 'GET' && (!action || action === 'download')) {
        result = await service.invoke(token, 'read_material', materialId, action === 'download' ? 'download' : 'http');
        if (action === 'download') response.setHeader('Content-Disposition', `attachment; filename="${materialId}.json"`);
      } else if (method === 'POST' && action === 'review') result = await service.reviewMaterial(token, materialId, await body());
      else if (method === 'POST' && action === 'terms') result = await service.bindTerms(token, materialId, (await body())?.terms_hash);
      else if (method === 'POST' && action === 'publish') result = await service.publishMaterial(token, materialId);
      else throw new HttpError(405, 'method_not_allowed', 'Unsupported rights material operation');
    } else if (['mcp', 'a2a'].includes(path) && method === 'POST') {
      const input = await body();
      // These private adapters intentionally share the same session and object authorization.
      if (path === 'mcp') {
        if (input?.jsonrpc !== '2.0' || input.method !== 'tools/call' || !['string', 'number'].includes(typeof input.id)) throw new HttpError(400, 'rights_rpc_invalid', 'Invalid rights RPC envelope');
        const args = input.params?.arguments;
        result = { jsonrpc: '2.0', id: input.id, result: { content: [{ type: 'text', text: JSON.stringify(await service.invoke(token, input.params?.name, args?.evidence_id ?? args?.material_id, 'mcp')) }] } };
      } else result = { result: await service.invoke(token, input?.operation, input?.evidence_id ?? input?.material_id, 'a2a') };
    } else throw new HttpError(404, 'rights_route_not_found', 'Unknown rights route');
    sendJson(response, 200, result); return true;
  };
}
