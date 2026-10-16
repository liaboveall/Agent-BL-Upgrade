// Calls to the agent runtime (/api/agent/*). Reads are public. Anything that changes state, and the
// approval queue, needs the admin token; it is kept for this tab only (sessionStorage, same key the
// runtime-mode switch uses) and is asked for once when the server answers 401.

import { t } from './i18n.js';

const ADMIN_TOKEN_KEY = 'agentbl.adminToken';

export function storedToken() {
  try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
}

function rememberToken(token) {
  try {
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch { /* storage unavailable: the token just is not remembered */ }
}

export class AgentApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'AgentApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function send(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { response, data };
}

/**
 * @param {string} path
 * @param {{method?: string, body?: object}} [options]
 * @returns {Promise<object>} the parsed JSON body
 */
export async function agentRequest(path, options = {}) {
  let { response, data } = await send(path, { ...options, token: storedToken() });
  if (response.status === 401 && data?.code === 'admin_token_required') {
    const entered = (window.prompt(t('ac_token_prompt')) || '').trim();
    if (!entered) throw new AgentApiError(t('ac_token_cancelled'), { status: 401, code: 'admin_token_required' });
    ({ response, data } = await send(path, { ...options, token: entered }));
    rememberToken(response.ok ? entered : '');
  }
  if (!response.ok) {
    throw new AgentApiError(data?.code === 'evidence_expired' ? t('ac_evidence_expired') : data?.error || `${path} → ${response.status}`, { status: response.status, code: data?.code, details: data?.details });
  }
  return data;
}

export const agent = {
  status: () => agentRequest('/api/agent/status'),
  scenarios: () => agentRequest('/api/agent/scenarios'),
  references: () => agentRequest('/api/agent/references'),
  runDemo: (body) => agentRequest('/api/agent/demo/run', { method: 'POST', body }),
  stopDemo: () => agentRequest('/api/agent/demo/stop', { method: 'POST', body: {} }),
  control: (body) => agentRequest('/api/agent/control', { method: 'POST', body }),
  inject: (event) => agentRequest('/api/agent/events?wait=1', { method: 'POST', body: event }),
  decisions: (query = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
    const qs = params.toString();
    return agentRequest(`/api/agent/decisions${qs ? `?${qs}` : ''}`);
  },
  decision: (id) => agentRequest(`/api/agent/decisions/${encodeURIComponent(id)}`),
  replay: (id) => agentRequest(`/api/agent/decisions/${encodeURIComponent(id)}/replay`),
  anchor: (id) => agentRequest(`/api/agent/decisions/${encodeURIComponent(id)}/anchor`),
  trace: (id) => agentRequest(`/api/agent/decisions/${encodeURIComponent(id)}/trace`),
  approvals: (status) => agentRequest(`/api/agent/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  approve: (id, note) => agentRequest(`/api/agent/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { note } }),
  reject: (id, note) => agentRequest(`/api/agent/approvals/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { note } }),
  pools: () => agentRequest('/api/agent/pools'),
  poolStatus: (poolId) => agentRequest(`/api/pool/status?pool_id=${encodeURIComponent(poolId)}`)
};

/** True only for a real https explorer link: a simulated result never gets one. */
export function safeExplorerUrl(url) {
  return typeof url === 'string' && /^https:\/\/[^\s]+$/u.test(url) ? url : null;
}
