// Isolated offline UI acceptance. The vision response is a FIXTURE, never a measured model result.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pdfFixture, TINY_PNG } from '../tests/helpers/pdf.js';
import { listenOnUsablePort } from './lib/listen.mjs';

process.env.NODE_TEST_CONTEXT = 'wp22-offline-acceptance';
process.env.DEMO_MODE = 'true';
process.env.LLM_PROXY_ENABLED = 'false';
process.env.AGENT_VALUATION_LLM = 'false';
process.env.AGENTBL_RATE_LIMIT_PER_MIN = '0';
process.env.AGENTBL_WRITE_RATE_LIMIT_PER_MIN = '0';
delete process.env.AGENTBL_ADMIN_TOKEN;
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-wp22-ui-'));
process.env.AGENTBL_RUNTIME_DIR = runtime;

const { createServer, setAgentService, activityLog, closeActivityStreams } = await import('../src/app/server.js');
const { createAgentService } = await import('../src/agent/runtime/factory.js');
const { storeState } = await import('../src/app/store.js');
const { demoModeController } = await import('../src/demo/mode.js');
const fixtureDir = path.resolve('.playwright-cli/wp22-fixtures');
await fs.mkdir(fixtureDir, { recursive: true });
const names = ['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md'];
const texts = await Promise.all(names.map((name) => fs.readFile(new URL(`../data/uploads/copper-sg-shanghai/${name}`, import.meta.url), 'utf8')));
for (const [index, name] of names.entries()) {
  await fs.writeFile(path.join(fixtureDir, name.replace('.md', '.pdf')), pdfFixture(index === 1 ? ['Commercial Invoice\nSynthetic acceptance cover', texts[index]] : [texts[index]]));
}
await fs.writeFile(path.join(fixtureDir, 'scan.pdf'), pdfFixture([''], { imageOnly: true }));
await fs.writeFile(path.join(fixtureDir, 'incomplete-invoice.pdf'), pdfFixture([texts[1].replace('**Invoice Date**', '**Issue Date**')]));
await fs.writeFile(path.join(fixtureDir, 'invoice.png'), TINY_PNG);
const env = { AGENT_VALUATION_LLM: 'false', AGENT_VISION_ENABLED: 'true', AGENT_DOCUMENT_LLM: 'false',
  LLM_BASE_URL: 'http://127.0.0.1:1', LLM_API_KEY: 'offline-fixture-only', LLM_MODEL: 'x-test-2' };
const service = createAgentService({ env, dir: runtime, activity: activityLog, store: storeState,
  demoModeController, monitors: false, getChainContext: async () => null,
  documentCompletion: async () => ({ content: JSON.stringify({ document_type: 'COMMERCIAL_INVOICE', text: texts[1], fields: [] }) }) });
setAgentService(service); await service.start();
const server = createServer();
const port = await listenOnUsablePort(server, '127.0.0.1');
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, mode: 'demo', vision: 'mock-fixture', runtime, fixtures: fixtureDir }));
const stop = async () => {
  closeActivityStreams(); await service.stop(); server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve)); await fs.rm(runtime, { recursive: true, force: true });
};
process.once('SIGINT', () => stop().then(() => process.exit(0)));
process.once('SIGTERM', () => stop().then(() => process.exit(0)));
