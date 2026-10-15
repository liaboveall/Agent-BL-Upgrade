// Isolated WP2.7 Live UI harness: real ABIs, local memory provider, no keys or external RPC.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listenOnUsablePort } from './lib/listen.mjs';

process.env.NODE_TEST_CONTEXT = 'wp27-offline-acceptance';
process.env.DEMO_MODE = 'false'; process.env.SIGNER_KEYS_STRICT = 'true'; process.env.LLM_PROXY_ENABLED = 'false';
process.env.AGENTBL_ADMIN_TOKEN = 'wp27-isolated-browser-fixture';
process.env.AGENTBL_RATE_LIMIT_PER_MIN = '0'; process.env.AGENTBL_WRITE_RATE_LIMIT_PER_MIN = '0';
for (const name of ['DEPLOYER_PRIVATE_KEY', 'PRICING_UPDATER_PRIVATE_KEY', 'AGENT_EXECUTOR_PRIVATE_KEY', 'PAYMENT_ATTESTOR_PRIVATE_KEY']) delete process.env[name];
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-wp27-ui-'));
process.env.AGENTBL_RUNTIME_DIR = runtime;
const { createServer, setAgentService, activityLog, closeActivityStreams } = await import('../src/app/server.js');
const { createAgentService } = await import('../src/agent/runtime/factory.js');
const { ChainWatcher } = await import('../src/agent/runtime/sources/chainWatcher.js');
const { watcherChain, oil, copper, hash } = await import('../tests/helpers/chainWatcher.js');
const { createPool, storeState, resetStore } = await import('../src/app/store.js');
const { quoteFromCase } = await import('../src/core/pricingEngine.js');
const { demoModeController } = await import('../src/demo/mode.js');
let chain, service, watcher, run = 0, nowMs;
const created = (id, height, index = 0) => {
  const p = chain.state.pools.get(id);
  return chain.log('OfferingCreated', [id, p.eblId, p.tokenSupply, p.issuePrice, p.targetRedemptionValue], { height, index });
};
async function reset() {
  await service?.stop(); closeActivityStreams(); resetStore(); activityLog.buffer.length = 0;
  chain = watcherChain(); nowMs = Date.now(); demoModeController.mode = 'live'; demoModeController.generation++;
  createPool(copper.case_id, structuredClone(copper), quoteFromCase(copper));
  createPool(oil.case_id, structuredClone(oil), quoteFromCase(oil));
  chain.state.logs = [created(11, 105)];
  const dir = path.join(runtime, String(++run));
  watcher = new ChainWatcher({ file: path.join(dir, 'agent-chain-cursor.json'), chainConfig: chain.chainConfig,
    getContext: async () => chain.context, pollSec: 3600, now: () => new Date(nowMs) });
  service = createAgentService({ dir, env: { AGENT_VALUATION_LLM: 'false', AGENT_MONITOR_INTERVAL_SEC: '3600' },
    store: storeState, activity: activityLog, demoModeController, chainConfig: chain.chainConfig,
    getChainContext: async () => chain.context, monitors: false, sources: [], chainWatcher: watcher });
  setAgentService(service); await service.start(); await service.bus.idle();
}
await reset();
const app = createServer();
const server = http.createServer(async (request, response) => {
  if (!request.url.startsWith('/__acceptance__/')) { app.emit('request', request, response); return; }
  try {
    if (request.headers.authorization !== `Bearer ${process.env.AGENTBL_ADMIN_TOKEN}`) { response.writeHead(401); response.end(); return; }
    const url = new URL(request.url, 'http://fixture.local');
    if (url.pathname === '/__acceptance__/reset') await reset();
    else if (url.pathname === '/__acceptance__/change') {
      const change = url.searchParams.get('kind');
      if (change === 'demo' || change === 'live') {
        demoModeController.mode = change; demoModeController.generation++; await service.onModeChanged();
      } else {
        chain.state.latest++;
        const height = chain.state.latest;
        if (change === 'reprice') {
          chain.state.pools.get(11).issuePrice = 777000n; chain.state.pools.get(11).state = 6;
          chain.state.logs.push(chain.log('OfferingRepriced', [11, 800000n, 777000n, hash(7), hash(8)], { height }));
        } else if (change === 'unknown') {
          chain.addPool(12, oil, { cargoHash: hash(7654321) }); chain.state.logs.push(created(12, height));
        } else if (change === 'stop' || change === 'release') {
          chain.state.headStop = change === 'stop'; chain.state.confirmedStop = change === 'stop';
          chain.state.logs.push(chain.log('EmergencyStopSet', [change === 'stop', '0x1111111111111111111111111111111111111111', hash(3)], { height }));
        } else if (change === 'rpc-failure') chain.state.failLogs = true;
        else if (change === 'recover') { chain.state.failLogs = false; nowMs += 4_000_000; }
        else if (change === 'reorg') chain.state.blockOverrides.set(watcher.saved.last_block, hash(9999999));
        else throw new Error('Unknown fixture change');
        await watcher.poll(service); await service.bus.idle();
      }
    } else if (url.pathname !== '/__acceptance__/state') { response.writeHead(404); response.end(); return; }
    const pools = [...storeState.pools.values()].map((p) => ({ pool_id: p.poolId, status: p.status, chain_only: Boolean(p.chainOnly),
      chain_price_usd: p.chainIssuePriceUsd ?? null, issue_price_atomic: p.chainSnapshot?.issue_price_atomic ?? null, quote_mismatch: Boolean(p.chainQuoteMismatch) }));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ chain: 'in-memory-ABI-fixture', mode: demoModeController.mode, real_transactions: 0,
      rpc_calls: chain.state.calls.length, cursor: watcher.saved?.next_block ?? null, pools, status: await service.status() }));
  } catch (error) { response.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
});
const port = await listenOnUsablePort(server, '0.0.0.0');
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, mode: 'live-runtime', chain: 'in-memory-ABI-fixture', runtime }));
const stop = async () => {
  closeActivityStreams(); await service.stop(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve)); await fs.rm(runtime, { recursive: true, force: true });
};
process.once('SIGINT', () => stop().then(() => process.exit(0))); process.once('SIGTERM', () => stop().then(() => process.exit(0)));
