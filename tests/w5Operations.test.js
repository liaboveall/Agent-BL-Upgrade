import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { Wallet, id } from 'ethers';
import { acquireRuntimeLease } from '../src/ops/lease.js';
import { OperationsMonitor, storageProbe } from '../src/ops/monitor.js';
import { createRuntimeMonitor, verifyRuntimeMaterials } from '../src/ops/runtime.js';
import { createRuntimeBackup, restoreRuntimeBackup, validateRuntimeBackup } from '../src/ops/backup.js';
import { seal } from '../src/rights/vault.js';
import { Ledger } from '../src/ledger/ledger.js';
import { RightsService } from '../src/rights/service.js';
import { createServer } from '../src/app/server.js';
import { X402SettlementService } from '../src/x402/settlement.js';
import { syntheticPaymentVerifier } from './helpers/paymentVerifier.js';
import { DemoModeController } from '../src/demo/mode.js';
import { deploymentCheckpoint } from '../scripts/legacy-testnet.mjs';

const temporary = async (t) => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-w5-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };
const healthyAgent = () => ({ enabled: true, running: true, mode: 'demo', queue: { queued: 0 }, activity: {} });
const workerFile = path.resolve('tests/helpers/w5RuntimeWorker.js');
test('W5 shutdown drains a slow monitoring read before releasing the single-writer lease', { timeout: 30000 }, async (t) => {
  const directory = await temporary(t);
  const env = { ...process.env, AGENTBL_LOAD_DOTENV: 'false', AGENTBL_RUNTIME_DIR: directory, NODE_TEST_CONTEXT: 'shutdown-regression' };
  for (const name of Object.keys(env)) if (name.startsWith('AGENTBL_RIGHTS_')) delete env[name];
  const child = fork(path.resolve('tests/helpers/gracefulShutdownWorker.js'), { env, silent: true });
  t.after(() => { if (child.exitCode == null) child.kill(); });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    child.on('message', (message) => { if (message?.type === 'probe-start') resolve(); });
    child.once('error', reject); child.once('exit', () => reject(new Error('Worker stopped before pending probe: ' + output)));
  });
  await fs.access(path.join(directory, '.runtime-lease/owner.json'));
  if (process.platform === 'win32') child.send('stop'); else child.kill('SIGTERM');
  const result = await exited;
  assert.equal(result.code, 0, output);
  const events = (await fs.readFile(path.join(directory, 'drain-order.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((item) => item.event), ['probe-start', 'probe-done', 'lease-release']);
  assert.ok(events[1].at - events[0].at >= 11000);
  await assert.rejects(fs.access(path.join(directory, '.runtime-lease')), { code: 'ENOENT' });
  const release = await acquireRuntimeLease(directory, 'reopen-after-drain'); await release();
});
const startHttp = async (t, server) => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
};

test('W5 explicit controlled financing can select Live independently of paid-report configuration', () => {
  const controller = new DemoModeController({ env: { DEMO_MODE: 'true', AGENTBL_RIGHTS_CONFIG: '/operator-reviewed/instance.json' } });
  assert.equal(controller.snapshot().liveAvailable, true);
  assert.equal(controller.setMode('live').demoMode, false);
  assert.equal(controller.snapshot().liveCapabilities.paid_reports_configured, false);
  assert.equal(new DemoModeController({ env: {} }).snapshot().liveAvailable, false);
});

test('W5 deployment recovers a missing CLI journal from the durable signed-hash ledger and never accepts conflicting checkpoints', () => {
  const saved = { tx_hash: id('synthetic-signed-hash-checkpoint'), nonce: 7, status: 'BROADCASTING' };
  assert.equal(deploymentCheckpoint(null, saved), saved);
  assert.equal(deploymentCheckpoint(saved, saved), saved);
  assert.equal(deploymentCheckpoint(null, { label: 'not-yet-signed' }), null);
  assert.throws(() => deploymentCheckpoint({ status: 'BROADCASTING' }, saved), /reconcile/u);
  assert.throws(() => deploymentCheckpoint({ ...saved, tx_hash: id('another-synthetic-checkpoint') }, saved), /disagree/u);
});

test('W5 runtime lease prevents a second OS writer, survives SIGKILL and refuses unknown remote owners', async (t) => {
  const dir = await temporary(t);
  const worker = fork(workerFile, ['lease', dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (worker.exitCode === null) worker.kill(); }); await once(worker, 'message');
  await assert.rejects(acquireRuntimeLease(dir), { code: 'runtime_in_use' });
  const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited;
  const release = await acquireRuntimeLease(dir); await release(); await release();
  const lock = path.join(dir, '.runtime-lease'); await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ host: 'another-host', pid: 999999, token: '00000000-0000-0000-0000-000000000001' }));
  await assert.rejects(acquireRuntimeLease(dir), { code: 'runtime_in_use' });
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'))).host, 'another-host');
});

test('W5 readiness separates storage, RPC/reorg uncertainty, queues and startup; alerts arrive, deduplicate and recover', async (t) => {
  const directory = await temporary(t), received = [];
  const receiver = http.createServer(async (req, res) => { let raw = ''; req.setEncoding('utf8'); for await (const chunk of req) raw += chunk; received.push(JSON.parse(raw)); res.end('ok'); });
  const url = await startHttp(t, receiver); let agent = healthyAgent(), storageOk = true, now = Date.now();
  const monitor = new OperationsMonitor({ directory, env: { AGENTBL_RELEASE_REVISION: 'reviewed-commit' }, now: () => now,
    getAgentStatus: async () => agent, probeStorage: async () => { if (!storageOk) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return {}; },
    alertSink: async (alert) => { const response = await fetch(url, { method: 'POST', body: JSON.stringify(alert) }); assert.equal(response.status, 200); } });
  await monitor.start(); t.after(() => monitor.stop()); assert.equal(monitor.readiness().ok, true);
  storageOk = false; await monitor.sample(); await monitor.sample(); assert.equal(received.length, 2);
  assert.equal(monitor.readiness().ok, false); assert.deepEqual(received[1].codes, ['storage_unavailable']);
  storageOk = true; agent = { ...healthyAgent(), mode: 'live', emergency_stop_sources: { chain_unknown: true }, chain_watcher: { enabled: true, state: 'reorg' }, queue: { queued: 200, dead: 1 } };
  await monitor.sample(); assert.ok(monitor.details().checks.some((item) => item.code === 'chain_reconciliation_required'));
  assert.ok(monitor.details().checks.some((item) => item.code === 'queue_backlog'));
  agent = healthyAgent(); await monitor.sample(); assert.equal(received.at(-1).severity, 'recovery');
  now += 31000; assert.equal(monitor.readiness().ok, false); assert.equal(monitor.readiness().status, 'unknown');
  monitor.failStartup(); await monitor.sample(); assert.equal(monitor.readiness().ok, false);
  const stoppedSnapshot = monitor.details().observed_at;
  await monitor.stop(); now += 1000; await monitor.sample(); await monitor.start();
  assert.equal(monitor.details().observed_at, stoppedSnapshot, 'stopped monitoring must not start a new sample');
  const log = await fs.readFile(path.join(directory, 'ops-alerts.jsonl'), 'utf8'); assert.doesNotMatch(log, /authorization|wallet|privateKey/u);
  assert.match(monitor.metrics(), /agentbl_ready 0/u);
});

test('W5 an expiring source screening alerts its owner while the service stays ready, and recovers once refreshed', async (t) => {
  const directory = await temporary(t), alerts = [];
  let validUntil = 1_000_000 + 3600;
  const monitor = new OperationsMonitor({ directory, getAgentStatus: healthyAgent, probeStorage: async () => ({}),
    probeControls: async () => ({ enabled: true, intake_stopped: false, screening_valid_until: String(validUntil), block_timestamp: 1_000_000 }), alertSink: async (alert) => { alerts.push(alert); } });
  await monitor.sample();
  assert.equal(monitor.readiness().ok, true, 'a screening window about to lapse does not stop other operations');
  assert.deepEqual(alerts.at(-1), { ...alerts.at(-1), severity: 'warning', codes: ['screening_expiring'], action: 'refresh_screening', owners: ['compliance'] });
  validUntil = 999_000; await monitor.sample();
  assert.equal(monitor.readiness().ok, true); assert.deepEqual(alerts.at(-1).codes, ['screening_expired']);
  validUntil = 1_000_000 + 86_400; await monitor.sample();
  assert.equal(alerts.at(-1).severity, 'recovery'); assert.equal(alerts.length, 3);
});

test('W5 a screening whose signer lost COMPLIANCE alerts compliance even while its window is open', async (t) => {
  const directory = await temporary(t), alerts = [];
  let active = false;
  const monitor = new OperationsMonitor({ directory, getAgentStatus: healthyAgent, probeStorage: async () => ({}), alertSink: async (alert) => { alerts.push(alert); },
    probeControls: async () => ({ enabled: true, intake_stopped: false, screening_valid_until: String(1_000_000 + 86_000), block_timestamp: 1_000_000, screening_source_active: active }) });
  await monitor.sample();
  assert.equal(monitor.readiness().ok, true, 'the chain refuses what it blocks; other operations continue');
  assert.deepEqual(alerts.at(-1), { ...alerts.at(-1), severity: 'warning', codes: ['screening_source_inactive'], action: 'refresh_screening', owners: ['compliance'] });
  active = true; await monitor.sample();
  assert.equal(alerts.at(-1).severity, 'recovery');
});

test('W5 low disk and failed atomic rename are observable without modifying existing runtime data', async (t) => {
  const dir = await temporary(t); await fs.writeFile(path.join(dir, 'preserved.json'), 'history');
  await assert.rejects(storageProbe(dir, 10, { ...fs, statfs: async () => ({ bavail: 0n, bsize: 4096n }) }), { code: 'storage_low' });
  await assert.rejects(storageProbe(dir, 1, { ...fs, rename: async () => { throw Object.assign(new Error('write denied'), { code: 'ENOSPC' }); } }), { code: 'ENOSPC' });
  assert.equal(await fs.readFile(path.join(dir, 'preserved.json'), 'utf8'), 'history');
});

test('W5 operations HTTP keeps liveness separate, authenticates diagnostics and blocks new intake while keeping claims reachable', async (t) => {
  const directory = await temporary(t), original = process.env.AGENTBL_ADMIN_TOKEN;
  process.env.AGENTBL_ADMIN_TOKEN = 'w5-operator-authentication-token';
  t.after(() => { if (original === undefined) delete process.env.AGENTBL_ADMIN_TOKEN; else process.env.AGENTBL_ADMIN_TOKEN = original; });
  const monitor = new OperationsMonitor({ directory, getAgentStatus: healthyAgent, probeStorage: async () => { throw new Error('disk unavailable'); } });
  await monitor.sample(); const url = await startHttp(t, createServer({ operations: monitor }));
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  const readiness = await fetch(`${url}/api/ready`); assert.equal(readiness.status, 503); assert.equal((await readiness.json()).checks, undefined);
  assert.equal((await fetch(`${url}/api/ops/status`)).status, 401);
  const headers = { authorization: 'Bearer w5-operator-authentication-token', 'content-type': 'application/json' };
  assert.equal((await fetch(`${url}/api/ops/status`, { headers })).status, 200);
  assert.match(await (await fetch(`${url}/api/ops/metrics`, { headers })).text(), /agentbl_check_ok/u);
  assert.equal((await fetch(`${url}/api/positions/subscription-intents`, { method: 'POST', headers, body: '{}' })).status, 503);
  const claim = await fetch(`${url}/api/positions/claim-intents`, { method: 'POST', headers, body: '{}' });
  assert.notEqual(claim.status, 503, 'business validation remains reachable for an existing exit');
  assert.notEqual((await fetch(`${url}/api/positions?wallet=0x${'12'.repeat(20)}`)).status, 503);
});

test('W5 initialized private history detects missing stores and wrong keys; a configured monitor verifies without a signer', async (t) => {
  const directory = await temporary(t), env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') };
  const rights = path.join(directory, 'rights'); await fs.mkdir(rights);
  await fs.writeFile(path.join(rights, 'vault-initialized.json'), '{}');
  await assert.rejects(verifyRuntimeMaterials(directory, env));
  await fs.writeFile(path.join(rights, 'vault.json'), JSON.stringify(seal(Buffer.from(env.AGENTBL_RIGHTS_KEY, 'hex'), { schema: 'agentbl-rights-vault-v1' }, 'agentbl-rights-vault-v1')));
  assert.equal((await verifyRuntimeMaterials(directory, env)).initialized_stores_verified, 1);
  await assert.rejects(verifyRuntimeMaterials(directory, { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') }));
  const monitor = createRuntimeMonitor({ directory, env, getAgentStatus: healthyAgent });
  await monitor.start(); assert.equal(monitor.readiness().ok, true); await monitor.stop(); assert.equal(monitor.readiness().ok, false);
  await fs.rm(rights, { recursive: true });
  await assert.rejects(verifyRuntimeMaterials(directory, env), { code: 'ENOENT' }, 'inventory detects loss of both data and its initialized marker');
});

test('W5 encrypted stopped-service backup restores ledger, business session and evidence in a new OS process with source offline', async (t) => {
  const dir = await temporary(t), source = path.join(dir, 'source'), destination = path.join(dir, 'replacement'), key = randomBytes(32), vaultKey = randomBytes(32).toString('hex');
  await fs.mkdir(source);
  const ledger = new Ledger({ baseDir: path.join(source, 'capital') });
  const event = { kind: 'INVESTOR_DEPOSIT', protocol_instance: { chain_id: 31337, pool_address: `0x${'10'.repeat(20)}`, protocol_version: 5 },
    chain_pool_id: 1, asset: `0x${'20'.repeat(20)}`, investor: `0x${'30'.repeat(20)}`, amount_atomic: '8000000', shares: '10' };
  await ledger.applyEvent(event); const before = await ledger.listPositions();
  const rights = new RightsService({ directory: path.join(source, 'rights'), env: { AGENTBL_RIGHTS_KEY: vaultKey } });
  const wallet = Wallet.createRandom(), subject = await rights.createSubject({ organization: 'w5-research', wallet: wallet.address, roles: ['issuer'] });
  const challenge = await rights.createChallenge(subject.subject_id), session = await rights.openSession({ challenge_id: challenge.challenge_id,
    signature: await wallet.signTypedData(challenge.domain, challenge.types, challenge.message) });
  const token = session.token, material = await rights.createMaterial(token, { material: { bill: 'PRIVATE-W5-SIMULATED-TITLE' }, public_summary: { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 7, terms_hash: id('w5-terms'), risk_flags: ['simulated_title', 'test_asset'] } });
  const evidence = await rights.createEvidence(token, { material_id: material.material_id, kind: 'raw_material', source: { provider: 'research-fixture', version: '1', level: 'synthetic', source_hash: id('fixture'), observed_at: new Date().toISOString() } });
  const output = path.join(dir, 'backup.json'), release = await acquireRuntimeLease(source);
  await assert.rejects(createRuntimeBackup({ directory: source, output, key }), { code: 'runtime_in_use' }); await release();
  const receipt = await createRuntimeBackup({ directory: source, output, key, sourceRevision: 'w5-reviewed-source', configuration: { chain_id: 31337 } });
  assert.ok(receipt.file_count >= 4); assert.doesNotMatch(await fs.readFile(output, 'utf8'), /PRIVATE-W5|w5-research|8000000/u);
  await assert.rejects(createRuntimeBackup({ directory: source, output, key }), { code: 'EEXIST' });
  await fs.rename(source, path.join(dir, 'source-OFFLINE'));
  await restoreRuntimeBackup({ input: output, directory: destination, key });
  await assert.rejects(restoreRuntimeBackup({ input: output, directory: destination, key }), /already exists/u);
  const payloadFile = path.join(dir, 'private-recovery-input.json'); await fs.writeFile(payloadFile, JSON.stringify({ key: vaultKey, session: token, material_id: material.material_id, evidence_id: evidence.evidence_id }));
  const { stdout } = await promisify(execFile)(process.execPath, [workerFile, 'recover', destination, payloadFile], { env: { ...process.env, NODE_TEST_CONTEXT: 'w5-worker' }, windowsHide: true });
  const restored = JSON.parse(stdout); assert.deepEqual(restored.positions, before); assert.equal(restored.evidence_verified, true);
  assert.equal((await verifyRuntimeMaterials(destination, { AGENTBL_RIGHTS_KEY: vaultKey })).initialized_stores_verified, 1);
});

test('W5 restore authenticates every byte before writing, rejects traversal, collisions, wrong keys and interrupted restores', async (t) => {
  const dir = await temporary(t), key = randomBytes(32), input = path.join(dir, 'invalid.json');
  const body = { schema: 'agentbl-runtime-backup-v1', consistency: 'stopped-single-writer', total_bytes: 0, files: [] };
  const envelope = (value) => ({ schema: 'agentbl-encrypted-runtime-backup-v1', ...seal(key, value, 'agentbl-runtime-backup-v1') });
  assert.throws(() => validateRuntimeBackup(envelope(body), randomBytes(32)));
  for (const name of ['../outside', '/absolute', 'C:/key', 'a\\b', 'a/../b', '.runtime-lease/owner.json']) {
    assert.throws(() => validateRuntimeBackup(envelope({ ...body, files: [{ path: name, size: 0, data: '', sha256: 'bad' }] }), key));
  }
  await fs.writeFile(input, JSON.stringify(envelope({ ...body, files: [{ path: 'history.json', size: 0, data: '', sha256: 'bad' }] })));
  const target = path.join(dir, 'bad-restore'); await assert.rejects(restoreRuntimeBackup({ input, directory: target, key }));
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  const incomplete = path.join(dir, 'incomplete'); await fs.mkdir(incomplete); await fs.writeFile(path.join(incomplete, '.restore-incomplete.json'), '{}');
  await assert.rejects(acquireRuntimeLease(incomplete), /Interrupted restore/u);
});

test('W5 a degraded operation blocks new x402 settlement but permits original paid-authorization recovery', async () => {
  const req = { scheme: 'exact', network: 'eip155:1439', asset: `0x${'01'.repeat(20)}`, payTo: `0x${'02'.repeat(20)}`, amount: '1000', extra: { name: 'USDC', version: '2' } };
  const input = { resource: 'https://research.test/report', paymentRequirements: req, paymentPayload: { x402Version: 2, accepted: req, payload: { signature: `0x${'11'.repeat(65)}`,
    authorization: { from: `0x${'03'.repeat(20)}`, to: req.payTo, value: '1000', nonce: `0x${'04'.repeat(32)}`, validAfter: '1', validBefore: '4000000000' } } } };
  let available = false, settles = 0;
  const service = new X402SettlementService({ mode: 'live', canSettle: () => available, deliveryKey: randomBytes(32), verifier: syntheticPaymentVerifier,
    adapter: { verify: async () => ({ response: { isValid: true }, attempts: 1 }), settle: async () => { settles++; return { response: { success: true, transaction: id('synthetic-w5-test-payment'), payer: input.paymentPayload.payload.authorization.from, network: req.network }, attempts: 1 }; } } });
  await assert.rejects(service.process(input), { code: 'operations_not_ready' }); assert.equal(settles, 0);
  available = true; await service.process(input); assert.equal(settles, 1);
  available = false; const recovered = await service.process(input); assert.equal(recovered.replayed, true); assert.equal(settles, 1);
});
