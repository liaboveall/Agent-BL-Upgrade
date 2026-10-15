#!/usr/bin/env node
// Read-only external-agent example: MCP SDK stdio -> existing backend, plus A2A 1.0 and discovery.
// Does not load .env, submit an event, purchase a report, access a signer or start a runtime.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { httpOrigin } from '../src/interop/validation.js';

const { values } = parseArgs({ options: { url: { type: 'string' }, case: { type: 'string', default: 'CASE-EBL-2026-0001' },
  'report-id': { type: 'string', multiple: true }, output: { type: 'string' } } });
const base = httpOrigin(values.url ?? process.env.AGENTBL_MCP_API_URL ?? 'http://127.0.0.1:3000', '--url');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = { checked_at: new Date().toISOString(), backend: base, checks: [], real_transactions: 0,
  real_provider_calls: 0, report_purchases: 0, runtime_started_by_client: false, human_acceptance: false };
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); if (!passed) throw new Error(name); };
const json = async (pathname, init = {}) => {
  const response = await fetch(base + pathname, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status}`);
  return response.json();
};
const client = new Client({ name: 'agentbl-external-pricing-example', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp/standalone-server.js')], cwd: root,
  env: { NODE_TEST_CONTEXT: 'external-agent-no-dotenv', AGENTBL_MCP_API_URL: base }, stderr: 'pipe' });
try {
  const card = await json('/.well-known/agent-card.json');
  check('Agent Card supports JSONRPC / A2A 1.0', card.supportedInterfaces?.some((entry) => entry.protocolVersion === '1.0' && entry.protocolBinding === 'JSONRPC'));
  const discovery = await json('/api/x402/discovery');
  check('Four Bazaar HTTP declarations', discovery.items?.length === 4 && discovery.items.every((item) => item.extensions?.bazaar?.info?.input?.type === 'http'));
  check('Demo does not advertise a live payment scheme', discovery.mode !== 'demo' || discovery.items.every((item) => item.accepts.length === 0));
  await client.connect(transport);
  const tools = await client.listTools(), resources = await client.listResources();
  check('15 tools and 5 resources discovered over SDK stdio', tools.tools.length === 15 && resources.resources.length === 5);
  const tool = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0]?.text ?? `${name} failed`);
    return (result.structuredContent ?? JSON.parse(result.content[0].text)).result;
  };
  const status = await tool('get_agent_status');
  report.mode = status.mode;
  const policy = await client.readResource({ uri: 'agentbl://agent/policy' });
  check('Policy uses the same backend mode', JSON.parse(policy.contents[0].text).mode === status.mode);
  const input = { case_id: values.case, request_id: crypto.randomUUID(), ...(values['report-id'] ? { paid_report_ids: values['report-id'] } : {}) };
  const quote = await tool('delegate_pricing', input);
  check('MCP returns a committed, indicative quote without payment or chain execution',
    /^0x[0-9a-f]{64}$/u.test(quote.quote?.quote_hash ?? '') && quote.indicative_only === true
      && quote.authorization?.payment_executed === false && quote.authorization?.chain_action_executed === false);
  const a2a = await json('/api/a2a', { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: input.request_id, method: 'SendMessage',
      params: { message: { messageId: input.request_id, role: 'ROLE_USER', parts: [{ data: input, mediaType: 'application/json' }] } } }) });
  const delegated = a2a.result?.message?.parts?.[0]?.data;
  check('A2A and MCP commit the same quote and assessment', a2a.id === input.request_id && delegated?.result_hash === quote.result_hash);
  report.result = { case_id: quote.quote.case_id, price_usd: quote.quote.final_issue_price_usd, risk_level: quote.quote.risk_level,
    quote_hash: quote.quote.quote_hash, evidence_hash: quote.quote.evidence_hash, result_hash: quote.result_hash,
    assessment: quote.assessment.status, payment_evidence: quote.payment_evidence };
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally { await client.close().catch(() => {}); }
if (values.output) {
  await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  await fs.writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify(report, null, 2));
