// State that must not run ahead of what was persisted or belongs to another mode (application audit A04, A06), and
// a runtime directory that must stay within what one backup can restore.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { PreferenceStore } from '../src/agent/runtime/preferences.js';
import { createAgentService } from '../src/agent/runtime/factory.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { OperationsMonitor } from '../src/ops/monitor.js';
import { INTAKE_BACKUP_SHARE, RUNTIME_BACKUP_LIMIT_BYTES, runtimeBytes } from '../src/ops/budget.js';

const temporary = [];
const tempDir = async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-state-')); temporary.push(dir); return dir; };
after(() => Promise.all(temporary.map((dir) => fs.rm(dir, { recursive: true, force: true }))));
const note = (text) => ({ name: 'synthetic-note.txt', mime_type: 'text/plain', text });

test('a preference write that fails is never visible, and a later success is never rolled back (A06)', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'preferences.json');
  const store = new PreferenceStore({ file });
  await store.put('PREF-A', { min_acceptable_issue_price: 0.8 });
  // The write target becomes a directory: the atomic rename really fails.
  store.file = await fs.mkdtemp(path.join(dir, 'not-a-file-'));
  await assert.rejects(store.put('PREF-A', { min_acceptable_issue_price: 0.99 }));
  assert.equal(store.get('PREF-A').min_acceptable_issue_price, 0.8, 'readers still see what was persisted');
  await assert.rejects(store.clear());
  assert.equal(store.get('PREF-A').min_acceptable_issue_price, 0.8, 'a failed clear clears nothing');

  // Concurrent saves land in order; a failure between them does not undo the earlier success.
  store.file = file;
  const first = store.put('PREF-A', { min_acceptable_issue_price: 0.81 });
  const second = store.put('PREF-B', { payout_speed_preference: 'FAST' });
  await Promise.all([first, second]);
  store.file = await fs.mkdtemp(path.join(dir, 'not-a-file-'));
  await assert.rejects(store.put('PREF-A', { min_acceptable_issue_price: 0.5 }));
  store.file = file;
  const reloaded = await new PreferenceStore({ file }).init();
  assert.equal(reloaded.get('PREF-A').min_acceptable_issue_price, 0.81);
  assert.equal(reloaded.get('PREF-B').payout_speed_preference, 'FAST');
  assert.equal(store.get('PREF-A').min_acceptable_issue_price, 0.81, 'memory and disk agree after the restart');
});

test('a Demo reset keeps Live material and its research constraints together (A04)', async (t) => {
  let mode = 'live';
  const service = createAgentService({ config: loadAgentConfig({ AGENT_VALUATION_LLM: 'false', AGENT_DOCUMENT_LLM: 'false', AGENT_COOLDOWN_SEC: '0' }),
    env: { REAL_DATA: 'off' }, getMode: () => mode, getGeneration: () => 1, monitors: false, store: { pools: new Map(), activityLog: [] }, ensurePools: async () => {} });
  await service.init();
  t.after(() => service.stop());
  const live = await service.ingest.accept({ case_id: 'STATE-LIVE', documents: [note('Fictional Live private title')] }, { ownerId: 'owner-live' });
  await service.setPreferences('STATE-LIVE', { min_acceptable_issue_price: 0.92 });
  mode = 'demo';
  await service.setPreferences('STATE-DEMO', { min_acceptable_issue_price: 0.5 });
  await service.resetDemo();
  assert.equal(service.ingest.getJob(live.job.job_id)?.mode, 'live');
  assert.equal(service.preferences.get('STATE-LIVE')?.min_acceptable_issue_price, 0.92, 'the Live constraint stays with its material');
  assert.equal(service.preferences.get('STATE-DEMO'), undefined, 'Demo constraints are cleared');
});

test('the intake store fits in a backup, and the operator is warned before the runtime directory outgrows one', async () => {
  assert.ok(loadAgentConfig({}).uploadTotalQuotaBytes <= RUNTIME_BACKUP_LIMIT_BYTES * INTAKE_BACKUP_SHARE);
  assert.equal(loadAgentConfig({ AGENT_UPLOAD_TOTAL_QUOTA_BYTES: String(4 * 1024 ** 3) }).uploadTotalQuotaBytes, RUNTIME_BACKUP_LIMIT_BYTES * INTAKE_BACKUP_SHARE);

  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'research-agent', 'uploads'), { recursive: true });
  await fs.writeFile(path.join(dir, 'research-agent', 'uploads', 'a.sealed'), Buffer.alloc(1000));
  await fs.writeFile(path.join(dir, 'ledger.jsonl'), Buffer.alloc(24));
  await fs.mkdir(path.join(dir, '.runtime-lease'));
  await fs.writeFile(path.join(dir, '.runtime-lease', 'owner.json'), Buffer.alloc(500));
  assert.equal(await runtimeBytes(dir), 1024, 'what a backup reads, without the lease');

  let bytes = 0;
  const alerts = [];
  const monitor = new OperationsMonitor({ directory: dir, env: { AGENTBL_BACKUP_BUDGET_INTERVAL_MS: '1' }, getAgentStatus: async () => ({ enabled: false }),
    probeStorage: async () => ({}), probeRuntimeBytes: async () => bytes, alertSink: async (alert) => { alerts.push(alert); } });
  await monitor.sample();
  assert.equal(monitor.readiness().ok, true);
  bytes = Math.ceil(RUNTIME_BACKUP_LIMIT_BYTES * 0.9);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await monitor.sample();
  assert.equal(monitor.readiness().ok, true, 'near the limit the service keeps running');
  assert.deepEqual(alerts.at(-1).codes, ['backup_budget_near']);
  assert.deepEqual(alerts.at(-1).owners, ['operator']);
  bytes = RUNTIME_BACKUP_LIMIT_BYTES + 1;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await monitor.sample();
  assert.equal(monitor.readiness().ok, false, 'past it, new intake stops: what is stored must stay restorable');
  assert.deepEqual(alerts.at(-1).codes, ['backup_budget_exceeded']);
});
