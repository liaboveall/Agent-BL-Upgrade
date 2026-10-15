// Isolated WP2.4 browser harness. The Live runtime is backed by in-memory ABI fixtures, never RPC.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listenOnUsablePort } from './lib/listen.mjs';

process.env.NODE_TEST_CONTEXT = 'wp24-offline-acceptance';
process.env.DEMO_MODE = 'false';
process.env.SIGNER_KEYS_STRICT = 'true';
process.env.LLM_PROXY_ENABLED = 'false';
process.env.AGENT_VALUATION_LLM = 'false';
process.env.AGENTBL_RATE_LIMIT_PER_MIN = '0';
process.env.AGENTBL_WRITE_RATE_LIMIT_PER_MIN = '0';
process.env.AGENTBL_ADMIN_TOKEN = 'wp24-isolated-browser-fixture';
for (const key of ['DEPLOYER_PRIVATE_KEY', 'PRICING_UPDATER_PRIVATE_KEY', 'AGENT_EXECUTOR_PRIVATE_KEY', 'PAYMENT_ATTESTOR_PRIVATE_KEY']) delete process.env[key];
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-wp24-ui-'));
process.env.AGENTBL_RUNTIME_DIR = runtime;
const { createServer, setAgentService, activityLog, closeActivityStreams } = await import('../src/app/server.js');
const { createAgentService } = await import('../src/agent/runtime/factory.js');
const { storeState, resetStore } = await import('../src/app/store.js');
const { demoModeController } = await import('../src/demo/mode.js');
const { resolveOwnerStep } = await import('../src/agent/runtime/openingPlan.js');
const { openingChain, copper, chainConfig } = await import('../tests/helpers/opening.js');
let chain, service, generation = 0;
async function reset() {
  await service?.stop(); closeActivityStreams(); resetStore(); activityLog.buffer.length = 0;
  chain = openingChain(); chain.seed(copper);
  service = createAgentService({ env: { AGENT_VALUATION_LLM: 'false', AGENT_COOLDOWN_SEC: '0', AGENT_MONITOR_INTERVAL_SEC: '3600' },
    dir: path.join(runtime, String(++generation)), activity: activityLog, store: storeState, demoModeController,
    monitors: false, getChainContext: async () => chain.context, chainConfig });
  setAgentService(service); await service.start();
}
await reset();
const app = createServer();
const server = http.createServer(async (request, response) => {
  if (!request.url.startsWith('/__acceptance__/')) { app.emit('request', request, response); return; }
  try {
    if (request.headers.authorization !== `Bearer ${process.env.AGENTBL_ADMIN_TOKEN}`) { response.writeHead(401); response.end(); return; }
    let reply;
    if (request.url === '/__acceptance__/reset') { await reset(); reply = { ok: true, chain: 'in-memory-ABI-fixture' }; }
    else if (request.url === '/__acceptance__/state') reply = { sent: chain.state.sent.map((item) => item.step.method), registry: service.registry.list() };
    else if (request.url.startsWith('/__acceptance__/step/')) {
      const id = request.url.slice('/__acceptance__/step/'.length), approval = service.approvals.get(id);
      if (!approval) throw new Error('Unknown fixture approval');
      const index = approval.steps_done.length;
      const step = resolveOwnerStep(approval.plan, approval.plan.steps[index]);
      const tx = chain.send(step); reply = await service.attachTx(id, { tx_hash: tx.hash, step_index: index });
    } else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(reply));
  } catch (error) { response.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
});
const port = await listenOnUsablePort(server, '127.0.0.1');
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, mode: 'live-runtime', chain: 'in-memory-ABI-fixture', signers: 'none', runtime }));
const stop = async () => {
  closeActivityStreams(); await service.stop(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve)); await fs.rm(runtime, { recursive: true, force: true });
};
process.once('SIGINT', () => stop().then(() => process.exit(0)));
process.once('SIGTERM', () => stop().then(() => process.exit(0)));
