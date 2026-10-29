// What happens when part of the intake fails (application audit 2026-10-29, B01-B05): reads while the case access
// records are missing, corrupt or still loading; a review when held jobs fill the quota; bytes retention released
// while nothing new is uploaded; a review whose event was never delivered; and an event bus write that fails.
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

const SAMPLE = 'CASE-EBL-CU-SIN-SHA';
const note = (text) => ({ name: 'synthetic-note.txt', mime_type: 'text/plain', text });
const temporary = [];
const tempDir = async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-recovery-')); temporary.push(dir); return dir; };
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

/** A browser workspace with a fixed cookie, and the owner id the server derives from it. */
function workspace(base) {
  const value = crypto.randomBytes(24).toString('hex');
  const ownerId = crypto.createHash('sha256').update(value).digest('hex');
  return { ownerId, request: (method, route, body) => requestJson(base, method, route, body, { Cookie: `agentbl_workspace=${value}` }) };
}

// ---------------------------------------------------------------- B01

test('B01: with missing, corrupt or still-loading access records no private case is readable; a restored file restores the owner', async (t) => {
  const app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); });
  const dir = await tempDir();
  const owner = workspace(app.base), stranger = workspace(app.base);
  const route = '/api/agent/cases/PRIVATE-RECOVERY-CASE/preferences';

  const first = agentService({ dir });
  await first.start();
  setAgentService(first);
  assert.equal((await owner.request('PUT', route, { min_acceptable_issue_price: 0.73 })).status, 200);
  assert.equal((await stranger.request('GET', route)).status, 404);
  assert.equal((await requestJson(app.base, 'GET', route)).status, 404);
  await first.stop();

  // The access file is corrupted; the restarted runtime cannot start, but its preferences still load.
  const accessFile = first.ingest.accessFile;
  const saved = await fs.readFile(accessFile);
  await fs.writeFile(accessFile, '{ synthetic corruption');
  const second = agentService({ dir });
  setAgentService(second);
  await assert.rejects(second.start());
  await second.preferences.init();
  assert.equal(second.ingest.accessState, 'failed');
  for (const caller of [() => requestJson(app.base, 'GET', route), () => stranger.request('GET', route), () => owner.request('GET', route)]) {
    const read = await caller();
    assert.equal(read.status, 503, 'nobody reads a private case whose owner cannot be established');
    assert.equal(read.data.code, 'case_access_unavailable');
    assert.doesNotMatch(read.text, /0\.73/u);
  }
  // Curated samples stay public; the private case list says it is unavailable rather than empty.
  assert.equal((await requestJson(app.base, 'GET', `/api/agent/cases/${SAMPLE}/preferences`)).status, 200);
  assert.equal((await requestJson(app.base, 'GET', '/api/agent/workspace/cases')).data.code, 'case_access_unavailable');

  // Restored file, new process: the owner reads again, nobody else does.
  await fs.writeFile(accessFile, saved);
  const third = agentService({ dir });
  setAgentService(third);
  // Not initialised yet: the request waits for the records instead of being refused while they load.
  const loading = owner.request('GET', route);
  assert.notEqual(third.ingest.accessState, 'ready');
  const read = await loading;
  assert.equal(read.status, 200);
  assert.equal(read.data.preferences.min_acceptable_issue_price, 0.73);
  assert.equal((await stranger.request('GET', route)).status, 404);
  assert.equal((await requestJson(app.base, 'GET', route)).status, 404);
  await third.stop();
});

test('B01: an unloaded or failed access store refuses every reader but an operator, and never reads an unknown case as public', async () => {
  const dir = await tempDir();
  const intake = new IngestService({ dir, env: {} });
  await intake.init();
  await intake.claimCase('OWNED-CASE', { ownerId: 'owner-a' });
  await intake.claimCase('PUBLISHED-CASE', { ownerId: 'operator', visibility: 'public-demo' });

  const pending = new IngestService({ dir, env: {} });
  assert.equal(pending.accessState, 'unloaded');
  for (const caseId of ['OWNED-CASE', 'PUBLISHED-CASE', 'NEVER-SEEN-CASE']) {
    assert.equal(pending.isPrivateCase(caseId), true, caseId);
    assert.equal(pending.canReadCase(caseId), false, caseId);
    assert.equal(pending.canReadCase(caseId, { ownerId: 'owner-a' }), false, caseId);
    assert.equal(pending.canReadCase(caseId, { admin: true }), true, caseId);
  }
  assert.equal(pending.canReadCase(SAMPLE), true, 'a curated sample is public by its own list');
  assert.equal(pending.canReadJob({ owner_id: 'owner-a', visibility: 'private' }, { ownerId: 'owner-a' }), false);
  assert.equal(pending.canReadUploadRecord('OWNED-CASE', 'ingest:job_0123456789abcdef0123', { ownerId: 'owner-a' }), false);
  await pending.init();
  assert.equal(pending.canReadCase('OWNED-CASE', { ownerId: 'owner-a' }), true);
  assert.equal(pending.canReadCase('PUBLISHED-CASE'), true);
  assert.equal(pending.canReadCase('NEVER-SEEN-CASE'), true, 'once loaded, a case nobody claimed is not private');

  // Missing after jobs proved it existed: the load fails and stays fail-closed.
  await intake.accept({ case_id: 'OWNED-CASE', documents: [note('Synthetic owned upload')] }, { ownerId: 'owner-a' });
  await fs.rm(intake.accessFile);
  const missing = new IngestService({ dir, env: {} });
  await assert.rejects(missing.init(), /access records are missing/u);
  assert.equal(missing.accessState, 'failed');
  assert.equal(missing.canReadCase('NEVER-SEEN-CASE'), false);
  assert.equal(missing.canReadCase('OWNED-CASE', { ownerId: 'owner-a' }), false);
  assert.equal(missing.usage().access_state, 'failed');
});

test('a preference saved while the store is still loading keeps what was saved before', async () => {
  const { PreferenceStore } = await import('../src/agent/runtime/preferences.js');
  const file = path.join(await tempDir(), 'preferences.json');
  await new PreferenceStore({ file }).put('EARLIER-CASE', { min_acceptable_issue_price: 0.7 });
  const store = new PreferenceStore({ file });
  await Promise.all([store.init(), store.put('LATER-CASE', { min_acceptable_issue_price: 0.8 })]);
  const reread = new PreferenceStore({ file });
  await reread.init();
  assert.equal(reread.get('EARLIER-CASE').min_acceptable_issue_price, 0.7);
  assert.equal(reread.get('LATER-CASE').min_acceptable_issue_price, 0.8);
});

// ---------------------------------------------------------------- B02

test('B02: held jobs filling the quota can still be corrected once each; versions stay bounded and are all kept', async () => {
  const intake = new IngestService({ maxJobs: 4, maxOwnerJobs: 2 });
  const held = [];
  for (let i = 0; i < 2; i += 1) {
    const { job } = await intake.accept({ case_id: `HELD-${i}`, documents: [note(`Synthetic held upload ${i}`)] }, { ownerId: 'owner' });
    await intake.updateJob(job.job_id, { status: 'DONE', review_required: true });
    held.push(job);
  }
  await assert.rejects(intake.accept({ case_id: 'NEW-CASE', documents: [note('Synthetic new upload')] }, { ownerId: 'owner' }), { code: 'upload_job_quota_exceeded' });

  // The correction the refusal asks for is accepted: it takes over the held job's slot.
  const review = await intake.accept({ case_id: held[0].case_id, documents: [note('Synthetic corrected upload 0')] }, { reviewOf: held[0].job_id, ownerId: 'owner' });
  assert.equal(review.created, true);
  assert.equal(review.job.reviewed_job_id, held[0].job_id);
  assert.equal(review.job.event_id, `review:${review.job.job_id}`);
  assert.ok(intake.getJob(held[0].job_id), 'the held version is kept, not discarded');
  assert.equal(intake.usage().logical_jobs, 2);
  // A second, parallel correction of the same held job is a new logical job and the quota applies to it.
  await assert.rejects(intake.accept({ case_id: held[0].case_id, documents: [note('Another synthetic correction 0')] }, { reviewOf: held[0].job_id, ownerId: 'owner' }),
    { code: 'upload_job_quota_exceeded' });
  // The review is held again and corrected again: still one logical job.
  await intake.updateJob(review.job.job_id, { status: 'DONE', review_required: true });
  const second = await intake.accept({ case_id: held[0].case_id, documents: [note('Synthetic corrected upload 0, second pass')] }, { reviewOf: review.job.job_id, ownerId: 'owner' });
  assert.equal(second.created, true);
  assert.equal(intake.usage().logical_jobs, 2);
  // The table holds at most twice the quota: here the workspace's four versions.
  await assert.rejects(intake.accept({ case_id: held[1].case_id, documents: [note('Synthetic corrected upload 1')] }, { reviewOf: held[1].job_id, ownerId: 'owner' }),
    { code: 'review_capacity_exhausted', status: 507 });
  assert.equal(intake.jobs.size, 4);
});

test('B02: a full intake still lets every workspace correct its held job, and a finished correction releases the whole chain', async () => {
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  const intake = new IngestService({ maxJobs: 2, maxOwnerJobs: 1, jobRetentionMs: 86_400_000, now: () => new Date(now) });
  const held = {};
  for (const owner of ['owner-a', 'owner-b']) {
    const { job } = await intake.accept({ case_id: `HELD-${owner}`, documents: [note(`Synthetic held upload of ${owner}`)] }, { ownerId: owner });
    await intake.updateJob(job.job_id, { status: 'DONE', review_required: true });
    held[owner] = job;
  }
  await assert.rejects(intake.accept({ case_id: 'NEW-C', documents: [note('Synthetic upload of a third workspace')] }, { ownerId: 'owner-c' }), { code: 'intake_jobs_full' });
  const reviews = {};
  for (const owner of ['owner-a', 'owner-b']) {
    reviews[owner] = (await intake.accept({ case_id: held[owner].case_id, documents: [note(`Synthetic correction of ${owner}`)] }, { reviewOf: held[owner].job_id, ownerId: owner })).job;
  }
  assert.equal(intake.usage().held_jobs, 0, 'every held job is now under review');

  // owner-a's correction is accepted: after the retention period its review and the held original both leave.
  await intake.updateJob(reviews['owner-a'].job_id, { status: 'DONE', review_required: false, result_action: 'OPEN' });
  await intake.updateJob(reviews['owner-b'].job_id, { status: 'DONE', review_required: true });
  now += 2 * 86_400_000;
  assert.equal(await intake.reclaimExpired(), 2);
  assert.equal(intake.getJob(held['owner-a'].job_id), null);
  assert.equal(intake.getJob(reviews['owner-a'].job_id), null);
  assert.ok(intake.getJob(held['owner-b'].job_id), 'a chain still waiting for review stays');
  assert.ok(intake.getJob(reviews['owner-b'].job_id));
});

// ---------------------------------------------------------------- B03

test('B03: bytes retention released come back before the quota is checked, at start and on reclaim, never shared ones', async () => {
  const dir = await tempDir();
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  const options = { dir, env: {}, maxOwnerBytes: 100, maxStoredBytes: 160, jobRetentionMs: 1000, now: () => new Date(now) };
  const intake = new IngestService(options);
  const full = await intake.accept({ case_id: 'AGED-UPLOAD', documents: [note('a'.repeat(100))] }, { ownerId: 'owner' });
  await intake.updateJob(full.job.job_id, { status: 'DONE', review_required: false });
  await assert.rejects(intake.accept({ case_id: 'TOO-EARLY', documents: [note('new')] }, { ownerId: 'owner' }), { code: 'upload_quota_exceeded' });

  // Past retention, the next upload fits: the expired job left before the quota was counted.
  now += 60_000;
  const after = await intake.accept({ case_id: 'AFTER-EXPIRY', documents: [note('new')] }, { ownerId: 'owner' });
  assert.equal(after.created, true);
  assert.equal(intake.usage().stored_bytes, 3);
  await assert.rejects(fs.stat(path.join(dir, full.documents[0].stored_as)), { code: 'ENOENT' });

  // Without any upload: the agent's tick (reclaimExpired) and a restart release expired bytes too.
  await intake.updateJob(after.job.job_id, { status: 'DONE', review_required: false });
  now += 60_000;
  assert.equal(intake.usage().reclaimable_bytes, 3);
  assert.equal(await intake.reclaimExpired(), 1);
  assert.equal(intake.usage().stored_bytes, 0);

  const shared = 'Synthetic content two workspaces both uploaded';
  const a = await intake.accept({ case_id: 'SHARED-A', documents: [note(shared)] }, { ownerId: 'owner-a' });
  const b = await intake.accept({ case_id: 'SHARED-B', documents: [note(shared), note('Synthetic second file of b')] }, { ownerId: 'owner-b' });
  await intake.updateJob(a.job.job_id, { status: 'DONE', review_required: false });
  await intake.updateJob(b.job.job_id, { status: 'DONE', review_required: true });
  now += 60_000;
  const restarted = new IngestService(options);
  await restarted.init();
  assert.equal(restarted.getJob(a.job.job_id), null, 'the expired job left at start');
  assert.ok(restarted.getJob(b.job.job_id));
  assert.ok(await fs.stat(path.join(dir, a.documents[0].stored_as)), 'content a held job still references stays');
  assert.equal((await restarted.loadDocuments(b.job.document_ids))[0].text, shared);
});

// ---------------------------------------------------------------- B04

test('B04: a review stored before its event was delivered is delivered on retry, once; a failed review retries under a new attempt', async (t) => {
  const service = agentService();
  await service.start();
  t.after(() => service.stop());
  const held = (await service.ingest.accept({ case_id: 'REVIEW-RETRY', documents: [note('Synthetic original held upload')] }, { ownerId: 'owner' })).job;
  await service.ingest.updateJob(held.job_id, { status: 'DONE', review_required: true });

  const submit = service.submitEvent.bind(service);
  let calls = 0;
  service.submitEvent = async (...args) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('Synthetic event delivery failure'), { code: 'EIO' });
    return submit(...args);
  };
  const body = { note: 'Synthetic corrected evidence', documents: [note('Synthetic corrected upload')] };
  await assert.rejects(service.reviewDocuments(held.job_id, body), /Synthetic event delivery failure/u);
  const stranded = service.ingest.listJobs({ case_id: 'REVIEW-RETRY' }).find((job) => job.job_id !== held.job_id);
  assert.equal(stranded.status, 'QUEUED');
  assert.equal(stranded.reviewed_job_id, held.job_id, 'the job records what it reviews when it is created');

  const retry = await service.reviewDocuments(held.job_id, body);
  assert.equal(retry.job.job_id, stranded.job_id);
  assert.equal(calls, 2);
  const settled = await service.waitFor(retry.idempotency_key, 30_000);
  assert.equal(settled.status, 'DONE');
  const processed = service.ingest.getJob(stranded.job_id);
  assert.notEqual(processed.status, 'QUEUED');
  // Once delivered, another retry neither delivers nor decides again.
  const again = await service.reviewDocuments(held.job_id, body);
  assert.equal(calls, 2);
  assert.deepEqual(service.ingest.getJob(stranded.job_id).decision_ids, processed.decision_ids);
  assert.equal(again.idempotency_key, retry.idempotency_key);

  // A review that failed is retried as a new attempt, with an event the bus has not seen.
  await service.ingest.updateJob(stranded.job_id, { status: 'FAILED' });
  const attempt = await service.reviewDocuments(held.job_id, body);
  assert.equal(attempt.job.event_id, `review:${stranded.job_id}:attempt-2`);
  assert.equal((await service.waitFor(attempt.idempotency_key, 30_000)).status, 'DONE');
  assert.notEqual(service.ingest.getJob(stranded.job_id).status, 'QUEUED');
});

// ---------------------------------------------------------------- B05

const event = (id, caseId = 'BUS-CASE') => normalizeEvent({ event_id: id, type: 'DOCUMENTS_INGESTED', case_id: caseId, source: 'admin', data: {} },
  { now: () => new Date('2026-10-29T00:00:00Z') });

test('B05: an event whose audit line or index write failed is not a duplicate; the retry records, queues and runs it once', async () => {
  const dir = await tempDir();
  const eventsFile = path.join(dir, 'events.jsonl'), indexFile = path.join(dir, 'index.json');
  let handled = 0;
  const bus = new EventBus({ eventsFile, indexFile, handler: async () => { handled += 1; } });
  bus.start();

  await fs.mkdir(eventsFile); // the audit log cannot be written
  await assert.rejects(bus.submit(event('synthetic-log-failure')));
  assert.equal(bus.get('event:synthetic-log-failure'), null, 'nothing of the failed attempt is visible');
  await fs.rmdir(eventsFile);
  const retried = await bus.submit(event('synthetic-log-failure'));
  assert.equal(retried.accepted, true);
  assert.equal(retried.duplicate, false);
  await bus.idle();
  assert.equal(handled, 1);
  assert.match(await fs.readFile(eventsFile, 'utf8'), /synthetic-log-failure/u);

  await fs.rm(indexFile, { force: true });
  await fs.mkdir(indexFile); // the index cannot be written
  await assert.rejects(bus.submit(event('synthetic-index-failure', 'BUS-CASE-2')));
  assert.equal(bus.get('event:synthetic-index-failure'), null);
  await fs.rmdir(indexFile);
  assert.equal((await bus.submit(event('synthetic-index-failure', 'BUS-CASE-2'))).accepted, true);
  await bus.idle();
  assert.equal(handled, 2);
  assert.equal(bus.status().orphaned, 0);
  await bus.stop();
});

test('B05: concurrent submissions of one key run once; an accepted event survives a restart; an orphan is found and requeued', async () => {
  const dir = await tempDir();
  const eventsFile = path.join(dir, 'events.jsonl'), indexFile = path.join(dir, 'index.json');
  let handled = 0;
  const handler = async () => { handled += 1; };
  const bus = new EventBus({ eventsFile, indexFile, handler });
  bus.start();
  const results = await Promise.all([bus.submit(event('synthetic-concurrent')), bus.submit(event('synthetic-concurrent')), bus.submit(event('synthetic-concurrent'))]);
  assert.equal(results.filter((result) => result.accepted).length, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 2);
  await bus.idle();
  assert.equal(handled, 1);
  await bus.stop();

  // Accepted while nothing ran: a new process picks it up from the index, once.
  const stopped = new EventBus({ eventsFile, indexFile, handler });
  await stopped.submit(event('synthetic-restart', 'RESTART-CASE'));
  const restarted = new EventBus({ eventsFile, indexFile, handler });
  await restarted.init();
  restarted.start();
  await restarted.idle();
  assert.equal(handled, 2);
  assert.equal((await restarted.submit(event('synthetic-restart', 'RESTART-CASE'))).duplicate, true);
  await restarted.idle();
  assert.equal(handled, 2);

  // An entry RECEIVED with its payload but in no queue (as an older version could leave one) is reported and requeued.
  const orphan = event('synthetic-orphan', 'ORPHAN-CASE');
  restarted.entries.set(orphan.idempotency_key, { idempotency_key: orphan.idempotency_key, event_id: orphan.event_id, case_id: orphan.case_id, type: orphan.type,
    occurred_at: orphan.occurred_at, status: 'RECEIVED', attempts: 0, received_at: new Date(Date.now() - 3_600_000).toISOString(), updated_at: orphan.occurred_at, event: orphan });
  assert.equal(restarted.status().orphaned, 1);
  assert.ok(restarted.status().oldest_pending_ms > 0);
  const duplicate = await restarted.submit(orphan);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.requeued, true);
  await restarted.idle();
  assert.equal(handled, 3);
  assert.equal(restarted.status().orphaned, 0);
  assert.equal(await restarted.recoverOrphans(), 0);
  await restarted.stop();
});

// ---------------------------------------------------------------- monitoring

test('operations report stalled events, an unloaded access store and intake capacity, and export them as metrics', async () => {
  const dir = await tempDir();
  let agent = { enabled: true, running: true, mode: 'demo', activity: {}, queue: { queued: 0, dead: 0, orphaned: 1, oldest_pending_ms: 1000 },
    intake: { access_state: 'ready', jobs: 4, max_jobs: 10, logical_jobs: 2, held_jobs: 1, review_headroom_jobs: 16, stored_bytes: 10, max_stored_bytes: 100, reclaimable_bytes: 7 } };
  const monitor = new OperationsMonitor({ directory: dir, getAgentStatus: async () => agent, probeStorage: async () => ({}), probeRuntimeBytes: async () => 0 });
  await monitor.sample();
  assert.equal(monitor.readiness().ok, true, 'a stalled event is a warning: the tick requeues it');
  assert.equal(monitor.details().checks.find((check) => check.name === 'event_flow').code, 'events_not_queued');
  const metrics = monitor.metrics();
  assert.match(metrics, /agentbl_events_orphaned 1/u);
  assert.match(metrics, /agentbl_intake_held_jobs 1/u);
  assert.match(metrics, /agentbl_intake_reclaimable_bytes 7/u);

  agent = { ...agent, queue: { queued: 0, dead: 0, orphaned: 0, oldest_pending_ms: 60 * 60_000 } };
  await monitor.sample();
  assert.equal(monitor.details().checks.find((check) => check.name === 'event_flow').code, 'events_waiting');

  agent = { ...agent, queue: { queued: 0, dead: 0, orphaned: 0, oldest_pending_ms: 0 }, intake: { ...agent.intake, access_state: 'failed', logical_jobs: 9 } };
  await monitor.sample();
  assert.equal(monitor.readiness().ok, false, 'without access records new intake stops');
  const codes = monitor.details().checks.filter((check) => !check.ok).map((check) => check.code);
  assert.deepEqual(codes.sort(), ['case_access_unavailable', 'intake_jobs_near_full']);
});

test('the agent status carries the bus consistency and intake counts the monitor reads, and the tick reclaims expired uploads', async (t) => {
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  const service = agentService({ ingest: new IngestService({ jobRetentionMs: 1000, now: () => new Date(now) }) });
  await service.init();
  t.after(() => service.stop());
  const { job } = await service.ingest.accept({ case_id: 'TICK-CASE', documents: [note('Synthetic upload the tick releases')] }, { ownerId: 'owner' });
  await service.ingest.updateJob(job.job_id, { status: 'DONE', review_required: false });
  now += 60_000;
  const before = await service.status();
  assert.equal(before.queue.orphaned, 0);
  assert.equal(before.intake.access_state, 'ready');
  assert.ok(before.intake.reclaimable_bytes > 0);
  const result = await service.tick();
  assert.equal(result.requeued, 0);
  assert.equal((await service.status()).intake.stored_bytes, 0);
});
