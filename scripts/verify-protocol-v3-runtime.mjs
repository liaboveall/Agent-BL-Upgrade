// Start the active protocol's observer with no signer keys and isolated temporary state.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createAgentService, loadChainConfig } from '../src/agent/runtime/factory.js';
import { createChainContext } from '../src/agent/runtime/executors/chainExecutor.js';

const { values } = parseArgs({ options: { report: { type: 'string' } } });
const config = loadChainConfig();
if (config?.protocolVersion !== 3) throw new Error('The active configuration is not protocol v3');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-v3-readonly-'));
const context = await createChainContext({ chainConfig: config, env: {}, readOnly: true });
const send = context.provider.send.bind(context.provider);
context.provider.send = (method, params) => {
  if (/^eth_(?:send|sign)/u.test(method)) throw new Error('Writes are forbidden in runtime verification');
  return send(method, params);
};
const service = createAgentService({ dir, chainConfig: config, getMode: () => 'live', getGeneration: () => 1,
  getChainContext: async () => context, getWatcherContext: async () => context, monitors: true, sources: [],
  store: { pools: new Map(), investments: [], agentActivities: [] }, env: { AGENT_AUTONOMY: 'observe', AGENT_VALUATION_LLM: 'false',
    AGENT_DOCUMENT_LLM: 'false', AGENT_ANCHOR_ENABLED: 'false', REAL_DATA: 'off' } });
try {
  await service.start();
  const status = await service.status(), watcher = service.chainWatcher.status();
  if (watcher.state !== 'healthy' || watcher.stale) throw new Error(`Watcher is not current: ${JSON.stringify(watcher.last_error)}`);
  if (service.registry.list().length || service.approvals.list().length || Object.keys(context.signers).length) throw new Error('Legacy state or a signer appeared in the empty v3 observer');
  const report = { schema: 'agentbl-v3-live-readonly-startup-v1', checked_at: new Date().toISOString(), status: 'PASS',
    protocol_version: config.protocolVersion, contracts: config.contracts, mode: status.mode, autonomy: status.autonomy,
    registry_file: service.registry.file, mappings: [], pending_approvals: 0, watcher, signers: context.signers, chain_writes: 0 };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.report) await fs.writeFile(values.report, json, { flag: 'wx' });
  console.log(json);
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  await service.stop(); context.provider.destroy(); await fs.rm(dir, { recursive: true, force: true });
}
