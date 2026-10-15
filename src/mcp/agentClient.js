import { HttpError } from '../app/http.js';
import { httpOrigin } from '../interop/validation.js';

// Stdio is a client of the existing application runtime. It never creates a second scheduler,
// opens private runtime files, loads .env, resolves signers, or accepts a caller-supplied URL.
export async function callAgentBackend(tool, params = {}, { env = process.env, fetchImpl = fetch } = {}) {
  const base = httpOrigin(env.AGENTBL_MCP_API_URL || 'http://127.0.0.1:3000', 'AGENTBL_MCP_API_URL');
  let response;
  try {
    response = await fetchImpl(`${base}${tool === 'get_agent_policy' ? '/api/agent/policy' : '/api/mcp/call'}`, {
      method: tool === 'get_agent_policy' ? 'GET' : 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(tool !== 'get_agent_policy' ? { body: JSON.stringify({ tool, params }) } : {}), redirect: 'error', signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new HttpError(503, 'agent_backend_unavailable', 'AgentBL backend is unavailable; start the application and configure AGENTBL_MCP_API_URL');
  }
  // Bound the entire streamed response, including a response with a dishonest Content-Length.
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4_194_304) throw new Error('response limit');
      chunks.push(Buffer.from(value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok || body.ok !== true) throw new HttpError(response.status >= 400 ? response.status : 400,
      body.code ?? 'agent_backend_error', body.error ?? 'AgentBL backend rejected the tool call');
    return tool === 'get_agent_policy' ? { result: body.policy } : { tool: body.tool, result: body.result };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'invalid_backend_response', 'AgentBL backend returned an invalid or oversized response');
  } finally { await reader.cancel().catch(() => {}); }
}
