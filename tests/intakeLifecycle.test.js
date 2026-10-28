// Who may read an uploaded case, and what happens to the raw bytes, across the whole intake lifecycle:
// job retention, failed batches, restarts, the Demo reset and degraded operations (application review F1, F4, F5, F7).
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

test('a held private case stays private after job retention evicts its job (F1)', async (t) => {
  const app = await listen(createServer());
  t.after(async () => { closeActivityStreams(); await app.close(); });
  const service = await freshService();
  t.after(() => service.stop());
  const owner = browser(app.base), stranger = browser(app.base);

  const uploaded = await owner('POST', '/api/agent/ingest?wait=1', { case_id: 'PRIVATE-HELD-REVIEW', exporter_preferences: { min_acceptable_issue_price: 0.73 },
    documents: [note('Synthetic incomplete invoice for a fictional client, reference ABC-ONLY-REVIEW.')] });
  assert.equal(uploaded.status, 202);
  assert.equal(uploaded.data.job.result_action, 'HOLD_FOR_REVIEW');
  const decisionId = uploaded.data.job.decision_ids[0];
  assert.ok(decisionId);
  assert.equal((await stranger('GET', `/api/agent/decisions/${decisionId}`)).status, 404);

  for (let i = 0; i < 500; i += 1) await service.ingest.accept({ case_id: `OTHER-${i}`, documents: [note(`Synthetic other upload ${i}`)] }, { ownerId: 'another-workspace' });
  assert.equal(service.ingest.getJob(uploaded.data.job.job_id), null, 'the original job was evicted');

  assert.equal((await stranger('GET', `/api/agent/decisions/${decisionId}`)).status, 404);
  assert.equal((await stranger('GET', '/api/agent/decisions?case_id=PRIVATE-HELD-REVIEW')).data.count, 0);
  assert.equal((await stranger('GET', '/api/agent/cases/PRIVATE-HELD-REVIEW/preferences')).status, 404);
  const own = await owner('GET', '/api/agent/cases/PRIVATE-HELD-REVIEW/preferences');
  assert.equal(own.status, 200);
  assert.equal(own.data.preferences.min_acceptable_issue_price, 0.73);
  assert.equal((await owner('GET', `/api/agent/decisions/${decisionId}`)).status, 200);
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
