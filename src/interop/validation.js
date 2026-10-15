import { HttpError } from '../app/http.js';

// Bound untrusted JSON before recursive schema validation, hashing or pricing.
export function checkInteropInput(value) {
  const pending = [[value, 0]];
  let count = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++count > 20_000 || depth > 20) throw new HttpError(400, 'input_complexity_limit', 'Input nesting or item count exceeds the limit');
    if (typeof item === 'number' && !Number.isFinite(item)) throw new HttpError(400, 'invalid_interop_request', 'Numbers must be finite');
    if (!item || typeof item !== 'object') continue;
    for (const [key, next] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new HttpError(400, 'invalid_interop_request', 'Reserved object key');
      pending.push([next, depth + 1]);
    }
  }
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 1_048_576) throw new HttpError(413, 'body_too_large', 'Interoperability input exceeds 1 MiB');
}

export function checkedInterop(schema, value) {
  checkInteropInput(value);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'invalid_interop_request', 'Invalid interoperability input',
    parsed.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })));
  return parsed.data;
}

export function httpOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(503, 'invalid_public_origin', `${name} must be an absolute HTTP(S) origin`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new HttpError(503, 'invalid_public_origin', `${name} must be an HTTP(S) origin without credentials, path, query or fragment`);
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new HttpError(503, 'invalid_public_origin', `${name} requires HTTPS outside loopback`);
  }
  return url.origin;
}

export function publicOrigin(request, env = process.env) {
  const configured = env.AGENTBL_PUBLIC_BASE_URL || env.X402_PUBLIC_BASE_URL;
  return configured ? httpOrigin(configured, 'AGENTBL_PUBLIC_BASE_URL')
    : `http://localhost:${request.socket?.localPort ?? (Number(env.PORT) || 3000)}`;
}
