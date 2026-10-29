// A browser workspace capability isolates private uploads in the single-process prototype.
// Live intake additionally requires the existing admin authorization. This is not an enterprise IdP.
//
// Who may read a case comes from the intake's durable access records (src/agent/ingest/ingestService.js), never
// from the bounded job list. Results produced from an upload are private unless their case was published.
import { randomBytes, createHash } from 'node:crypto';
import { checkAdminToken } from './security.js';
import { HttpError } from './http.js';
const COOKIE = 'agentbl_workspace';
const UPLOAD_EVENTS = new Set(['DOCUMENTS_INGESTED', 'REVIEW_RESOLVED']);
export function workspaceOwner(request, response) {
  let value = String(request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!/^[a-f0-9]{48}$/u.test(value ?? '')) {
    if (!response) return null;
    value = randomBytes(24).toString('hex');
    response.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${request.socket?.encrypted ? '; Secure' : ''}`);
  }
  return createHash('sha256').update(value).digest('hex');
}
const viewer = (request) => ({ ownerId: workspaceOwner(request), admin: checkAdminToken(request).authorized });
/** `record` (a decision, an approval, ...) narrows the check: what an upload produced follows that upload's owner. */
export function canReadWorkspaceCase(service, request, caseId, record) {
  const ingest = service.ingest;
  if (!ingest?.canReadCase) return true;
  if (record && UPLOAD_EVENTS.has(record.event_type)) return ingest.canReadUploadRecord(caseId, record.event_id, viewer(request));
  return ingest.canReadCase(caseId, viewer(request));
}
export function canReadJob(service, request, job) {
  return Boolean(job) && (service.ingest?.canReadJob?.(job, viewer(request)) ?? true);
}
export function requireWorkspaceCase(service, request, caseId, record) {
  if (canReadWorkspaceCase(service, request, caseId, record)) return;
  // Every case but a curated sample answers the same while the access records are unavailable, so this says nothing
  // about whether one exists.
  if (service.ingest && service.ingest.accessReady === false) {
    throw new HttpError(503, 'case_access_unavailable', 'Private cases are unavailable until the case access records are loaded');
  }
  throw new HttpError(404, 'case_not_found', 'Case not found in this workspace');
}
/**
 * Wait for the access records (and the saved preferences, which can make a case private on their own) to load before
 * answering a request that checks them, so a slow start answers late instead of refusing. A failed load is not an
 * error here: every check then refuses what is not a curated sample.
 */
export async function settleCaseAccess(service) {
  await Promise.all([service.ingest?.init?.(), service.preferences?.init?.()].map((loading) => Promise.resolve(loading).catch(() => {})));
}
/** For a route that lists or writes private cases: refuse while the access records are not loaded. */
export function requireCaseAccess(service) {
  if (service.ingest && service.ingest.accessReady === false) {
    throw new HttpError(503, 'case_access_unavailable', 'Private cases are unavailable until the case access records are loaded');
  }
}
/** The public view (MCP, resources): only what an anonymous reader may see. */
export function publicCaseFilter(service) {
  const ingest = service.ingest;
  return (caseId, record) => !ingest?.canReadCase ? true
    : record && UPLOAD_EVENTS.has(record.event_type) ? ingest.canReadUploadRecord(caseId, record.event_id) : ingest.canReadCase(caseId);
}
