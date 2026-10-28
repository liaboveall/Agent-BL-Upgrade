// Who may read an uploaded case, and what happens to the raw bytes, across the whole intake lifecycle:
// job retention, failed batches, restarts, the Demo reset and degraded operations (application review F1, F4, F5, F7),
// and the follow-up audit: first-write ownership of working copies (A01), retention that never depends on other
// workspaces' volume (A02) and retries of a job stranded before its event (A05).
import assert from 'node:assert/strict';
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
const { isNewIntake } = await import('../src/app/operationsRoutes.js');

const SAMPLE = 'CASE-EBL-CU-SIN-SHA';
const note = (text) => ({ name: 'synthetic-note.txt', mime_type: 'text/plain', text });

async function freshService(options = {}) {
  resetStore();
  storeState.agentActivities = [];
  const service = createAgentService({
    config: loadAgentConfig({ AGENT_VALUATION_LLM: 'false', AGENT_COOLDOWN_SEC: '0' }),
    env: {}, demoModeController, ensurePools: async () => {}, activity: activityLog, store: storeState,
    chainConfig: loadApplicationConfig(), getChainContext: async () => null, sleep: async () => {}, ...options
  });
  await service.start();
  setAgentService(service);
  return service;
}

/** One browser: keeps the workspace cookie the server hands out. */
function browser(base) {
  let cookie;
  return async (method, route, body, headers = {}) => {
    const result = await requestJson(base, method, route, body, { ...(cookie ? { Cookie: cookie } : {}), ...headers });
    cookie ??= result.headers.get('set-cookie')?.split(';')[0];
    return result;
  };
}

const temporary = [];
const tempDir = async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-intake-')); temporary.push(dir); return dir; };
after(() => Promise.all(temporary.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

test('a held private case keeps its job and bytes however much other workspaces upload, and stays private (F1, A02)', async (t) => {
  const app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); });
  const service = await freshService({ config: loadAgentConfig({ AGENT_VALUATION_LLM: 'false', AGENT_COOLDOWN_SEC: '0', AGENT_INGEST_MAX_JOBS: '20', AGENT_INGEST_WORKSPACE_MAX_JOBS: '10' }) });
  t.after(() => service.stop());
  const owner = browser(app.base), stranger = browser(app.base);

  const uploaded = await owner('POST', '/api/agent/ingest?wait=1', { case_id: 'PRIVATE-HELD-REVIEW', exporter_preferences: { min_acceptable_issue_price: 0.73 },
    documents: [note('Synthetic incomplete invoice for a fictional client, reference ABC-ONLY-REVIEW.')] });
  assert.equal(uploaded.status, 202);
  assert.equal(uploaded.data.job.result_action, 'HOLD_FOR_REVIEW');
  const decisionId = uploaded.data.job.decision_ids[0];
  assert.ok(decisionId);
  assert.equal((await stranger('GET', `/api/agent/decisions/${decisionId}`)).status, 404);

  // Other workspaces fill the shared job table. Nothing they do removes the held job: the next upload is refused instead.
  for (let i = 0; i < 19; i += 1) await service.ingest.accept({ case_id: `OTHER-${i}`, documents: [note(`Synthetic other upload ${i}`)] }, { ownerId: `another-workspace-${i % 2}` });
  await assert.rejects(service.ingest.accept({ case_id: 'OTHER-ONE-TOO-MANY', documents: [note('Synthetic upload over the cap')] }, { ownerId: 'another-workspace-0' }),
    { code: 'upload_job_quota_exceeded', status: 413 });
  await assert.rejects(service.ingest.accept({ case_id: 'OTHER-FULL', documents: [note('Synthetic upload into a full table')] }, { ownerId: 'third-workspace' }),
    { code: 'intake_jobs_full', status: 507 });
  const held = service.ingest.getJob(uploaded.data.job.job_id);
  assert.equal(held.review_required, true, 'the held job is still there to review');
  assert.match((await service.ingest.loadDocuments(held.document_ids))[0].text, /ABC-ONLY-REVIEW/u, 'and so are its bytes');
  const refused = await stranger('POST', '/api/agent/ingest', { case_id: 'STRANGER-FULL', documents: [note('Synthetic upload refused over HTTP')] });
  assert.equal(refused.status, 507);
  assert.equal(refused.data.code, 'intake_jobs_full');

  assert.equal((await stranger('GET', `/api/agent/decisions/${decisionId}`)).status, 404);
  assert.equal((await stranger('GET', '/api/agent/decisions?case_id=PRIVATE-HELD-REVIEW')).data.count, 0);
  assert.equal((await stranger('GET', '/api/agent/cases/PRIVATE-HELD-REVIEW/preferences')).status, 404);
  const own = await owner('GET', '/api/agent/cases/PRIVATE-HELD-REVIEW/preferences');
  assert.equal(own.status, 200);
  assert.equal(own.data.preferences.min_acceptable_issue_price, 0.73);
  assert.equal((await owner('GET', `/api/agent/decisions/${decisionId}`)).status, 200);
});

test('only finished jobs past their retention leave; queued, running and held jobs keep their sealed bytes across a restart (A02)', async () => {
  const dir = await tempDir();
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  const options = { dir, env: {}, maxJobs: 6, maxOwnerJobs: 6, jobRetentionMs: 86_400_000, now: () => new Date(now) };
  const intake = new IngestService(options);
  const running = await intake.accept({ case_id: 'KEEP-RUNNING', documents: [note('Synthetic running upload')] }, { ownerId: 'owner-a' });
  await intake.updateJob(running.job.job_id, { status: 'RUNNING' });
  const held = await intake.accept({ case_id: 'KEEP-HELD', documents: [note('Synthetic held upload')] }, { ownerId: 'owner-a' });
  await intake.updateJob(held.job.job_id, { status: 'DONE', review_required: true, result_action: 'HOLD_FOR_REVIEW' });
  const finished = await intake.accept({ case_id: 'DONE-OPEN', documents: [note('Synthetic finished upload')] }, { ownerId: 'owner-b' });
  await intake.updateJob(finished.job.job_id, { status: 'DONE', review_required: false, result_action: 'OPEN' });
  for (let i = 0; i < 3; i += 1) await intake.accept({ case_id: `FILL-${i}`, documents: [note(`Synthetic queued upload ${i}`)] }, { ownerId: 'owner-c' });
  const stored = (result) => path.join(dir, result.documents[0].stored_as);

  // Within the retention period nothing makes room, whoever asks.
  now += 3_600_000;
  await assert.rejects(intake.accept({ case_id: 'ONE-MORE', documents: [note('Synthetic upload over the cap')] }, { ownerId: 'owner-d' }), { code: 'intake_jobs_full' });
  assert.equal(intake.jobs.size, 6);

  // Two days later, after a restart: the interrupted job starts its retention now; the finished, unheld one has expired.
  now += 2 * 86_400_000;
  const restarted = new IngestService(options);
  await restarted.init();
  assert.equal(restarted.getJob(running.job.job_id).status, 'INTERRUPTED');
  await restarted.accept({ case_id: 'ONE-MORE', documents: [note('Synthetic upload after retention')] }, { ownerId: 'owner-d' });
  assert.equal(restarted.getJob(finished.job.job_id), null, 'the finished job reached its retention period');
  await assert.rejects(fs.stat(stored(finished)), { code: 'ENOENT' });
  for (const kept of [running, held]) {
    assert.ok(restarted.getJob(kept.job.job_id), kept.job.case_id);
    assert.ok(await fs.stat(stored(kept)), `${kept.job.case_id} keeps its sealed bytes`);
    assert.ok((await restarted.loadDocuments(kept.job.document_ids))[0].text.startsWith('Synthetic'));
  }
  assert.equal(restarted.getJob(held.job.job_id).review_required, true);
  // The access record outlives the job it came with.
  assert.equal(restarted.canReadCase('DONE-OPEN', { ownerId: 'owner-b' }), true);
  assert.equal(restarted.canReadCase('DONE-OPEN', { ownerId: 'owner-a' }), false);
});

test('a working copy is private before anything is stored, and an operator who saves for it first claims it (A01)', async (t) => {
  const original = process.env.AGENTBL_ADMIN_TOKEN;
  const token = 'fictional-intake-operator-token-0001';
  process.env.AGENTBL_ADMIN_TOKEN = token;
  t.after(() => { if (original === undefined) delete process.env.AGENTBL_ADMIN_TOKEN; else process.env.AGENTBL_ADMIN_TOKEN = original; });
  const app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); });
  const service = await freshService();
  t.after(() => service.stop());
  const operator = browser(app.base), stranger = browser(app.base);
  const admin = { Authorization: `Bearer ${token}` };

  const copy = (await operator('GET', `/api/agent/workspace/copies/${SAMPLE}`)).data;
  assert.equal(copy.exists, false);
  assert.equal((await operator('GET', `/api/agent/cases/${copy.case_id}/preferences`)).status, 200, 'its own workspace may read the empty copy');
  assert.equal((await stranger('GET', `/api/agent/cases/${copy.case_id}/preferences`)).status, 404, 'nobody else may, even before it exists');

  // An anonymous reader listens to the copy's live activity before anything is saved for it.
  const listening = new AbortController();
  const stream = await fetch(`${app.base}/api/agent/activity/stream?case_id=${encodeURIComponent(copy.case_id)}`, { signal: listening.signal });
  const heard = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    try { for await (const chunk of stream.body) heard.push(decoder.decode(chunk)); } catch { /* aborted */ }
  })();

  // The operator's first save claims the copy for the operator's own workspace before storing anything.
  const saved = await operator('PUT', `/api/agent/cases/${copy.case_id}/preferences`, { min_acceptable_issue_price: 0.88 }, admin);
  assert.equal(saved.status, 200);
  const record = service.ingest.getAccess(copy.case_id);
  assert.equal(record.visibility, 'private');
  assert.equal(record.source_case_id, SAMPLE);
  assert.equal((await stranger('GET', `/api/agent/cases/${copy.case_id}/preferences`)).status, 404);
  const strangerActivity = (await stranger('GET', '/api/agent/activity?limit=200')).data.activities;
  assert.equal(strangerActivity.some((activity) => activity.caseId === copy.case_id), false);
  assert.ok((await operator('GET', '/api/agent/activity?limit=200')).data.activities
    .some((activity) => activity.caseId === copy.case_id && activity.action === 'EXPORTER_PREFERENCES_SET'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  listening.abort();
  await reading;
  assert.doesNotMatch(heard.join(''), /EXPORTER_PREFERENCES_SET/u, 'the live stream carries nothing of the private copy');

  // An upload against the copy afterwards keeps the copy's sample.
  const upload = await operator('POST', '/api/agent/ingest?wait=1', { case_id: copy.case_id, documents: [note('A fictional document for the operator copy.')] }, admin);
  assert.equal(upload.data.case_id, copy.case_id);
  assert.equal(upload.data.source_case_id, SAMPLE);
  // Nobody, operator token included, claims a copy that another workspace's ID names.
  const foreign = `WS-0123456789-${SAMPLE}`;
  const squat = await stranger('PUT', `/api/agent/cases/${foreign}/preferences`, { min_acceptable_issue_price: 0.5 }, admin);
  assert.equal(squat.status, 409);
  assert.equal(squat.data.code, 'case_owner_conflict');
  assert.equal(service.ingest.getAccess(foreign), null);
});

test('a refused preference leaves no job behind, and a job stranded before its event is queued again on retry (A05)', async (t) => {
  const service = await freshService();
  t.after(() => service.stop());
  const body = (price) => ({ case_id: 'RETRY-PREFERENCES', exporter_preferences: { min_acceptable_issue_price: price },
    documents: [note('Synthetic bill of lading draft for a fictional retry check.')] });
  await assert.rejects(service.submitDocuments(body(2), { ownerId: 'retry-owner' }), { code: 'invalid_preferences' });
  assert.equal(service.ingest.jobs.size, 0, 'nothing was stored for the refused request');
  assert.equal(service.ingest.getAccess('RETRY-PREFERENCES'), null);

  // The job is stored, then the preference write fails: the job never reached the bus.
  const put = service.preferences.put.bind(service.preferences);
  let failing = true;
  service.preferences.put = async (...args) => {
    if (failing) { failing = false; throw Object.assign(new Error('Synthetic preference write failure'), { code: 'EIO' }); }
    return put(...args);
  };
  await assert.rejects(service.submitDocuments(body(0.8), { ownerId: 'retry-owner' }), /Synthetic preference write failure/u);
  assert.equal(service.ingest.listJobs()[0].status, 'QUEUED');
  const retry = await service.submitDocuments(body(0.8), { ownerId: 'retry-owner' });
  assert.equal(retry.created, false);
  await service.waitFor(retry.idempotency_key, 30_000);
  const job = service.ingest.getJob(retry.job.job_id);
  assert.notEqual(job.status, 'QUEUED', 'the retry was processed');
  assert.ok(job.steps.length > 0);
  assert.equal(service.preferences.get('RETRY-PREFERENCES').min_acceptable_issue_price, 0.8);
  // Retrying once more is still one job and one decision.
  const again = await service.submitDocuments(body(0.8), { ownerId: 'retry-owner' });
  await service.waitFor(again.idempotency_key, 30_000);
  assert.deepEqual(service.ingest.getJob(job.job_id).decision_ids, job.decision_ids);
});

test('an upload against a public sample works on the uploader’s own copy; the sample stays public (F4)', async (t) => {
  const app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); });
  const service = await freshService();
  t.after(() => service.stop());
  const first = browser(app.base), second = browser(app.base);

  assert.equal((await second('GET', `/api/agent/cases/${SAMPLE}/preferences`)).status, 200);
  const upload = await first('POST', '/api/agent/ingest?wait=1', { case_id: SAMPLE, documents: [note('A fictional incomplete document for the shared sample.')] });
  assert.equal(upload.status, 202);
  assert.notEqual(upload.data.case_id, SAMPLE);
  assert.equal(upload.data.source_case_id, SAMPLE);
  const copy = upload.data.case_id;
  assert.match(copy, /^WS-[0-9A-F]{10}-CASE-EBL-CU-SIN-SHA$/u);

  // The sample is unchanged for everyone; the copy belongs to the uploader alone.
  assert.equal((await second('GET', `/api/agent/cases/${SAMPLE}/preferences`)).status, 200);
  assert.equal((await first('GET', `/api/agent/cases/${SAMPLE}/preferences`)).status, 200);
  assert.equal((await second('GET', `/api/agent/cases/${copy}/preferences`)).status, 404);
  assert.equal((await second('GET', `/api/agent/jobs/${upload.data.job.job_id}`)).status, 404);
  assert.equal((await second('GET', `/api/agent/jobs?case_id=${copy}`)).data.jobs.length, 0);

  // Each browser resolves its own working copy; preferences go there, never onto the sample.
  const mine = await first('GET', `/api/agent/workspace/copies/${SAMPLE}`);
  const theirs = await second('GET', `/api/agent/workspace/copies/${SAMPLE}`);
  assert.equal(mine.data.case_id, copy);
  assert.equal(mine.data.exists, true);
  assert.notEqual(theirs.data.case_id, copy);
  assert.equal(theirs.data.exists, false);
  const refused = await second('PUT', `/api/agent/cases/${SAMPLE}/preferences`, { min_acceptable_issue_price: 0.9 });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'public_case_read_only');
  assert.equal(refused.data.details.workspace_case_id, theirs.data.case_id);
  assert.equal((await second('PUT', `/api/agent/cases/${theirs.data.case_id}/preferences`, { min_acceptable_issue_price: 0.9 })).status, 200);
  assert.equal((await first('GET', `/api/agent/cases/${theirs.data.case_id}/preferences`)).status, 404);
  assert.deepEqual((await first('GET', `/api/agent/cases/${SAMPLE}/preferences`)).data.preferences, {});
  assert.equal(service.ingest.isPublicCase(SAMPLE), true);
});

test('raw uploads are sealed, a rejected batch leaves nothing, and the Demo reset deletes the bytes (F5)', async () => {
  const dir = await tempDir();
  let mode = 'demo';
  const intake = new IngestService({ dir, getMode: () => mode, env: {} });
  const marker = 'FICTIONAL-PRIVATE-CONTENT-REVIEW-ONLY';
  const raw = await intake.accept({ case_id: 'RAW-PRIVATE', documents: [note(marker)] }, { ownerId: 'owner-a' });
  const file = path.join(dir, raw.documents[0].stored_as);
  const sealed = await fs.readFile(file);
  assert.equal(sealed.includes(Buffer.from(marker)), false, 'the stored file is not plaintext');
  assert.equal((await intake.loadDocuments(raw.job.document_ids))[0].text, marker);

  // A later invalid document rejects the whole batch before anything is written.
  const before = (await fs.readdir(path.join(dir, 'uploads'))).length;
  await assert.rejects(intake.accept({ documents: [note('ORPHAN-FROM-REJECTED-UPLOAD'), { name: 'bad.exe', mime_type: 'application/x-msdownload', text: 'bad' }] }, { ownerId: 'owner-a' }),
    { code: 'unsupported_media_type' });
  assert.equal(intake.documents.size, 1);
  assert.equal(intake.jobs.size, 1);
  assert.equal((await fs.readdir(path.join(dir, 'uploads'))).length, before);
  // So does a conflict found after validation.
  await assert.rejects(intake.accept({ case_id: 'RAW-PRIVATE', documents: [note('a different owner tries the same case')] }, { ownerId: 'owner-b' }), { code: 'case_owner_conflict' });
  assert.equal(intake.documents.size, 1);

  // Shared content is stored once and survives while another job still needs it.
  mode = 'live';
  const live = await intake.accept({ case_id: 'RAW-LIVE', documents: [note(marker), note('live-only addendum')] }, { ownerId: 'owner-b' });
  assert.equal(live.documents[0].stored_as, raw.documents[0].stored_as);
  mode = 'demo';
  await intake.clear();
  assert.equal(intake.jobs.size, 1, 'a Demo reset leaves Live jobs');
  assert.ok(await fs.stat(file), 'the Live job still needs the shared bytes');
  assert.equal(intake.isPrivateCase('RAW-PRIVATE'), true, 'access records outlive the reset');

  // After a restart the access records, the sealed bytes and the key are read back.
  const restarted = new IngestService({ dir, env: {} });
  assert.equal((await restarted.loadDocuments(live.job.document_ids))[1].text, 'live-only addendum');
  assert.equal(restarted.isPrivateCase('RAW-PRIVATE'), true);
  assert.equal(restarted.caseOwner('RAW-LIVE'), 'owner-b');
  assert.equal(restarted.canReadCase('RAW-PRIVATE', { ownerId: 'owner-b' }), false);
  for (const [id, job] of restarted.jobs) restarted.jobs.set(id, { ...job, mode: 'demo' });
  await restarted.clear();
  assert.deepEqual(await fs.readdir(path.join(dir, 'uploads')), [], 'no job needs the bytes any more');
  assert.equal(restarted.usage().stored_bytes, 0);
});

test('quotas and the batch limit refuse before storing, and old plaintext orphans are swept on start (F5)', async () => {
  const dir = await tempDir();
  const intake = new IngestService({ dir, env: {}, maxBytes: 64, maxBatchBytes: 100, maxOwnerBytes: 120 });
  await assert.rejects(intake.accept({ documents: [note('a'.repeat(60)), note('b'.repeat(60))] }, { ownerId: 'o' }), { code: 'upload_batch_too_large' });
  await intake.accept({ case_id: 'QUOTA-1', documents: [note('c'.repeat(60)), note('d'.repeat(30))] }, { ownerId: 'o' });
  await assert.rejects(intake.accept({ case_id: 'QUOTA-2', documents: [note('e'.repeat(40))] }, { ownerId: 'o' }), { code: 'upload_quota_exceeded' });
  assert.equal(intake.documents.size, 2);

  const legacy = path.join(dir, 'uploads', `${'a'.repeat(64)}.txt`);
  await fs.writeFile(legacy, 'plaintext left by an older version');
  await new IngestService({ dir, env: {} }).init();
  await assert.rejects(fs.stat(legacy), { code: 'ENOENT' });
});

test('runtimes written before access records keep their uploads private', async () => {
  const dir = await tempDir();
  const jobs = { job_x: { job_id: 'job_x', owner_id: 'owner-a', visibility: 'private', case_id: 'LEGACY-PRIVATE', status: 'DONE', document_ids: [], steps: [], decision_ids: [], created_at: '2026-10-01T00:00:00.000Z' } };
  await fs.writeFile(path.join(dir, 'ingest-jobs.json'), JSON.stringify(jobs));
  const intake = await new IngestService({ dir, env: {} }).init();
  assert.equal(intake.isPrivateCase('LEGACY-PRIVATE'), true);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'ingest-case-access.json'), 'utf8')).cases['LEGACY-PRIVATE'].owner_id, 'owner-a');
  // A record produced from an upload whose owner cannot be established stays closed.
  assert.equal(intake.canReadUploadRecord('UNKNOWN-CASE', 'ingest:job_0123456789abcdef0123'), false);
  await fs.writeFile(path.join(dir, 'ingest-case-access.json'), '{ not json');
  await assert.rejects(new IngestService({ dir, env: {} }).init());
  // Once this version wrote jobs, a missing access file is a loss to restore, not a fresh start.
  await fs.rm(path.join(dir, 'ingest-case-access.json'));
  await fs.writeFile(path.join(dir, 'ingest-jobs.json'), JSON.stringify({ job_x: { ...jobs.job_x, mode: 'demo' } }));
  await assert.rejects(new IngestService({ dir, env: {} }).init(), /access records are missing/u);
});

test('while operations are degraded every intake path is paused and reads stay open (F7)', async (t) => {
  const operations = { readiness: () => ({ ok: false, status: 'degraded' }), recordRequest() {} };
  const app = await listen(createServer({ operations }));
  // A server without a monitor restores the default readiness for whatever runs next in this process.
  t.after(async () => { closeActivityStreams(); await app.close(); createServer(); });
  const service = await freshService({ intakeGate: () => operations.readiness() });
  t.after(() => service.stop());
  const api = browser(app.base);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64');
  const matrix = [
    ['POST', '/api/agent/ingest', { case_id: 'UNREADY-DIRECT', documents: [note('Synthetic fictional upload.')] }],
    ['POST', '/api/ebl/upload', { case_id: 'UNREADY-LEGACY', file: { name: 'test.png', type: 'image/png', size: 9, content: png } }],
    ['POST', '/api/agent/jobs/job_0123456789abcdef0123/review', { note: 'retry', documents: [note('x')] }]
  ];
  for (const [method, route, body] of matrix) {
    const result = await api(method, route, body);
    assert.equal(result.status, 503, route);
    assert.equal(result.data.code, 'operations_not_ready', route);
  }
  assert.equal(service.ingest.jobs.size, 0);
  // The service refuses on its own, whichever route reaches it.
  await assert.rejects(service.submitDocuments({ case_id: 'UNREADY-SERVICE', documents: [note('x')] }), { code: 'operations_not_ready', status: 503 });
  assert.equal((await api('GET', '/api/agent/jobs')).status, 200);
  assert.equal((await api('GET', `/api/agent/cases/${SAMPLE}/preferences`)).status, 200);
  for (const route of ['/api/agent/ingest', '/api/ebl/upload', '/api/agent/jobs/job_1/review', '/api/controlled/subscription-intents', '/api/positions/subscription-intents']) assert.equal(isNewIntake('POST', route), true, route);
  for (const route of ['/api/controlled/claim-intents', '/api/controlled/refund-intents', '/api/controlled/intents/0b0e6a1c-1111-4c1d-9d1e-123456789abc/transaction']) assert.equal(isNewIntake('POST', route), false, route);
});
