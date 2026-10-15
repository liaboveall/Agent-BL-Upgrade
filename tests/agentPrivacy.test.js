import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DecisionLogger } from '../src/agent/decisionLogger.js';
import { ActivityLog } from '../src/agent/runtime/activityLog.js';
import { Tracer } from '../src/agent/runtime/trace.js';
import { sanitizeAudit } from '../src/agent/security/privacy.js';
import { readPrivateJson, writePrivateJson } from '../src/agent/security/privateStore.js';
import { copper, phase5Runtime, riskDecision } from './helpers/phase5.js';

const wallet = `0x${'12'.repeat(20)}`;
const privateKey = `0x${'34'.repeat(32)}`;
const apiKey = 'sk-fictional-test-key-never-real';
const record = (patch = {}) => ({ case_id: 'PRIVACY', action: 'WARNING', reasoning_summary: 'Privacy probe', input_snapshot: { amount: 7 }, ...patch });

test('audit projection scrubs nested secrets, source text and wallets while retaining valid evidence/tx hashes', () => {
  const safe = sanitizeAudit({ nested: [{ wallet, api_key: apiKey, privateKey, text: 'document body', error: `provider rejected ${apiKey} ${privateKey} ${wallet}` }],
    tx_hash: `0x${'ab'.repeat(32)}`, evidence_hash: `0x${'cd'.repeat(32)}` });
  const text = JSON.stringify(safe);
  for (const forbidden of [wallet, privateKey, apiKey, 'document body']) assert.equal(text.includes(forbidden), false);
  assert.equal(safe.tx_hash, `0x${'ab'.repeat(32)}`);
  assert.ok(text.includes('0x1212…1212'));
});

test('operational journal keeps exact addresses encrypted and authenticates its public audit projection', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-privacy-vault-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'decisions.json');
  const first = new DecisionLogger({ filePath: file });
  const decision = await first.record(record({ proposal: { params: { recipient: wallet, api_key: apiKey, text: 'raw upload' } } }));
  const bytes = await fs.readFile(file, 'utf8');
  assert.equal(bytes.includes(wallet), false); assert.equal(bytes.includes(apiKey), false); assert.equal(bytes.includes('raw upload'), false);
  const restored = await new DecisionLogger({ filePath: file }).get(decision.decision_id);
  assert.equal(restored.proposal.params.recipient, wallet);
  assert.equal(restored.proposal.params.api_key, '[REDACTED]');
  const tampered = JSON.parse(bytes); tampered[0].reasoning_summary = 'edited audit'; await fs.writeFile(file, JSON.stringify(tampered));
  await assert.rejects(new DecisionLogger({ filePath: file }).init(), /authenticated/u);
});

test('runtime audit scan covers decisions, events, queue, activities and traces with adversarial values', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-privacy-runtime-'));
  const { service } = await phase5Runtime(t, { dir });
  await service.activity.attachFile(path.join(dir, 'agent-activity.jsonl'));
  await riskDecision(service, { data: { events: [{ type: 'severe_weather', severity: 'critical', region: 'East China Sea',
    description: `Suspicious values ${wallet} ${privateKey} ${apiKey}` }], api_key: apiKey, wallet, private_key: privateKey, text: 'raw document marker' } });
  service.activity.append({ action: 'PRIVACY_PROBE', details: { wallet, api_key: apiKey, error: privateKey, text: 'raw document marker' } });
  const trace = service.tracer.startRun({ name: 'privacy', attributes: { wallet, api_key: apiKey } });
  await assert.rejects(trace.span('failure', async () => { throw new Error(`${wallet} ${privateKey} ${apiKey}`); }));
  await trace.end('error'); await service.activity.flush(); await service.bus.flush();
  for (const file of (await fs.readdir(dir)).filter((name) => /\.(?:json|jsonl)(?:\.\d+)?$/u.test(name))) {
    const text = await fs.readFile(path.join(dir, file), 'utf8');
    for (const forbidden of [wallet, privateKey, apiKey, 'raw document marker']) assert.equal(text.includes(forbidden), false, `${file} leaked a synthetic sensitive value`);
  }
  await service.stop(); await fs.rm(dir, { recursive: true, force: true });
});

test('retention bounds decisions, rotated activity and trace files while preserving in-flight decisions', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-privacy-retention-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-10-01');
  const logger = new DecisionLogger({ filePath: path.join(dir, 'decisions.json'), clock: () => new Date(now) });
  const pending = await logger.record(record({ event_id: 'pending', status: 'EXECUTING' }));
  await logger.record(record({ event_id: 'old', status: 'COMPLETED' }));
  const activity = new ActivityLog({ now: () => new Date(now) }); await activity.attachFile(path.join(dir, 'activity.jsonl'), { maxFileBytes: 250, keepFiles: 10 });
  const tracer = new Tracer({ file: path.join(dir, 'traces.jsonl'), maxBytes: 250, keepFiles: 10, wall: () => now, bridge: false });
  for (const id of ['old', pending.decision_id]) {
    activity.append({ decision_id: id, action: 'OLD' });
    await tracer.startRun({ decision_id: id, name: 'old' }).end();
  }
  now = Date.parse('2026-10-15');
  for (let i = 0; i < 5; i++) {
    await logger.record(record({ event_id: `new-${i}`, status: 'COMPLETED' }));
    activity.append({ action: `new-${i}` }); await tracer.startRun({ name: `new-${i}` }).end();
  }
  await activity.flush();
  await logger.prune({ maxRecords: 3, olderThanMs: 86400000 });
  const options = { now, retentionDays: 1, maxRecords: 3, protectedDecisions: new Set([pending.decision_id]) };
  await activity.prune(options); await tracer.prune(options);
  assert.equal(logger.records.length, 3); assert.ok(await logger.get(pending.decision_id));
  assert.equal(activity.buffer.length, 3); assert.equal(tracer.recent.length, 3);
  assert.ok(activity.buffer.some((item) => item.decision_id === pending.decision_id));
  assert.ok(tracer.recent.some((item) => item.decision_id === pending.decision_id));
  for (const file of ['activity.jsonl', 'traces.jsonl']) {
    assert.equal((await fs.readFile(path.join(dir, file), 'utf8')).trim().split('\n').length, 3);
    await assert.rejects(fs.access(path.join(dir, `${file}.1`)), { code: 'ENOENT' });
  }
});

test('periodic retention also runs under the injected service clock', async (t) => {
  const { service, advance } = await phase5Runtime(t, { config: { AGENT_RETENTION_DAYS: '1' } });
  const decision = await riskDecision(service);
  advance(2 * 86400000); await service.tick();
  assert.equal(await service.logger.get(decision.decision_id), null);
  assert.equal(service.activity.buffer.filter((entry) => entry.caseId === copper.case_id).length, 0);
});

test('authenticated queue snapshots reject plaintext edits and missing encryption keys', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-privacy-queue-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json');
  await writePrivateJson(file, { entries: [{ wallet, private_key: privateKey }] });
  assert.equal((await readPrivateJson(file)).entries[0].wallet, wallet);
  const saved = await fs.readFile(file, 'utf8'); const edited = JSON.parse(saved); edited.entries.push({ injected: true });
  await fs.writeFile(file, JSON.stringify(edited)); await assert.rejects(readPrivateJson(file), /authentication/u);
  await fs.writeFile(file, saved); await fs.rm(`${file}.key`);
  await assert.rejects(readPrivateJson(file), { code: 'ENOENT' });
});

test('legacy plaintext audit records migrate on startup without changing decision IDs or chain evidence', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-privacy-legacy-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'decisions.json');
  const old = record({ decision_id: 'legacy-decision', status: 'COMPLETED', wallet,
    execution: { mode: 'chain', tx_hash: `0x${'ab'.repeat(32)}` } });
  await fs.writeFile(file, JSON.stringify([old]));
  const restored = await new DecisionLogger({ filePath: file }).get(old.decision_id);
  assert.equal(restored.wallet, wallet); assert.equal(restored.execution.tx_hash, old.execution.tx_hash);
  const migrated = await fs.readFile(file, 'utf8'); assert.equal(migrated.includes(wallet), false);
  assert.ok(JSON.parse(migrated)[0]._private);
  assert.equal((await new DecisionLogger({ filePath: file }).get(old.decision_id)).decision_id, old.decision_id);
});

test('SSE sequence remains monotonic after all activity expires and a restart', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-privacy-seq-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'activity.jsonl');
  const first = new ActivityLog({ now: () => new Date('2026-10-01') }); await first.attachFile(file);
  first.append({ action: 'old' }); first.append({ action: 'old-2' }); await first.flush();
  await first.prune({ now: Date.parse('2026-10-15'), retentionDays: 1, maxRecords: 3 });
  assert.equal(first.buffer.length, 0);
  const second = new ActivityLog(); await second.attachFile(file);
  assert.equal(second.append({ action: 'new' }).seq, 3); await second.flush();
});
