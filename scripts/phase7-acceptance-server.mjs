import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listenOnUsablePort } from './lib/listen.mjs';

process.env.NODE_TEST_CONTEXT = 'phase7-offline-browser';
for (const name of Object.keys(process.env)) if (/PRIVATE_KEY|API_KEY|^LLM_|^X402_|^Tencent_|^Ali_|^DASHSCOPE_|^AZURE_OPENAI_|^AGENTBL_ADMIN_TOKEN$/u.test(name)) delete process.env[name];
Object.assign(process.env, { DEMO_MODE: 'true', AGENT_VALUATION_LLM: 'false', AGENT_DOCUMENT_LLM: 'false', AGENT_VISION_ENABLED: 'false',
  AGENT_ANCHOR_ENABLED: 'false', AGENT_ANCHOR_INTERVAL_SEC: '1', AGENT_ANCHOR_MIN_BATCH: '1',
  AGENTBL_RATE_LIMIT_PER_MIN: '0', AGENTBL_WRITE_RATE_LIMIT_PER_MIN: '0' });
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-phase7-browser-'));
process.env.AGENTBL_RUNTIME_DIR = dir;
const { createServer, setAgentService, activityLog, closeActivityStreams } = await import('../src/app/server.js');
const { createAgentService } = await import('../src/agent/runtime/factory.js');
const { storeState, createPool } = await import('../src/app/store.js');
const { quoteFromCase } = await import('../src/core/pricingEngine.js');
const { demoModeController } = await import('../src/demo/mode.js');
const cases = await Promise.all((await fs.readdir(new URL('../data/cases/', import.meta.url))).filter((name) => name.endsWith('.case.json'))
  .map(async (name) => JSON.parse(await fs.readFile(new URL(`../data/cases/${name}`, import.meta.url), 'utf8'))));
const ensurePools = async () => {
  for (const data of cases) if (!storeState.pools.has(data.case_id)) createPool(data.case_id, data, quoteFromCase(data, { payout_speed: 'BALANCED' }));
};
const service = createAgentService({ env: process.env, dir, activity: activityLog, store: storeState,
  demoModeController, ensurePools, monitors: false, chainConfig: null, getChainContext: async () => null });
setAgentService(service); await service.start();
const app = createServer();
const server = http.createServer(async (request, response) => {
  if (!request.url.startsWith('/__phase7__/')) { app.emit('request', request, response); return; }
  try {
    const url = new URL(request.url, 'http://fixture.local');
    if (url.pathname === '/__phase7__/tamper' && request.method === 'POST') {
      await service.logger.update(url.searchParams.get('id'), { evidence_hash: `0x${'ef'.repeat(32)}` });
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ real_transactions: 0, real_provider_calls: 0 }));
  } catch { response.writeHead(500); response.end(JSON.stringify({ error: 'fixture_failed' })); }
});
const port = await listenOnUsablePort(server, '0.0.0.0');
console.log(JSON.stringify({ phase: 7, url: `http://127.0.0.1:${port}`, pid: process.pid, mode: 'isolated-demo', real_transactions: 0, real_provider_calls: 0 }));
const stop = async () => {
  closeActivityStreams(); await service.stop(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true });
};
process.once('SIGINT', () => stop().then(() => process.exit(0)));
process.once('SIGTERM', () => stop().then(() => process.exit(0)));
