import { checkAdminToken } from './security.js';
import { HttpError, sendJson } from './http.js';

export function handleOperationsRoute(request, response, url, monitor, env = process.env) {
  if (url.pathname === '/api/ready' && request.method === 'GET') {
    const readiness = monitor?.readiness() ?? { ok: false, status: 'unmonitored', scope: 'research_test_assets_only', business_enabled: false };
    sendJson(response, readiness.ok ? 200 : 503, readiness); return true;
  }
  if (!url.pathname.startsWith('/api/ops/')) return false;
  const auth = checkAdminToken(request, env);
  if (!auth.configured || !auth.authorized) throw new HttpError(401, 'admin_token_required', 'Operator authentication is required');
  if (!monitor) throw new HttpError(503, 'operations_unavailable', 'Operational monitoring is not running');
  if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Operations endpoints are read-only');
  if (url.pathname === '/api/ops/status') sendJson(response, 200, monitor.details());
  else if (url.pathname === '/api/ops/metrics') { response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }); response.end(monitor.metrics()); }
  else throw new HttpError(404, 'not_found', 'Unknown operations endpoint');
  return true;
}
// Every route that brings new material or new money in, including aliases and retries. Reads, exits (claims,
// refunds), reconciliation and the original-transaction attachment stay available while intake is paused. The
// agent service enforces the same gate itself (see intakeGate in src/agent/runtime/agentService.js).
export const NEW_INTAKE_ROUTES = Object.freeze([
  ['POST', /^\/api\/agent\/ingest$/u], ['POST', /^\/api\/ebl\/upload$/u], ['POST', /^\/api\/agent\/jobs\/[^/]+\/review$/u],
  ['POST', /^\/api\/positions\/subscription-intents$/u], ['POST', /^\/api\/controlled\/subscription-intents$/u],
  ['POST', /^\/api\/pools$/u], ['POST', /^\/api\/pool\/subscribe$/u], ['POST', /^\/api\/pools\/[^/]+\/subscribe$/u]
]);
export function isNewIntake(method, pathname) {
  return NEW_INTAKE_ROUTES.some(([verb, pattern]) => verb === method && pattern.test(pathname));
}
export function guardNewIntake(request, url, monitor) {
  if (!monitor || monitor.readiness().ok) return;
  if (isNewIntake(request.method, url.pathname)) throw new HttpError(503, 'operations_not_ready', 'New intake is paused. Preserve existing records and reconcile operational health.');
}
