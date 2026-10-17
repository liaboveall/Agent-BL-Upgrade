// A browser workspace capability isolates private uploads in the single-process prototype.
// Live intake additionally requires the existing admin authorization. This is not an enterprise IdP.
import { randomBytes, createHash } from 'node:crypto';
import { checkAdminToken } from './security.js';
import { HttpError } from './http.js';
const COOKIE = 'agentbl_workspace';
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
export function canReadWorkspaceCase(service, request, caseId) {
  if (!service.ingest?.isPrivateCase?.(caseId)) return true;
  if (checkAdminToken(request).authorized) return true;
  return service.ingest.caseOwner(caseId) === workspaceOwner(request) && Boolean(workspaceOwner(request));
}
export function requireWorkspaceCase(service, request, caseId) {
  if (!canReadWorkspaceCase(service, request, caseId)) throw new HttpError(404, 'case_not_found', 'Case not found in this workspace');
}
