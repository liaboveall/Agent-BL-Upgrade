import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { seal } from '../src/rights/vault.js';
import { createRuntimeBackup } from '../src/ops/backup.js';
import { verifyRuntimeMaterials } from '../src/ops/runtime.js';
import { Ledger } from '../src/ledger/ledger.js';
import { hashSnapshot } from '../src/agent/decisionLogger.js';
import { releaseRoot, releaseSourceSnapshot, digest } from './lib/release-source.mjs';

const directory = path.resolve(process.argv[2] ?? 'artifacts/n5-container/' + Date.now());
await fs.mkdir(directory, { recursive: true });
const source = await releaseSourceSnapshot(), suffix = randomBytes(6).toString('hex');
const image = `agentbl:n5-${source.source_sha256.slice(0, 12)}`, container = `agentbl-n5-${suffix}`, volume = `${container}-runtime`, empty = `${container}-empty`;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-n5-container-'));
if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected temporary root');
const commands = [];
const docker = async (name, args, expected = 0) => {
  const handle = await fs.open(path.join(directory, `${name}.log`), 'wx');
  let code;
  try {
    const child = spawn('docker', args, { cwd: releaseRoot, windowsHide: true, stdio: ['ignore', handle.fd, handle.fd] });
    code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  } finally { await handle.close(); }
  const raw = await fs.readFile(path.join(directory, `${name}.log`), 'utf8');
  commands.push({ name, exit_code: code, expected_exit: expected, log: `${name}.log`, log_sha256: digest(raw) });
  if (expected === 'nonzero' ? code === 0 || code === 125 || code === null : code !== expected) throw new Error(`Docker ${name} failed (${code})`);
  return raw;
};
const hardened = ['--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let origin, imageId, recovery, error, ready, restarted, cleanStop = false;
const waitReady = async () => {
  for (let n = 0; n < 90; n++) {
    try { const response = await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(2000) }); if (response.ok) return await response.json(); } catch {}
    await delay(500);
  }
  throw new Error('Container readiness did not pass');
};
try {
  await docker('build', ['build', '--build-arg', `RELEASE_REVISION=${source.base_head}`, '--build-arg', `RELEASE_SOURCE_SHA256=${source.source_sha256}`, '-t', image, '.']);
  const inspect = JSON.parse(await docker('image', ['image', 'inspect', image]))[0]; imageId = inspect.Id;
  assert.equal(inspect.Config.Labels['io.agentbl.source-sha256'], source.source_sha256);
  assert.equal(inspect.Config.User, 'node');
  await docker('volume', ['volume', 'create', volume]);
  await docker('start', ['run', '-d', '--name', container, '--stop-timeout', '210', '-p', '127.0.0.1::3000', ...hardened, '-e', 'DEMO_MODE=true', '-e', 'REAL_DATA=off', '-e', 'X402_MODE=demo', '-v', `${volume}:/app/data/runtime`, image]);
  const port = (await docker('port', ['port', container, '3000/tcp'])).trim().split(':').at(-1); origin = `http://127.0.0.1:${port}`;
  ready = await waitReady();
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  assert.equal((await docker('uid', ['exec', container, 'id', '-u'])).trim(), '1000');
  await docker('stop', ['stop', '-t', '210', container]);
  await docker('lease', ['run', '--rm', ...hardened, '-v', `${volume}:/app/data/runtime`, image, 'node', '-e', "const fs=require('fs');if(fs.existsSync('/app/data/runtime/.runtime-lease'))process.exit(1);fs.accessSync('/app/data/runtime/runtime-initialized.json')"]); cleanStop = true;
  await docker('restart', ['start', container]);
  // Docker can allocate a different host port when restarting a dynamic port binding.
  const restartedPort = (await docker('restarted-port', ['port', container, '3000/tcp'])).trim().split(':').at(-1);
  origin = `http://127.0.0.1:${restartedPort}`;
  restarted = await waitReady();
  await docker('stop-restarted', ['stop', '-t', '210', container]);
  await docker('empty-volume', ['volume', 'create', empty]);
  const missing = await docker('missing-runtime', ['run', '--rm', ...hardened, '-e', 'AGENTBL_REQUIRE_EXISTING_RUNTIME=true', '-v', `${empty}:/app/data/runtime`, image], 'nonzero');
  assert.match(missing, /runtime-initialized\.json/u);
  const runtime = path.join(temporary, 'source'); await fs.mkdir(path.join(runtime, 'rights'), { recursive: true });
  const backupKey = randomBytes(32), vaultKey = randomBytes(32);
  await fs.writeFile(path.join(temporary, 'backup-key.hex'), backupKey.toString('hex'), { mode: 0o600 });
  await fs.writeFile(path.join(temporary, 'rights-key.hex'), vaultKey.toString('hex'), { mode: 0o600 });
  await fs.writeFile(path.join(runtime, 'rights/vault-initialized.json'), '{}');
  await fs.writeFile(path.join(runtime, 'rights/vault.json'), JSON.stringify(seal(vaultKey, { schema: 'agentbl-rights-vault-v1', synthetic: 'FICTIONAL-N5-MATERIAL' }, 'agentbl-rights-vault-v1')));
  const ledger = new Ledger({ baseDir: path.join(runtime, 'synthetic-capital') });
  for (const n of [1, 2]) await ledger.applyEvent({ kind: 'INVESTOR_DEPOSIT', protocol_instance: { chain_id: 31337, pool_address: `0x${'12'.repeat(20)}`, protocol_version: 5 }, chain_pool_id: 1,
    asset: `0x${'34'.repeat(20)}`, investor: `0x${String(n).repeat(40)}`, amount_atomic: '4000000', shares: '5' });
  await verifyRuntimeMaterials(runtime, { AGENTBL_RIGHTS_KEY: vaultKey.toString('hex') });
  const backup = path.join(temporary, 'backup.json');
  await createRuntimeBackup({ directory: runtime, output: backup, key: backupKey, sourceRevision: source.source_sha256,
    configuration: { expected_positions_hash: hashSnapshot(await ledger.listPositions()) } });
  await fs.rename(runtime, `${runtime}-OFFLINE`);
  const mount = (file, target) => ['--mount', `type=bind,src=${path.join(temporary, file)},dst=${target},readonly`];
  recovery = JSON.parse((await docker('recovery', ['run', '--rm', ...hardened, ...mount('backup.json', '/restore/backup.json'),
    ...mount('backup-key.hex', '/run/secrets/backup-key.hex'), ...mount('rights-key.hex', '/run/secrets/rights-key.hex'), image, 'node', 'scripts/lib/n5-container-recovery.mjs'])).trim());
  assert.equal(recovery.source_sha256, source.source_sha256);
} catch (failure) { error = failure.message; }
finally {
  await docker('logs', ['logs', container]).catch(() => {});
  await docker('cleanup-container', ['rm', '-f', container]).catch(() => {});
  for (const [i, name] of [volume, empty].entries()) await docker(`cleanup-volume-${i}`, ['volume', 'rm', name]).catch(() => {});
  const unchanged = (await releaseSourceSnapshot()).source_sha256 === source.source_sha256;
  const report = { schema: 'agentbl-n5-image-verification-v1', source_sha256: source.source_sha256, source_unchanged: unchanged, image, image_id: imageId,
    local_docker_only: true, ready, restarted, graceful_lease_release: cleanStop, recovery, commands, ...(error ? { error } : {}),
    passed: !error && unchanged && Boolean(recovery?.passed), public_broadcasts: 0, independent_host_verified: false };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ directory, passed: report.passed, ...(error ? { error } : {}) })); process.exitCode = report.passed ? 0 : 1;
}
