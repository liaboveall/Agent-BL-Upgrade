import { HttpError } from '../app/http.js';

// One policy for what pauses while operational readiness is degraded: everything that brings in new material, new
// terms or new money. Reads, exits (claims, refunds, repayment, resolution, start_exit, cancellation, collateral
// release), attaching and reconciling an original transaction and releasing an unsent wallet operation stay open, so a
// degraded service never traps what is already in. Each entry point applies the same lists: the global HTTP guard and
// the rights routes (NEW_INTAKE_ROUTES), the agent service (its intakeGate), and the wallet-operation services both when
// a draft is prepared and again at its broadcast checkpoint, because a draft saved while ready must not reach the
// wallet after readiness drops.

/** Rights wallet operations that add risk: a new title, pledge, offering, terms acceptance or a draw of investor money. */
export const NEW_RISK_RIGHTS_OPERATIONS = Object.freeze(['register_title', 'pledge', 'create_offering', 'acknowledge_terms', 'disburse']);
/** Capital-ledger wallet operations that bring new money in. Claims and refunds are exits. */
export const NEW_RISK_CAPITAL_OPERATIONS = Object.freeze(['SUBSCRIBE']);

// Routes whose method and path alone mean new intake, including aliases and retries. Rights transaction plans are
// decided by their operation (above), so they are not listed here.
export const NEW_INTAKE_ROUTES = Object.freeze([
  ['POST', /^\/api\/agent\/ingest$/u], ['POST', /^\/api\/ebl\/upload$/u], ['POST', /^\/api\/agent\/jobs\/[^/]+\/review$/u],
  ['POST', /^\/api\/positions\/subscription-intents$/u], ['POST', /^\/api\/controlled\/subscription-intents$/u],
  ['POST', /^\/api\/pools$/u], ['POST', /^\/api\/pool\/subscribe$/u], ['POST', /^\/api\/pools\/[^/]+\/subscribe$/u],
  // Rights material and evidence, a new terms revision or publication, and the typed data a new issuance or valuation signs.
  ['POST', /^\/api\/rights\/materials$/u], ['POST', /^\/api\/rights\/evidence$/u],
  ['POST', /^\/api\/rights\/materials\/[^/]+\/(?:financing-disclosure|terms|publish|signing-request)$/u]
].map(Object.freeze));

export const INTAKE_PAUSED_MESSAGE = 'New intake is paused. Preserve existing records and reconcile operational health.';
const OPEN = Object.freeze({ ok: true });

export function isNewIntake(method, pathname) {
  return NEW_INTAKE_ROUTES.some(([verb, pattern]) => verb === method && pattern.test(pathname));
}
/** Readiness of the server a request arrived on; a server without monitoring falls back to `fallback`. */
export function requestReadiness(request, fallback = () => OPEN) {
  const operations = request?.socket?.server?.operations;
  return () => operations ? operations.readiness() : fallback();
}
export function assertIntakeOpen(readiness, message = INTAKE_PAUSED_MESSAGE) {
  if (readiness && readiness.ok === false) throw new HttpError(503, 'operations_not_ready', message);
}
export function guardNewIntake(request, url, monitor) {
  if (monitor && isNewIntake(request.method, url.pathname)) assertIntakeOpen(monitor.readiness());
}
/** Throws for a new-risk operation while readiness is degraded; exits pass. */
export function assertOperationOpen(operations, operation, readiness, message) {
  if (operations.includes(operation)) assertIntakeOpen(readiness?.(), message);
}
