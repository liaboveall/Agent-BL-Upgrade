import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRuntimeBackup } from '../src/ops/backup.js';
import { verifyRuntimeMaterials } from '../src/ops/runtime.js';
import { Ledger } from '../src/ledger/ledger.js';
import { hashSnapshot } from '../src/agent/decisionLogger.js';
import { readJson, writeJsonAtomic } from '../src/lib/jsonStore.js';
import { releaseRoot } from './lib/release-source.mjs';

const repo = 'liaboveall/Agent-BL-Upgrade', mode = process.argv[2], keyDirectory = process.env.AGENTBL_W5_KEY_DIR || path.join(os.homedir(), '.agentbl/w5-2026-10-18');
const privateStateFile = path.join(keyDirectory, 'remote-recovery-control.json');
const gh = (args, input) => execFileSync('gh', [...args, '--repo', repo], { input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
if (mode === 'prepare') {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: releaseRoot, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Invalid release commit');
  const existing = JSON.parse(gh(['secret', 'list', '--json', 'name']));
  if (existing.some((item) => /^AGENTBL_W5_RECOVERY_/u.test(item.name))) throw new Error('Existing recovery secrets require reconciliation before another upload');
  const source = path.join(releaseRoot, 'data/runtime/w5-app'), instance = await readJson(path.join(releaseRoot, 'public/rights-instance.json'));
  const vaultKey = (await fs.readFile(path.join(keyDirectory, 'rights-key.hex'), 'utf8')).trim(), key = randomBytes(32);
  await verifyRuntimeMaterials(source, { AGENTBL_RIGHTS_KEY: vaultKey });
  const ledger = new Ledger({ baseDir: path.join(source, `controlled-capital-${instance.contracts.RWAOfferingPoolV5.toLowerCase()}`) });
  const backup = path.join(keyDirectory, `remote-snapshot-${commit}.json`);
  const receipt = await createRuntimeBackup({ directory: source, output: backup, key, sourceRevision: commit,
    configuration: { rights_instance: instance, expected_positions_hash: hashSnapshot(await ledger.listPositions()), recovery_mode: 'readonly_offhost' } });
  // Leave room below the service's per-secret limit for sealed-box/base64 overhead.
  const payload = (await fs.readFile(backup)).toString('base64'), chunks = payload.match(/.{1,40000}/gu) ?? [];
  if (chunks.length > 16) throw new Error('Encrypted research snapshot exceeds the bounded remote drill payload');
  const names = [...chunks.map((_value, i) => `AGENTBL_W5_RECOVERY_PAYLOAD_${i}`), 'AGENTBL_W5_RECOVERY_BACKUP_KEY', 'AGENTBL_W5_RECOVERY_VAULT_KEY'];
  await writeJsonAtomic(privateStateFile, { repo, commit, names, snapshot: receipt, prepared_at: new Date().toISOString() }, { durable: true });
  for (const [i, value] of chunks.entries()) gh(['secret', 'set', names[i]], value);
  gh(['secret', 'set', 'AGENTBL_W5_RECOVERY_BACKUP_KEY'], key.toString('hex'));
  gh(['secret', 'set', 'AGENTBL_W5_RECOVERY_VAULT_KEY'], vaultKey);
  gh(['variable', 'set', 'AGENTBL_W5_RECOVERY_COMMIT', '--body', commit]);
  console.log(JSON.stringify({ prepared: true, commit, encrypted_chunks: chunks.length, original_transaction_keys_supplied: false }));
} else if (mode === 'cleanup') {
  const state = await readJson(privateStateFile); if (state?.repo !== repo || !Array.isArray(state.names)) throw new Error('Recovery control state is missing');
  for (const name of state.names) {
    if (!/^AGENTBL_W5_RECOVERY_(?:PAYLOAD_\d{1,2}|BACKUP_KEY|VAULT_KEY)$/u.test(name)) throw new Error('Invalid managed recovery secret name');
    try { gh(['secret', 'delete', name]); } catch (error) { if (!String(error.stderr).includes('404')) throw error; }
  }
  try { gh(['variable', 'delete', 'AGENTBL_W5_RECOVERY_COMMIT']); }
  catch (error) { if (!String(error.stderr).includes('404')) throw error; }
  state.cleaned_at = new Date().toISOString(); state.temporary_secrets_removed = true; await writeJsonAtomic(privateStateFile, state, { durable: true });
  console.log(JSON.stringify({ cleaned: true, count: state.names.length, commit: state.commit }));
} else throw new Error('Use prepare after the release commit, or cleanup after the independent recovery run');
