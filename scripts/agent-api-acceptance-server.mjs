// Local-only WP2.9 harness. The only LLM upstream is a loopback fixture, with no real key/RPC.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listenOnUsablePort } from './lib/listen.mjs';

process.env.NODE_TEST_CONTEXT = 'wp29-offline-browser';
for (const name of Object.keys(process.env)) {
  if (/PRIVATE_KEY|API_KEY|^LLM_|^X402_|^Tencent_|^Ali_|^DASHSCOPE_|^AZURE_OPENAI_|^AGENTBL_ADMIN_TOKEN$/u.test(name)) delete process.env[name];
}
Object.assign(process.env, { DEMO_MODE: 'true', AGENT_ENABLED: 'false', AGENT_VALUATION_LLM: 'false', AGENT_DOCUMENT_LLM: 'false',
  AGENT_VISION_ENABLED: 'false', AGENTBL_RATE_LIMIT_PER_MIN: '0', AGENTBL_WRITE_RATE_LIMIT_PER_MIN: '0',
  AGENT_API_RATE_LIMIT_PER_MIN: '0', LLM_RATE_LIMIT_PER_MIN: '0', LLM_MODEL: 'x-test-2', LLM_API_KEY: 'local-fixture-only' });
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-wp29-browser-'));
process.env.AGENTBL_RUNTIME_DIR = runtime;
const calls = [];
const upstream = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls.push({ model: body.model, stream: Boolean(body.stream), tools: Boolean(body.tools?.length) });
  response.writeHead(body.model === 'x-test-2' ? 200 : 400, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Local model fixture.' } }] }));
});
process.env.LLM_BASE_URL = `http://127.0.0.1:${await listenOnUsablePort(upstream, '127.0.0.1')}/v1`;
const { createServer, setAgentService, activityLog, closeActivityStreams } = await import('../src/app/server.js');
const { createAgentService } = await import('../src/agent/runtime/factory.js');
const { storeState } = await import('../src/app/store.js');
const { demoModeController } = await import('../src/demo/mode.js');
const service = createAgentService({ env: process.env, store: storeState, activity: activityLog,
  demoModeController, getChainContext: async () => null, monitors: false, sources: [] });
setAgentService(service);
const fixtures = {
  case_data: JSON.parse(await fs.readFile(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url), 'utf8')),
  documents: await Promise.all(['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md'].map(async (name) => ({ name,
    mime_type: 'text/markdown', text: await fs.readFile(new URL(`../data/uploads/copper-sg-shanghai/${name}`, import.meta.url), 'utf8') })))
};
const app = createServer();
const server = http.createServer(async (request, response) => {
  if (!request.url.startsWith('/__acceptance__/')) { app.emit('request', request, response); return; }
  const url = new URL(request.url, 'http://fixture.local');
  if (url.pathname === '/__acceptance__/mode') {
    demoModeController.mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(url.pathname === '/__acceptance__/fixtures' ? fixtures : {
    mode: demoModeController.mode, calls, model: 'x-test-2', real_provider_calls: 0, real_transactions: 0,
    jobs: service.ingest.jobs.size, approvals: service.approvals.list().length,
    decisions: (await service.listDecisions({ limit: 100 })).count
  }));
});
const port = await listenOnUsablePort(server, '0.0.0.0');
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, model: 'x-test-2', real_provider_calls: 0, real_transactions: 0 }));
const stop = async () => {
  closeActivityStreams(); await service.stop();
  server.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
  await fs.rm(runtime, { recursive: true, force: true });
};
process.once('SIGINT', () => stop().then(() => process.exit(0)));
process.once('SIGTERM', () => stop().then(() => process.exit(0)));
