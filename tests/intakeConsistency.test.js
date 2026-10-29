// Consistency after a partial failure (application assessment 2026-10-29, C01-C03, C05, C06): a private case known only
// by its preferences when the access file is lost, an event whose PROCESSING write failed, an upload whose commit
// failed, held material filling the byte quota, and held jobs beyond the first page of the job list.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { listen, requestJson } from './helpers/http.js';

process.env.AGENTBL_RATE_LIMIT_PER_MIN = '0';
process.env.AGENTBL_WRITE_RATE_LIMIT_PER_MIN = '0';
delete process.env.AGENTBL_ADMIN_TOKEN;
delete process.env.XAPI_KEY;

const { createServer, closeActivityStreams, setAgentService, activityLog } = await import('../src/app/server.js');
const { resetStore, storeState } = await import('../src/app/store.js');
const { loadAgentConfig } = await import('../src/agent/runtime/config.js');
const { createAgentService, loadApplicationConfig } = await import('../src/agent/runtime/factory.js');
const { demoModeController } = await import('../src/demo/mode.js');
const { IngestService } = await import('../src/agent/ingest/ingestService.js');
const { EventBus } = await import('../src/agent/runtime/eventBus.js');
const { normalizeEvent } = await import('../src/agent/runtime/events.js');
const { OperationsMonitor } = await import('../src/ops/monitor.js');

const note = (text) => ({ name: 'synthetic-note.txt', mime_type: 'text/plain', text });
const temporary = [];
const tempDir = async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-consistency-')); temporary.push(dir); return dir; };
after(() => Promise.all(temporary.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

function agentService(options = {}) {
  resetStore();
  storeState.agentActivities = [];
  return createAgentService({
    config: loadAgentConfig({ AGENT_VALUATION_LLM: 'false', AGENT_DOCUMENT_LLM: 'false', AGENT_ANCHOR_ENABLED: 'false', AGENT_COOLDOWN_SEC: '0' }),
    env: {}, demoModeController, ensurePools: async () => {}, activity: activityLog, store: storeState, monitors: false,
    chainConfig: loadApplicationConfig(), getChainContext: async () => null, sleep: async () => {}, ...options
  });
}

function workspace(base) {
  const value = crypto.randomBytes(24).toString('hex');
  const ownerId = crypto.createHash('sha256').update(value).digest('hex');
  return { ownerId, request: (method, route, body) => requestJson(base, method, route, body, { Cookie: `agentbl_workspace=${value}` }) };
}

/** Make `file` unwritable for a while: a directory where the atomic rename has to land. */
async function block(file) {
  await fs.rm(file, { force: true });
  await fs.mkdir(file, { recursive: true });
  return () => fs.rm(file, { recursive: true, force: true });
}

// ---------------------------------------------------------------- C01

test('C01: a private case known only by its preferences is never public, whether the access file or its manifest is lost', async (t) => {
  const app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); });
  const dir = await tempDir();
  const owner = workspace(app.base), stranger = workspace(app.base);
  const route = '/api/agent/cases/PRIVATE-PREFERENCE-ONLY/preferences';

  const first = agentService({ dir });
  await first.start();
  setAgentService(first);
  assert.equal((await owner.request('PUT', route, { min_acceptable_issue_price: 0.73 })).status, 200);
  assert.equal(first.ingest.listJobs().length, 0, 'no upload: only preferences and the access record exist');
  assert.equal((await requestJson(app.base, 'GET', route)).status, 404);
  await first.stop();
  const accessFile = first.ingest.accessFile, manifestFile = first.ingest.manifestFile;
  const savedAccess = await fs.readFile(accessFile), savedManifest = await fs.readFile(manifestFile);

  // The access file is lost but the manifest remains: this is not a fresh start, the intake refuses to load.
  await fs.rm(accessFile);
  const second = agentService({ dir });
  setAgentService(second);
  await assert.rejects(second.start(), /access records are missing/u);
  for (const caller of [() => requestJson(app.base, 'GET', route), () => stranger.request('GET', route), () => owner.request('GET', route)]) {
    const read = await caller();
    assert.equal(read.status, 503);
    assert.doesNotMatch(read.text, /0\.73/u);
  }

  // Both are lost (an incomplete restore): the intake starts afresh, yet the preferences make the case private with an
  // unknown owner. Nobody but an operator reads it, and nobody can claim it by saving preferences of their own.
  await fs.rm(manifestFile);
  const third = agentService({ dir });
  await third.start();
  setAgentService(third);
  assert.equal(third.ingest.accessState, 'ready');
  for (const caller of [() => requestJson(app.base, 'GET', route), () => stranger.request('GET', route), () => owner.request('GET', route)]) {
    const read = await caller();
    assert.equal(read.status, 404);
    assert.doesNotMatch(read.text, /0\.73/u);
  }
  assert.equal((await stranger.request('PUT', route, { min_acceptable_issue_price: 0.1 })).status, 404);
  assert.equal(third.preferences.get('PRIVATE-PREFERENCE-ONLY').min_acceptable_issue_price, 0.73);
  assert.equal(third.ingest.canReadCase('PRIVATE-PREFERENCE-ONLY', { admin: true }), true);
  assert.equal(third.ingest.canReadCase('A-CASE-NOBODY-STORED-ANYTHING-FOR'), true, 'a case with no private state stays public');
  await third.stop();

  // Restored files: the owner reads again, nobody else does.
  await fs.writeFile(accessFile, savedAccess);
  await fs.writeFile(manifestFile, savedManifest);
  const fourth = agentService({ dir });
  await fourth.start();
  setAgentService(fourth);
  const read = await owner.request('GET', route);
  assert.equal(read.status, 200);
  assert.equal(read.data.preferences.min_acceptable_issue_price, 0.73);
  assert.equal((await stranger.request('GET', route)).status, 404);
  await fourth.stop();
});

test('C01: a new directory writes its access file and manifest at once; an expired job table still proves the records existed', async () => {
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  const dir = await tempDir();
  const intake = new IngestService({ dir, env: {}, jobRetentionMs: 1000, now: () => new Date(now) });
  await intake.init();
  assert.ok(await fs.stat(intake.accessFile), 'the access file exists from the first start');
  assert.match(JSON.parse(await fs.readFile(intake.manifestFile, 'utf8')).access_records_since, /^2026-10-01/u);
  const { job } = await intake.accept({ case_id: 'EXPIRING-CASE', documents: [note('Synthetic upload that expires')] }, { ownerId: 'owner-a' });
  await intake.updateJob(job.job_id, { status: 'DONE', review_required: false });
  now += 60_000;
  assert.equal(await intake.reclaimExpired(), 1);
  assert.equal(intake.listJobs().length, 0, 'the job table is empty');
  await fs.rm(intake.accessFile);
  const restarted = new IngestService({ dir, env: {} });
  await assert.rejects(restarted.init(), /access records are missing/u);
  assert.equal(restarted.canReadCase('EXPIRING-CASE'), false);
});

test('C01: while the preference store has not been read, an unknown case is not treated as public', async () => {
  const dir = await tempDir();
  const service = agentService({ dir });
  await service.ingest.init();
  assert.equal(service.preferences.ready, false);
  assert.equal(service.ingest.canReadCase('UNKNOWN-WHILE-LOADING'), false);
  await service.preferences.init();
  assert.equal(service.ingest.canReadCase('UNKNOWN-WHILE-LOADING'), true);
});

// ---------------------------------------------------------------- C02

const event = (id, caseId = 'BUS-CASE') => normalizeEvent({ event_id: id, type: 'DOCUMENTS_INGESTED', case_id: caseId, source: 'admin', data: {} },
  { now: () => new Date('2026-10-29T00:00:00Z') });
const settle = async (bus) => { while (bus.activeRuns.size) await Promise.allSettled([...bus.activeRuns]); };

test('C02: a failed PROCESSING write leaves the event to recover in place, once, by the tick or a retry of its key', async () => {
  const dir = await tempDir();
  const eventsFile = path.join(dir, 'events.jsonl'), indexFile = path.join(dir, 'index.json');
  let handled = 0;
  const bus = new EventBus({ eventsFile, indexFile, handler: async () => { handled += 1; } });
  await bus.submit(event('synthetic-start-failure'));
  const unblock = await block(indexFile);
  bus.start();
  await settle(bus);
  let status = bus.status();
  assert.equal(handled, 0, 'the handler never started');
  assert.equal(status.counts.PROCESSING ?? 0, 0, 'no PROCESSING entry without a run');
  assert.equal(status.counts.RECEIVED, 1);
  assert.equal(status.orphaned, 1, 'the stall is reported, not counted as an empty queue');
  assert.equal(status.processing, 0);
  assert.equal(status.unsaved, true);
  assert.ok(status.last_write_error.message);

  // Still unwritable: the tick reports the failure and keeps the event for later.
  await assert.rejects(bus.recoverOrphans());
  assert.equal(handled, 0);
  await unblock();
  assert.equal(await bus.recoverOrphans(), 1);
  await bus.idle();
  status = bus.status();
  assert.equal(handled, 1);
  assert.equal(status.counts.DONE, 1);
  assert.equal(status.orphaned, 0);
  assert.equal(status.unsaved, false);

  // The same through a retry of the key instead of the tick.
  await bus.stop();
  const again = new EventBus({ eventsFile, indexFile, handler: async () => { handled += 1; } });
  await again.submit(event('synthetic-start-failure-2', 'BUS-CASE-2'));
  const unblockAgain = await block(indexFile);
  again.start();
  await settle(again);
  await unblockAgain();
  const retried = await again.submit(event('synthetic-start-failure-2', 'BUS-CASE-2'));
  assert.equal(retried.duplicate, true);
  assert.equal(retried.requeued, true);
  await again.idle();
  assert.equal(handled, 2);
  await again.stop();
});

test('C02: a failed completion write keeps the outcome, is written again by the tick, and nothing runs twice after a restart', async () => {
  const dir = await tempDir();
  const eventsFile = path.join(dir, 'events.jsonl'), indexFile = path.join(dir, 'index.json');
  let handled = 0, breakOnRun = true, unblock = null;
  const settled = [];
  const handler = async () => { handled += 1; if (breakOnRun) unblock = await block(indexFile); };
  const bus = new EventBus({ eventsFile, indexFile, handler, onSettled: (entry) => settled.push(entry.status) });
  bus.start();
  await bus.submit(event('synthetic-finish-failure'));
  await settle(bus);
  assert.equal(handled, 1);
  assert.deepEqual(settled, ['DONE'], 'the listener hears of the outcome even though the write failed');
  assert.equal(bus.status().unsaved, true);
  assert.equal(bus.status().orphaned, 0, 'a settled event is not an orphan');
  breakOnRun = false;
  await unblock();
  assert.equal(await bus.recoverOrphans(), 0);
  assert.equal(bus.status().unsaved, false);
  await bus.stop();

  const restarted = new EventBus({ eventsFile, indexFile, handler });
  await restarted.init();
  restarted.start();
  await restarted.idle();
  assert.equal(handled, 1, 'DONE was written: the restart does not run it again');
  assert.equal(restarted.get('event:synthetic-finish-failure').status, 'DONE');
  await restarted.stop();
});

test('C02: operations warn while a runtime record write is unsaved, and export it as a metric', async () => {
  const dir = await tempDir();
  let agent = { enabled: true, running: true, mode: 'demo', activity: {}, queue: { queued: 0, dead: 0, orphaned: 0, oldest_pending_ms: 0, unsaved: true },
    intake: { access_state: 'ready', jobs: 1, max_jobs: 10, logical_jobs: 1, held_jobs: 0, review_headroom_jobs: 19, stored_bytes: 1, max_stored_bytes: 100, reclaimable_bytes: 0, unsaved_records: false } };
  const monitor = new OperationsMonitor({ directory: dir, getAgentStatus: async () => agent, probeStorage: async () => ({}), probeRuntimeBytes: async () => 0 });
  await monitor.sample();
  const check = monitor.details().checks.find((item) => item.name === 'persistence');
  assert.equal(check.code, 'runtime_records_unsaved');
  assert.equal(monitor.readiness().ok, true, 'a warning: the tick writes it again');
  assert.match(monitor.metrics(), /agentbl_unsaved_records\{store="event_index"\} 1/u);
  agent = { ...agent, queue: { ...agent.queue, unsaved: false } };
  await monitor.sample();
  assert.equal(monitor.details().checks.find((item) => item.name === 'persistence').ok, true);
});

// ---------------------------------------------------------------- C03

test('C03: an upload whose commit failed leaves nothing visible; its retry commits it, and a restart finds the same job', async () => {
  const dir = await tempDir();
  const intake = new IngestService({ dir, env: {} });
  await intake.init();
  const body = { case_id: 'COMMIT-CASE', documents: [note('Synthetic upload whose commit fails')] };
  const uploads = path.join(dir, 'uploads');

  for (const target of [intake.jobsFile, intake.documentsFile]) {
    const unblock = await block(target);
    await assert.rejects(intake.accept(body, { ownerId: 'owner-a' }));
    assert.equal(intake.listJobs().length, 0, `nothing of the failed commit is visible (${path.basename(target)})`);
    assert.equal(intake.usage().documents, 0);
    assert.equal(intake.usage().unsaved_records, true);
    assert.deepEqual(await fs.readdir(uploads).catch(() => []), [], 'no bytes of the failed request stay');
    await unblock();
  }
  const retried = await intake.accept(body, { ownerId: 'owner-a' });
  assert.equal(retried.created, true, 'the retry commits instead of answering from memory');
  assert.equal(intake.usage().unsaved_records, false);

  const restarted = new IngestService({ dir, env: {} });
  await restarted.init();
  assert.equal(restarted.getJob(retried.job.job_id).status, 'INTERRUPTED', 'the same job, recorded (it never ran here)');
  assert.equal(restarted.listJobs().length, 1, 'no duplicate job');
  assert.equal(restarted.usage().documents, 1);
  assert.equal(restarted.getAccess('COMMIT-CASE').owner_id, 'owner-a');
  assert.equal((await fs.readdir(uploads)).length, 1, 'one sealed file, no orphans');
});

test('C03: a blob write that fails is retried cleanly; document records a failed job write left on disk are removed at start', async () => {
  const dir = await tempDir();
  const intake = new IngestService({ dir, env: {} });
  await intake.init();
  const text = 'Synthetic upload whose bytes cannot be written';
  // A file where the uploads folder should be: the sealed bytes cannot be written.
  const uploads = path.join(dir, 'uploads');
  await fs.rm(uploads, { recursive: true, force: true });
  await fs.writeFile(uploads, 'not a folder');
  await assert.rejects(intake.accept({ case_id: 'BLOB-CASE', documents: [note(text)] }, { ownerId: 'owner-a' }));
  assert.equal(intake.usage().documents, 0);
  assert.equal(intake.listJobs().length, 0);
  await fs.rm(uploads);
  assert.equal((await intake.accept({ case_id: 'BLOB-CASE', documents: [note(text)] }, { ownerId: 'owner-a' })).created, true);

  // A crash between the document and the job writes: the documents file names a document no job references.
  const stray = JSON.parse(await fs.readFile(intake.documentsFile, 'utf8'));
  const [one] = Object.values(stray);
  stray.doc_stray0000000000 = { ...one, document_id: 'doc_stray0000000000', sha256: `0x${'0'.repeat(64)}`, stored_as: `uploads/${'0'.repeat(64)}.txt.sealed` };
  await fs.writeFile(intake.documentsFile, JSON.stringify(stray));
  const restarted = new IngestService({ dir, env: {} });
  await restarted.init();
  assert.equal(restarted.getDocument('doc_stray0000000000'), null);
  assert.equal(restarted.usage().documents, 1);
});

test('C03: an idempotent retry confirms a job only once memory is written to disk', async () => {
  const dir = await tempDir();
  const intake = new IngestService({ dir, env: {} });
  await intake.init();
  const body = { case_id: 'UNSAVED-CASE', documents: [note('Synthetic upload updated while the disk fails')] };
  const { job } = await intake.accept(body, { ownerId: 'owner-a' });
  const unblock = await block(intake.jobsFile);
  await assert.rejects(intake.updateJob(job.job_id, { status: 'RUNNING' }));
  await assert.rejects(intake.accept(body, { ownerId: 'owner-a' }), 'the retry says the disk still fails rather than confirming');
  await unblock();
  const retried = await intake.accept(body, { ownerId: 'owner-a' });
  assert.equal(retried.created, false);
  assert.equal(JSON.parse(await fs.readFile(intake.jobsFile, 'utf8'))[job.job_id].status, 'RUNNING');
  assert.equal(await intake.saveUnsaved(), true);
});

// ---------------------------------------------------------------- C05

async function heldJob(intake, caseId, text, ownerId = 'owner-a') {
  const { job } = await intake.accept({ case_id: caseId, documents: [note(text)] }, { ownerId });
  await intake.updateJob(job.job_id, { status: 'DONE', review_required: true });
  return job;
}

test('C05: held material filling the byte quota never blocks its own correction; the reserve is bounded and says what holds it', async () => {
  const text = 'x'.repeat(100);
  const intake = new IngestService({ maxOwnerBytes: 100, maxStoredBytes: 1000, reviewReserveBytes: 10 });
  const held = await heldJob(intake, 'FULL-CASE', text);
  const refused = await intake.accept({ case_id: 'OTHER-CASE', documents: [note('y')] }, { ownerId: 'owner-a' }).catch((error) => error);
  assert.equal(refused.code, 'upload_quota_exceeded');
  assert.deepEqual({ ...refused.details, reclaimable_bytes: undefined }, { scope: 'workspace', used_bytes: 100, limit_bytes: 100, incoming_bytes: 1, reclaimable_bytes: undefined,
    held_jobs: 1, held_job_ids: [held.job_id], next_step: 'correct_or_withdraw_held_jobs' });

  // The correction the refusal asks for fits in the reserve (the audit's case: one byte more than a full quota).
  const review = await intake.accept({ case_id: 'FULL-CASE', documents: [note('!')] }, { reviewOf: held.job_id, ownerId: 'owner-a' });
  assert.equal(review.created, true);
  // Held again: its correction may not grow the store past quota + reserve, and nothing else may use the reserve.
  await intake.updateJob(review.job.job_id, { status: 'DONE', review_required: true });
  const beyond = await intake.accept({ case_id: 'FULL-CASE', documents: [note('z'.repeat(20))] }, { reviewOf: review.job.job_id, ownerId: 'owner-a' }).catch((error) => error);
  assert.equal(beyond.code, 'upload_quota_exceeded');
  assert.equal(beyond.details.limit_bytes, 110);
  assert.equal((await intake.accept({ case_id: 'FULL-CASE', documents: [note('z'.repeat(9))] }, { reviewOf: review.job.job_id, ownerId: 'owner-a' })).created, true);
  assert.equal(intake.usage().stored_bytes, 110);
});

test('C05: withdrawing a held job releases its bytes now, keeps its records, frees its slot and cannot be corrected afterwards', async (t) => {
  const app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); });
  const service = agentService({ ingest: new IngestService({ maxOwnerBytes: 120, maxJobs: 10, maxOwnerJobs: 2, reviewReserveBytes: 10 }) });
  await service.start();
  t.after(() => service.stop());
  setAgentService(service);
  const owner = workspace(app.base), stranger = workspace(app.base);
  const intake = service.ingest;
  const first = await heldJob(intake, 'WITHDRAW-CASE', 'a'.repeat(100), owner.ownerId);
  const review = await intake.accept({ case_id: 'WITHDRAW-CASE', documents: [note('b'.repeat(15))] }, { reviewOf: first.job_id, ownerId: owner.ownerId });
  await intake.updateJob(review.job.job_id, { status: 'DONE', review_required: true, decision_ids: ['dec_synthetic_review'] });
  await assert.rejects(intake.accept({ case_id: 'NEXT-CASE', documents: [note('c'.repeat(10))] }, { ownerId: owner.ownerId }), { code: 'upload_quota_exceeded' });

  // Only the owner withdraws; only the head of the chain waits for a correction.
  assert.equal((await stranger.request('POST', `/api/agent/jobs/${review.job.job_id}/withdraw`, {})).status, 404);
  assert.equal((await owner.request('POST', `/api/agent/jobs/${first.job_id}/withdraw`, {})).data.code, 'job_not_withdrawable');
  const withdrawn = await owner.request('POST', `/api/agent/jobs/${review.job.job_id}/withdraw`, {});
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(withdrawn.data.withdrawn.sort(), [first.job_id, review.job.job_id].sort());
  assert.equal(intake.usage().stored_bytes, 0, 'the raw bytes of every version are released now');
  assert.equal(intake.usage().held_jobs, 0);
  assert.equal(intake.usage().logical_jobs, 0, 'withdrawn records hold no slot');
  const kept = intake.getJob(review.job.job_id);
  assert.equal(kept.status, 'WITHDRAWN');
  assert.equal(kept.withdrawn_from, 'DONE');
  assert.deepEqual(kept.decision_ids, ['dec_synthetic_review'], 'the review decisions stay linked');

  const corrected = await owner.request('POST', `/api/agent/jobs/${review.job.job_id}/review`, { note: 'retry', documents: [note('d')] });
  assert.equal(corrected.status, 409);
  assert.equal((await intake.accept({ case_id: 'NEXT-CASE', documents: [note('c'.repeat(10))] }, { ownerId: owner.ownerId })).created, true);
});

// ---------------------------------------------------------------- C06

test('C06: every held job is reachable, listed first, and counted by the server; versions a correction took over are not to-dos', async (t) => {
  const app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); });
  let tick = Date.parse('2026-10-01T00:00:00.000Z');
  const service = agentService({ ingest: new IngestService({ now: () => new Date(tick += 1000) }) });
  await service.start();
  t.after(() => service.stop());
  setAgentService(service);
  const owner = workspace(app.base), stranger = workspace(app.base);
  const intake = service.ingest;
  const held = [];
  for (let i = 0; i < 9; i += 1) held.push(await heldJob(intake, 'HISTORY-CASE', `Synthetic incomplete document ${i}`, owner.ownerId));
  for (let i = 0; i < 3; i += 1) {
    const { job } = await intake.accept({ case_id: 'HISTORY-CASE', documents: [note(`Synthetic complete document ${i}`)] }, { ownerId: owner.ownerId });
    await intake.updateJob(job.job_id, { status: 'DONE', review_required: false });
  }

  const page = await owner.request('GET', '/api/agent/jobs?case_id=HISTORY-CASE&limit=8');
  assert.equal(page.data.total, 12);
  assert.equal(page.data.held_total, 9);
  assert.equal(page.data.jobs.length, 8);
  assert.ok(page.data.jobs.every((job) => job.review_state === 'open'), 'the to-dos come first');
  assert.equal(page.data.next_offset, 8);
  const rest = await owner.request('GET', '/api/agent/jobs?case_id=HISTORY-CASE&limit=8&offset=8');
  assert.equal(rest.data.jobs[0].job_id, held[0].job_id, 'the oldest held job is on the next page');
  assert.equal(rest.data.next_offset, null);
  assert.equal(new Set([...page.data.jobs, ...rest.data.jobs].map((job) => job.job_id)).size, 12);
  assert.equal((await stranger.request('GET', '/api/agent/jobs?case_id=HISTORY-CASE')).data.total, 0);

  // The oldest held job is corrected: it is taken over, then resolved, and the count follows the whole chain.
  const review = await owner.request('POST', `/api/agent/jobs/${held[0].job_id}/review`, { note: 'corrected', documents: [note('Synthetic corrected document 0')] });
  assert.equal(review.status, 202);
  await intake.updateJob(review.data.job.job_id, { status: 'DONE', review_required: true });
  let listed = (await owner.request('GET', '/api/agent/jobs?case_id=HISTORY-CASE&limit=50')).data;
  let original = listed.jobs.find((job) => job.job_id === held[0].job_id);
  assert.equal(original.review_state, 'superseded');
  assert.equal(original.reviewed_by, review.data.job.job_id);
  assert.equal(listed.held_total, 9, 'the correction is the to-do now, not both');
  await intake.updateJob(review.data.job.job_id, { status: 'DONE', review_required: false, result_action: 'OPEN' });
  listed = (await owner.request('GET', '/api/agent/jobs?case_id=HISTORY-CASE&limit=50')).data;
  original = listed.jobs.find((job) => job.job_id === held[0].job_id);
  assert.equal(original.review_state, 'resolved');
  assert.equal(listed.held_total, 8);
  assert.equal(intake.usage().held_jobs, 8, 'operations count the same to-dos');
});
