import { getLang } from './i18n.js';
import { getAppState } from '../state/app-store.js';

const sessions = new Map();
let epoch = 0;
export function resetCopilotSession(scope) {
  for (const [key, entry] of sessions) if (!scope || key === scope) {
    entry.stream?.close(); sessions.delete(key);
    if (scope && entry.id) fetch(`/api/copilot/sessions/${entry.id}`, { method: 'DELETE' }).catch(() => {});
  }
  if (!scope) epoch += 1;
}

async function json(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status, code: result.code });
  return result;
}

async function sessionId(scope) {
  let entry = sessions.get(scope);
  if (entry?.id) return entry.id;
  const currentEpoch = epoch;
  if (!entry) { entry = {}; sessions.set(scope, entry); }
  if (!entry.pending) entry.pending = json('/api/copilot/sessions', { locale: getLang() });
  const pending = entry.pending;
  try {
    const created = await pending;
    if (epoch !== currentEpoch || sessions.get(scope) !== entry) throw new Error('Copilot session changed');
    entry.id = created.context.session_id;
    return entry.id;
  } finally { if (entry.pending === pending) entry.pending = null; }
}

function connectUpdates(scope, result) {
  const entry = sessions.get(scope);
  if (!entry || typeof EventSource === 'undefined') return;
  entry.stream?.close();
  entry.seq = result.context.update_seq ?? 0;
  const currentEpoch = epoch, mode = result.mode, generation = result.generation;
  const stream = new EventSource(`/api/copilot/sessions/${entry.id}/stream?last_event_id=${entry.seq}`);
  entry.stream = stream;
  stream.addEventListener('COPILOT_RERANK', (event) => {
    if (currentEpoch !== epoch || sessions.get(scope) !== entry) return;
    try {
      const update = JSON.parse(event.data), state = getAppState();
      if (update.mode !== mode || update.generation !== generation || state.modeGeneration !== generation || state.demoMode !== (mode === 'demo') || update.seq <= entry.seq) return;
      entry.seq = update.seq;
      window.dispatchEvent(new CustomEvent('agentbl:copilotupdate', { detail: { scope, update } }));
    } catch { /* A malformed frame never changes the displayed recommendation. */ }
  });
  stream.addEventListener('SESSION_CLOSED', () => { stream.close(); if (sessions.get(scope) === entry) sessions.delete(scope); });
}

export async function watchPool(context, poolId) {
  const pool_ids = context.watchlist.includes(poolId) ? context.watchlist.filter((id) => id !== poolId) : [...context.watchlist, poolId];
  const response = await fetch(`/api/copilot/sessions/${context.session_id}/watchlist`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pool_ids })
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { code: result.code });
  return result.context;
}

/** Parse framed SSE, including split UTF-8 characters and split event boundaries. */
export async function readCopilotStream(response, onEvent) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result = null, done = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer = (buffer + decoder.decode(chunk.value, { stream: !chunk.done })).replaceAll('\r\n', '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const event = frame.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === 'result') result = payload;
        if (event === 'narrative' && result) Object.assign(result, payload);
        if (event === 'done') done = payload.ok === true;
        onEvent?.(event, payload);
      }
      if (chunk.done) break;
    }
    if (!done || !result) throw new Error('Copilot stream interrupted; retry the query');
    return result;
  } finally { reader.releaseLock(); }
}

export async function copilotQuery(message, { stateless = false, scope = 'assistant', limit = 5, pool_ids, service_id, onResult, signal } = {}) {
  const currentEpoch = epoch;
  const { modeGeneration: generation, demoMode } = getAppState(), mode = demoMode ? 'demo' : 'live';
  const id = stateless ? null : await sessionId(scope);
  const path = stateless ? '/api/copilot/query' : `/api/copilot/sessions/${id}/messages`;
  const response = await fetch(path, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message, locale: getLang(), limit, pool_ids, service_id }) });
  if (!response.ok) {
    const error = await response.json();
    if (!stateless && [404, 409].includes(response.status) && currentEpoch === epoch) resetCopilotSession();
    throw Object.assign(new Error(error.error), { status: response.status, code: error.code });
  }
  const result = await readCopilotStream(response, (event, result) => {
    if (epoch !== currentEpoch || !stateless && sessions.get(scope)?.id !== id) return;
    if (event === 'result' && result.generation === generation && result.mode === mode) onResult?.(result);
  });
  if (epoch !== currentEpoch || !stateless && sessions.get(scope)?.id !== id || getAppState().modeGeneration !== generation || result.generation !== generation || result.mode !== mode) {
    throw Object.assign(new Error('Runtime mode changed; start a new query'), { status: 409, code: 'session_mode_changed' });
  }
  if (!stateless) connectUpdates(scope, result);
  return result;
}
