// WP2.6 isolation: Live runtime, ABI-encoded memory receipts, no keys or external transport.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listenOnUsablePort } from './lib/listen.mjs';

process.env.NODE_TEST_CONTEXT = 'wp26-offline-acceptance';
process.env.DEMO_MODE = 'false'; process.env.SIGNER_KEYS_STRICT = 'true'; process.env.LLM_PROXY_ENABLED = 'false';
process.env.AGENT_VALUATION_LLM = 'false'; process.env.AGENTBL_RATE_LIMIT_PER_MIN = '0'; process.env.AGENTBL_WRITE_RATE_LIMIT_PER_MIN = '0';
process.env.AGENTBL_ADMIN_TOKEN = 'wp26-isolated-browser-fixture';
for (const name of ['DEPLOYER_PRIVATE_KEY', 'PRICING_UPDATER_PRIVATE_KEY', 'AGENT_EXECUTOR_PRIVATE_KEY', 'PAYMENT_ATTESTOR_PRIVATE_KEY']) delete process.env[name];
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-wp26-ui-')); process.env.AGENTBL_RUNTIME_DIR = runtime;
const { createServer, setAgentService, activityLog, closeActivityStreams } = await import('../src/app/server.js');
const { createAgentService } = await import('../src/agent/runtime/factory.js');
const { createChainReader } = await import('../src/agent/runtime/poolRegistry.js');
const { createPool, storeState, resetStore } = await import('../src/app/store.js');
const { quoteFromCase } = await import('../src/core/pricingEngine.js');
const { demoModeController } = await import('../src/demo/mode.js');
const { settlementChain, chainConfig, oil, RECIPIENT, paymentHash } = await import('../tests/helpers/settlement.js');
let chain, service, generation = 0;
async function reset({ recipient = true } = {}) {
  await service?.stop(); closeActivityStreams(); resetStore(); activityLog.buffer.length = 0;
  chain = settlementChain(); chain.payment(); createPool(oil.case_id, oil, quoteFromCase(oil));
  service = createAgentService({ env: { AGENT_SETTLEMENT_RECIPIENT: recipient ? RECIPIENT : '', AGENT_VALUATION_LLM: 'false', AGENT_COOLDOWN_SEC: '0', AGENT_MONITOR_INTERVAL_SEC: '3600' },
    dir: path.join(runtime, String(++generation)), activity: activityLog, store: storeState, demoModeController,
    monitors: false, getChainContext: async () => chain.context, chainConfig });
  await service.init(); await service.registry.linkChain({ case_id: oil.case_id, chain_pool_id: 11, ebl_id: 7 }, createChainReader(chain.context));
  setAgentService(service); await service.start();
}
await reset(); const app = createServer();
const server = http.createServer(async (request, response) => {
  if (!request.url.startsWith('/__acceptance__/')) { app.emit('request', request, response); return; }
  try {
    if (request.headers.authorization !== `Bearer ${process.env.AGENTBL_ADMIN_TOKEN}`) { response.writeHead(401); response.end(); return; }
    const url = new URL(request.url, 'http://fixture.local'); let reply;
    if (url.pathname === '/__acceptance__/reset') { await reset({ recipient: url.searchParams.get('recipient') !== 'missing' }); reply = { ok: true }; }
    else if (url.pathname === '/__acceptance__/state') reply = { chain: 'in-memory-ABI-fixture', payment_hash: paymentHash,
      recipient: RECIPIENT, sent: chain.state.sent.map((item) => item.step.method), state: chain.pools.get(11).state };
    else if (url.pathname.startsWith('/__acceptance__/step/')) {
      const id = url.pathname.slice('/__acceptance__/step/'.length), approval = service.approvals.get(id);
      if (!approval) throw new Error('Unknown fixture approval');
      const tx = chain.send(approval.plan.steps[0]); reply = await service.attachTx(id, { tx_hash: tx.hash }); await service.bus.idle();
    } else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(reply));
  } catch (error) { response.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
});
const port = await listenOnUsablePort(server, '0.0.0.0');
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, mode: 'live-runtime', chain: 'in-memory-ABI-fixture', signers: 'none', runtime }));
const stop = async () => {
  closeActivityStreams(); await service.stop(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve)); await fs.rm(runtime, { recursive: true, force: true });
};
process.once('SIGINT', () => stop().then(() => process.exit(0))); process.once('SIGTERM', () => stop().then(() => process.exit(0)));
