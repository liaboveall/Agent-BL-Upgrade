import fs from 'node:fs/promises';
import path from 'node:path';
import { OperationsMonitor } from './monitor.js';
import { readJson, writeJsonAtomic } from '../lib/jsonStore.js';
import { rightsKey, unseal } from '../rights/vault.js';
import { loadRightsChain } from '../rights/chain.js';

/** Read-only verification. No key generation, charging, transaction signing or automatic repair. */
export async function verifyRuntimeMaterials(directory, env = {}) {
  const key = rightsKey(env); let checked = 0;
  const inventoryFile = path.join(directory, 'ops-required-history.json'), inventory = await readJson(inventoryFile, { files: [] });
  if (!Array.isArray(inventory.files)) throw new Error('Invalid initialized history inventory');
  for (const file of inventory.files) {
    if (typeof file !== 'string' || file.includes('..') || file.includes('\\') || path.isAbsolute(file)) throw new Error('Invalid required history path');
    await fs.access(path.join(directory, file));
  }
  const required = new Set(inventory.files), remember = (...files) => files.forEach((file) => required.add(path.relative(directory, file).replaceAll('\\', '/')));
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in runtime');
      if (entry.isDirectory() && !/^(?:writer|dead-writer|\.runtime|\.abandoned)/u.test(entry.name)) await walk(file);
      if (!entry.isFile()) continue;
      if (['cash-entries.jsonl', 'intents.jsonl', 'agent-decisions.json', 'decisions.json', 'agent-anchors.json', 'anchors.json', 'agent-approvals.json'].includes(entry.name)
        || entry.name.endsWith('.key')) remember(file);
      if (entry.name.endsWith('.initialized')) { await fs.access(file.slice(0, -'.initialized'.length)); remember(file, file.slice(0, -'.initialized'.length)); checked++; }
      if (entry.name === 'vault-initialized.json') {
        const stored = await readJson(path.join(dir, 'vault.json')); if (!stored || !key) throw new Error('Initialized vault unavailable');
        unseal(key, stored, 'agentbl-rights-vault-v1'); checked++;
        remember(file, path.join(dir, 'vault.json'));
      }
      if (entry.name === 'initialized.json') {
        const marker = await readJson(file);
        const known = { 'agentbl-decision-evidence-archive-v1': ['archive.json', 'agentbl-decision-evidence-archive-v1'],
          'agentbl-x402-client-recovery-v1': ['payments.json', 'agentbl-x402-client-recovery-v1'] };
        const expected = known[marker?.schema];
        if (expected) {
          const stored = await readJson(path.join(dir, expected[0])); if (!stored || !key) throw new Error('Initialized private history unavailable');
          unseal(key, stored, expected[1]); checked++;
          remember(file, path.join(dir, expected[0]));
        }
      }
    }
  };
  await walk(directory);
  if (required.size !== inventory.files.length) await writeJsonAtomic(inventoryFile, { schema: 'agentbl-required-history-v1', files: [...required].sort() }, { durable: true });
  return { initialized_stores_verified: checked, key_configured: Boolean(key) };
}
export function createRuntimeMonitor({ directory, env, getAgentStatus, getCapitalHealth = null }) {
  let chain = null;
  const monitor = new OperationsMonitor({ directory, env, getAgentStatus,
    probeMaterials: () => verifyRuntimeMaterials(directory, env),
    probeControls: async () => {
      if (!env.AGENTBL_RIGHTS_CONFIG) return { enabled: false };
      chain ??= await loadRightsChain(env.AGENTBL_RIGHTS_CONFIG);
      try { return { enabled: true, ...await chain.verify(), intake_stopped: await chain.controller.intakeStopped(),
        ...(getCapitalHealth ? await getCapitalHealth() : {}) }; }
      catch (error) { await chain.provider.destroy(); chain = null; throw error; }
    },
    alertSink: env.AGENTBL_ALERT_WEBHOOK ? async (alert) => {
      const response = await fetch(env.AGENTBL_ALERT_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json',
        ...(env.AGENTBL_ALERT_TOKEN ? { authorization: `Bearer ${env.AGENTBL_ALERT_TOKEN}` } : {}) }, body: JSON.stringify(alert), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Operator alert receiver rejected delivery');
    } : null });
  const stop = monitor.stop.bind(monitor);
  monitor.stop = async () => { await stop(); await chain?.provider.destroy(); };
  return monitor;
}
