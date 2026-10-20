// Read-only access to the frozen v1 deployment history; no signing or runtime writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJson } from '../src/lib/jsonStore.js';

const root = path.resolve(import.meta.dirname, '..');
const sha = (value) => createHash('sha256').update(value).digest('hex');
export function deploymentCheckpoint(journalEntry, stateEntry) {
  if (journalEntry?.tx_hash && stateEntry?.tx_hash && journalEntry.tx_hash !== stateEntry.tx_hash) throw new Error('Deployment checkpoints disagree; reconcile without signing again');
  const saved = journalEntry ?? (stateEntry?.tx_hash ? stateEntry : null);
  if (saved && !/^0x[a-fA-F0-9]{64}$/u.test(saved.tx_hash ?? '')) throw new Error('Deployment broadcast checkpoint is incomplete; reconcile without signing again');
  return saved;
}
export async function loadDeploymentContinuation({ stateFile, evidenceFile, baselineFile, initialized }) {
  for (const file of [...new Set([stateFile, evidenceFile, baselineFile].filter(Boolean))]) {
    const state = await readJson(file);
    if (!state) continue;
    if (state.schema !== 'agentbl-w5-testnet-deployment-v1' || state.chain_id !== 1439
      || !Array.isArray(state.transactions) || !state.contracts || !state.actors) throw new Error('Invalid deployment history; reconcile before another transaction');
    return { state, from: file, sha256: sha(await fs.readFile(file)) };
  }
  if (initialized) throw new Error('Initialized deployment history is missing; restore it before another transaction');
  return null;
}
export async function runDeployment(action) {
  if (action !== 'status') throw new Error('The v1 deployment is exit-only; only status is available');
  const directory = path.join(root, 'data/runtime/w5-deployment');
  const previous = await loadDeploymentContinuation({
    stateFile: path.join(directory, 'deployment-state.json'),
    baselineFile: path.join(root, 'scripts/config/testnet-deployment-baseline.json'),
    initialized: Boolean(await readJson(path.join(directory, 'deployment-initialized.json')))
  });
  if (!previous) throw new Error('Legacy deployment history is missing');
  const { state } = previous;
  console.log(JSON.stringify({ action, prepared: Boolean(state.prepared_at), ready_after: state.ready_after,
    activated: Boolean(state.activated_at), contracts: state.contracts, transactions: state.transactions.length }));
  return state;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runDeployment(process.argv[2]?.replace(/^--/u, '')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
