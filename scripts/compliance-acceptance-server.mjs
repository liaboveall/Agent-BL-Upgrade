// Isolated WP2.3 acceptance: no dotenv, provider, chain context, signer or background monitor.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listenOnUsablePort } from './lib/listen.mjs';

process.env.NODE_TEST_CONTEXT = 'wp23-offline-acceptance';
process.env.DEMO_MODE = 'true';
process.env.LLM_PROXY_ENABLED = 'false';
process.env.AGENT_VALUATION_LLM = 'false';
process.env.AGENTBL_RATE_LIMIT_PER_MIN = '0';
process.env.AGENTBL_WRITE_RATE_LIMIT_PER_MIN = '0';
delete process.env.AGENTBL_ADMIN_TOKEN;
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-wp23-ui-'));
process.env.AGENTBL_RUNTIME_DIR = runtime;
const { createServer, setAgentService, activityLog, closeActivityStreams } = await import('../src/app/server.js');
const { createAgentService } = await import('../src/agent/runtime/factory.js');
const { storeState } = await import('../src/app/store.js');
const { demoModeController } = await import('../src/demo/mode.js');
const service = createAgentService({ env: {}, dir: runtime, activity: activityLog, store: storeState,
  demoModeController, monitors: false, getChainContext: async () => null });
setAgentService(service); await service.start();
const server = createServer();
const port = await listenOnUsablePort(server, '127.0.0.1');
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, mode: 'demo', external_screening: 'disabled', runtime }));
const stop = async () => {
  closeActivityStreams(); await service.stop(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve)); await fs.rm(runtime, { recursive: true, force: true });
};
process.once('SIGINT', () => stop().then(() => process.exit(0)));
process.once('SIGTERM', () => stop().then(() => process.exit(0)));
