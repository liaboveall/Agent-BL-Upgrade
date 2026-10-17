// An isolated, offline Demo process for browser regression. Never reads the developer's .env.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
process.env.NODE_TEST_CONTEXT = 'browser';
process.env.DEMO_MODE = 'true'; process.env.X402_MODE = 'demo'; process.env.REAL_DATA = 'off';
process.env.AGENT_ANCHOR_ENABLED = 'false'; process.env.AGENT_CHAIN_WATCHER_ENABLED = 'false';
process.env.AGENT_VALUATION_LLM = 'false'; process.env.AGENT_DOCUMENT_LLM = 'false';
process.env.AGENTBL_RATE_LIMIT_PER_MIN = '0'; process.env.AGENTBL_WRITE_RATE_LIMIT_PER_MIN = '0';
process.env.AGENTBL_RUNTIME_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-browser-'));
const { createServer, getAgentService, closeActivityStreams } = await import('../src/app/server.js');
const server = createServer();
const service = getAgentService(); await service.start();
server.listen(Number(process.env.AGENTBL_BROWSER_PORT ?? 4187), '127.0.0.1');
const stop = async () => {
  closeActivityStreams(); await service.stop(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(process.env.AGENTBL_RUNTIME_DIR, { recursive: true, force: true }); process.exit(0);
};
process.on('SIGTERM', stop); process.on('SIGINT', stop);
