// Isolated local harness: fixture files, simulated executor, temporary persistence, no external calls.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listenOnUsablePort } from './lib/listen.mjs';

process.env.NODE_TEST_CONTEXT = 'phase4-offline-browser';
for (const name of Object.keys(process.env)) {
  if (/PRIVATE_KEY|API_KEY|^LLM_|^X402_|^Tencent_|^Ali_|^DASHSCOPE_|^AZURE_OPENAI_|^AGENTBL_ADMIN_TOKEN$/u.test(name)) delete process.env[name];
}
Object.assign(process.env, { DEMO_MODE: 'true', AGENT_VALUATION_LLM: 'false', AGENT_DOCUMENT_LLM: 'false', AGENT_VISION_ENABLED: 'false',
  AGENTBL_RATE_LIMIT_PER_MIN: '0', AGENTBL_WRITE_RATE_LIMIT_PER_MIN: '0' });
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-phase4-browser-'));
process.env.AGENTBL_RUNTIME_DIR = runtime;
const { createServer, setAgentService, activityLog, closeActivityStreams } = await import('../src/app/server.js');
const { createAgentService } = await import('../src/agent/runtime/factory.js');
const { storeState, createPool } = await import('../src/app/store.js');
const { quoteFromCase } = await import('../src/core/pricingEngine.js');
const { createPaidReportEnvelope } = await import('../src/x402/paidReport.js');
const { demoModeController } = await import('../src/demo/mode.js');
const cases = await Promise.all((await fs.readdir(new URL('../data/cases/', import.meta.url))).filter((name) => name.endsWith('.case.json')).map(async (name) =>
  JSON.parse(await fs.readFile(new URL(`../data/cases/${name}`, import.meta.url), 'utf8'))));
const ensurePools = async () => {
  for (const data of cases) if (!storeState.pools.has(data.case_id)) createPool(data.case_id, data, quoteFromCase(data, { payout_speed: 'BALANCED' }));
};
const service = createAgentService({ env: process.env, dir: runtime, activity: activityLog, store: storeState,
  demoModeController, ensurePools, monitors: false, getChainContext: async () => null });
setAgentService(service); await service.start();
const app = createServer();
const server = http.createServer(async (request, response) => {
  if (!request.url.startsWith('/__phase4__/')) { app.emit('request', request, response); return; }
  try {
    const url = new URL(request.url, 'http://fixture.local');
    let data = {};
    if (url.pathname === '/__phase4__/report' && request.method === 'POST') {
      const pool = storeState.pools.get('CASE-EBL-2026-CU-SG-SHA');
      const now = new Date();
      const envelope = createPaidReportEnvelope({ kind: 'risk-intelligence', case_id: pool.poolId,
        payer: `0x${'11'.repeat(20)}`, payee: `0x${'22'.repeat(20)}`, network: 'eip155:1439',
        asset: `0x${'33'.repeat(20)}`, amount: '1000', payment_tx: `demo://receipt/${'ab'.repeat(32)}`,
        settled_at: now.toISOString(), data_snapshot: { note: 'Local Demo report fixture' },
        model_provider: 'deterministic-local-fixture', evidence_hash: `0x${'cd'.repeat(32)}` }, { now, ttlSeconds: 3600 });
      pool.quote = quoteFromCase(pool.caseData, { payout_speed: 'BALANCED', paid_report_envelope: envelope, paid_report_now: now });
      const accepted = await service.submitEvent({ type: 'INSURANCE_EXPIRING', source: 'admin',
        event_id: `browser-report:${demoModeController.generation}`, case_id: pool.poolId, data: { days_left: 5 } });
      const settled = await service.waitFor(accepted.idempotency_key);
      data = { decision: await service.getDecision(settled.result.decisions[0]), envelope };
    } else if (url.pathname === '/__phase4__/mode' && request.method === 'POST') {
      demoModeController.mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
      demoModeController.generation += 1; await service.onModeChanged();
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ...data, mode: service.getMode(), real_transactions: 0, real_provider_calls: 0 }));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message }));
  }
});
const port = await listenOnUsablePort(server, '0.0.0.0');
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, mode: 'demo', real_transactions: 0, real_provider_calls: 0 }));
const stop = async () => {
  closeActivityStreams(); await service.stop(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve)); await fs.rm(runtime, { recursive: true, force: true });
};
process.once('SIGINT', () => stop().then(() => process.exit(0)));
process.once('SIGTERM', () => stop().then(() => process.exit(0)));
