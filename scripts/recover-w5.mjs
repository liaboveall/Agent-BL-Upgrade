import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRuntimeBackup } from '../src/ops/backup.js';
import { verifyRuntimeMaterials } from '../src/ops/runtime.js';
import { readJson, writeJsonAtomic } from '../src/lib/jsonStore.js';
import { Ledger } from '../src/ledger/ledger.js';
import { hashSnapshot } from '../src/agent/decisionLogger.js';
import { releaseRoot, releaseSourceSnapshot } from './lib/release-source.mjs';

const image = process.argv[2] || 'agentbl:w5-candidate', at = new Date().toISOString().replaceAll(/[:.]/gu, '-');
const source = path.resolve(releaseRoot, 'data/runtime/w5-app'), offline = `${source}-OFFLINE-${at}`;
if (!source.startsWith(path.join(releaseRoot, 'data/runtime') + path.sep)) throw new Error('Recovery source escaped the intended runtime directory');
const keyDirectory = process.env.AGENTBL_W5_KEY_DIR || path.join(os.homedir(), '.agentbl/w5-2026-10-18');
const keyFile = path.join(keyDirectory, 'backup-key.hex'), rightsKeyFile = path.join(keyDirectory, 'rights-key.hex');
const key = Buffer.from((await fs.readFile(keyFile, 'utf8')).trim(), 'hex'), env = { AGENTBL_RIGHTS_KEY: (await fs.readFile(rightsKeyFile, 'utf8')).trim() };
const instance = await readJson(path.join(releaseRoot, 'public/rights-instance.json'));
const sourceManifest = await releaseSourceSnapshot();
await verifyRuntimeMaterials(source, env);
const ledger = new Ledger({ baseDir: path.join(source, `controlled-capital-${instance.contracts.RWAOfferingPoolV5.toLowerCase()}`) });
const expectedHash = hashSnapshot(await ledger.listPositions());
const configuration = { rights_instance: instance, encrypted_signers: await readJson(path.join(releaseRoot, 'data/runtime/w5-deployment/signers.json')), expected_positions_hash: expectedHash };
const backup = path.join(os.homedir(), '.agentbl/backups', `w5-${at}.json`);
const receipt = await createRuntimeBackup({ directory: source, output: backup, key, configuration, sourceRevision: sourceManifest.source_sha256 });
await fs.rename(source, offline);
let stdout = '', stderr = '', code;
const started = Date.now();
try {
  const child = spawn('docker', ['run', '--rm', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--mount', `type=bind,src=${backup},dst=/restore/backup.json,readonly`,
    '--mount', `type=bind,src=${keyFile},dst=/run/secrets/backup-key.hex,readonly`,
    '--mount', `type=bind,src=${rightsKeyFile},dst=/run/secrets/rights-key.hex,readonly`, image, 'node', 'scripts/lib/w5-container-recovery.mjs'],
  { cwd: releaseRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
  const timeout = setTimeout(() => child.kill(), 300000);
  code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); clearTimeout(timeout);
} finally {
  // Preserve the original source data and put it back only after the isolated recovery finishes.
  await fs.rename(offline, source);
}
const directory = path.join(releaseRoot, 'docs/evidence/w5-2026-10-18/recovery', at); await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(directory, 'replacement.log'), stdout + stderr);
const result = code === 0 ? JSON.parse(stdout.trim().split('\n').at(-1)) : { passed: false, exit_code: code };
await writeJsonAtomic(path.join(directory, 'receipt.json'), { ...result, source_sha256: sourceManifest.source_sha256, source_platform: process.platform,
  backup: receipt, source_renamed_offline: true, source_restored_after_drill: true, total_elapsed_ms: Date.now() - started,
  backup_location: 'operator .agentbl/backups, outside repository; encryption key managed separately',
  external_conditions: ['Independent physical host and offsite key custody not exercised', 'No external human duty receiver was contacted'] });
console.log(JSON.stringify({ passed: result.passed, directory })); process.exitCode = result.passed ? 0 : 1;
