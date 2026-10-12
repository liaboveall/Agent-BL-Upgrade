// Shared HTTP plumbing for the AgentBL server: bounded body reads, JSON/text
// responses (gzip for large payloads), one error -> status mapping, client IP
// resolution. Kept free of routing so it can be unit-tested in isolation.
import zlib from 'node:zlib';
import { ValidationError } from '../core/schema.js';

/** A request-level failure that already knows its HTTP status. */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const GZIP_MIN_BYTES = 1024;

/** Request-body cap in bytes; override with AGENTBL_MAX_BODY_BYTES. */
export function configuredBodyLimit(env = process.env) {
  const raw = Number(env.AGENTBL_MAX_BODY_BYTES);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_BODY_LIMIT_BYTES;
}

function tooLarge(limit) {
  return new HttpError(413, 'payload_too_large', `Request body exceeds the ${limit}-byte limit`);
}

/**
 * Read the request body into a Buffer without ever holding more than `limit`
 * bytes. A declared Content-Length over the limit is rejected before reading.
 * The stream is NOT destroyed on rejection so the 413 can still be delivered.
 */
export async function readBody(request, { limit = configuredBodyLimit() } = {}) {
  const declared = Number(request.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit);

  const chunks = [];
  let received = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    received += chunk.length;
    if (received > limit) throw tooLarge(limit);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, received);
}

/** Parse a JSON body. An empty body yields `null`; malformed JSON is a 400. */
export async function readJsonBody(request, options) {
  const text = (await readBody(request, options)).toString('utf8').trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new HttpError(400, 'invalid_json', `Request body is not valid JSON: ${cause.message}`);
  }
}

/** decodeURIComponent that reports malformed input as a 400 instead of a 500. */
export function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'malformed_url', 'Malformed percent-encoding in request URL');
  }
}

export function acceptsGzip(request) {
  return /\bgzip\b/iu.test(String(request?.headers?.['accept-encoding'] ?? ''));
}

/** Write a finished body, gzip-compressing it when large and the client allows. */
export function sendBuffer(response, statusCode, body, contentType, extraHeaders = {}) {
  const headers = { 'content-type': contentType, ...extraHeaders };
  let payload = body;
  if (payload.length >= GZIP_MIN_BYTES && acceptsGzip(response.req)) {
    payload = zlib.gzipSync(payload);
    headers['content-encoding'] = 'gzip';
    headers.vary = 'Accept-Encoding';
  }
  headers['content-length'] = payload.length;
  response.writeHead(statusCode, headers);
  response.end(payload);
}

export function sendJson(response, statusCode, payload) {
  sendBuffer(response, statusCode, Buffer.from(JSON.stringify(payload), 'utf8'), 'application/json; charset=utf-8');
}

export function sendText(response, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  sendBuffer(response, statusCode, Buffer.from(text, 'utf8'), contentType);
}

/** Map any thrown value to the response the client should see. */
export function describeError(error) {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof ValidationError) {
    return { status: 400, code: 'validation_error', message: error.message, details: error.errors };
  }
  if (error instanceof SyntaxError) {
    return { status: 400, code: 'invalid_json', message: error.message };
  }
  if (error instanceof URIError) {
    return { status: 400, code: 'malformed_url', message: 'Malformed percent-encoding in request URL' };
  }
  // Agent-runtime errors (invalid event, approval state conflicts, mode rules, ...) are the caller's
  // to see: they carry their own 4xx status and a message written for an operator.
  if (error?.expose === true && Number.isInteger(error.status) && error.status < 500) {
    return { status: error.status, code: error.code, message: error.message, details: error.issues };
  }
  if (error?.code === 'paid_report_invalid') {
    return { status: 400, code: error.code, message: error.message, details: error.errors };
  }
  // Anything else is a bug on our side: never leak its message to the client.
  return { status: 500, code: 'internal_error', message: 'Internal server error' };
}

export function sendError(response, error, { requestId, logger = console } = {}) {
  const mapped = describeError(error);
  if (mapped.status >= 500) {
    // Expected operational failures (provider down, not configured) get one line;
    // only genuinely unexpected exceptions are worth a stack trace.
    if (error instanceof HttpError) logger.warn(`[agentbl] ${requestId ?? '-'} ${mapped.status} ${mapped.code}: ${mapped.message}`);
    else logger.error(`[agentbl] ${requestId ?? '-'} unhandled error:`, error);
  }
  if (response.headersSent) {
    // Mid-stream (e.g. SSE / LLM relay): the status line is gone, just stop.
    if (!response.writableEnded) response.end();
    return;
  }
  if (mapped.status === 413) response.setHeader('connection', 'close');
  sendJson(response, mapped.status, {
    ok: false,
    error: mapped.message,
    ...(mapped.code ? { code: mapped.code } : {}),
    ...(mapped.details !== undefined ? { details: mapped.details } : {}),
    ...(mapped.status >= 500 && requestId ? { request_id: requestId } : {})
  });
}

function trustedHops(value) {
  if (value === undefined || value === null || value === '' || value === 'false' || value === '0') return 0;
  if (value === 'true') return 1;
  const hops = Number(value);
  return Number.isInteger(hops) && hops > 0 ? hops : 0;
}

function normalizeIp(ip) {
  return String(ip ?? 'unknown').replace(/^::ffff:/iu, '');
}

/**
 * Best-effort client IP for rate limiting. X-Forwarded-For is only honoured
 * when TRUST_PROXY is set to the number of trusted proxy hops (true => 1),
 * because otherwise any client can spoof it.
 */
export function clientIp(request, env = process.env) {
  const socketIp = normalizeIp(request.socket?.remoteAddress);
  const hops = trustedHops(env.TRUST_PROXY);
  if (hops === 0) return socketIp;
  const forwarded = String(request.headers?.['x-forwarded-for'] ?? '')
    .split(',').map((part) => part.trim()).filter(Boolean);
  return normalizeIp(forwarded[forwarded.length - hops] ?? socketIp);
}
