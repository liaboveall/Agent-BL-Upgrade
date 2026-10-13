import { getLang } from '../i18n.js';
import { state } from '../store.js';

let session = null, pendingSession = null, epoch = 0;
export function resetCopilotSession() { session = null; pendingSession = null; epoch += 1; }

async function json(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status, code: result.code });
  return result;
}

async function sessionId() {
  if (session) return session;
  const currentEpoch = epoch;
  if (!pendingSession) pendingSession = json('/api/copilot/sessions', { locale: getLang() });
  const pending = pendingSession;
  try {
    const created = await pending;
    if (epoch !== currentEpoch) throw new Error('Copilot session changed');
    session = created.context.session_id;
    return session;
  } finally { if (pendingSession === pending) pendingSession = null; }
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

export async function copilotQuery(message, { stateless = false, limit = 5, pool_ids, onResult, signal } = {}) {
  const currentEpoch = epoch;
  const generation = state.modeGeneration, mode = state.demoMode ? 'demo' : 'live';
  const path = stateless ? '/api/copilot/query' : `/api/copilot/sessions/${await sessionId()}/messages`;
  const response = await fetch(path, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message, locale: getLang(), limit, pool_ids }) });
  if (!response.ok) {
    const error = await response.json();
    if (!stateless && [404, 409].includes(response.status) && currentEpoch === epoch) resetCopilotSession();
    throw Object.assign(new Error(error.error), { status: response.status, code: error.code });
  }
  const result = await readCopilotStream(response, (event, result) => {
    if (epoch !== currentEpoch) return;
    if (event === 'result' && result.generation === generation && result.mode === mode) onResult?.(result);
  });
  if (epoch !== currentEpoch || state.modeGeneration !== generation || result.generation !== generation || result.mode !== mode) {
    throw Object.assign(new Error('Runtime mode changed; start a new query'), { status: 409, code: 'session_mode_changed' });
  }
  return result;
}
