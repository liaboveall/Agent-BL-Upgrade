// F04 (full-project-assessment-2026-10-29): a decision record and its trace are pruned under separate retention, so
// the trace of a private case must stay private after its decision record is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { IngestService } from '../src/agent/ingest/ingestService.js';
import { PreferenceStore } from '../src/agent/runtime/preferences.js';
import { DecisionLogger } from '../src/agent/decisionLogger.js';
import { Tracer } from '../src/agent/runtime/trace.js';
import { ANCHOR_SCHEMA, PRIVATE_ANCHOR_SCHEMA } from '../src/agent/runtime/anchorProof.js';
import { createAgentRoutes } from '../src/app/agentRoutes.js';
import { sendError } from '../src/app/http.js';
import { listen, requestJson } from './helpers/http.js';

const ADMIN = 'synthetic-trace-retention-admin-token-0123456789';

async function fixture(t, { anchors = new Map() } = {}) {
  const previous = process.env.AGENTBL_ADMIN_TOKEN;
  process.env.AGENTBL_ADMIN_TOKEN = ADMIN;
  t.after(() => { if (previous === undefined) delete process.env.AGENTBL_ADMIN_TOKEN; else process.env.AGENTBL_ADMIN_TOKEN = previous; });
  const ingest = new IngestService({ dir: null });
  await ingest.claimCase('PRIVATE-TRACE', { ownerId: 'owner-a' });
  const logger = new DecisionLogger({ filePath: null }), tracer = new Tracer({ bridge: false });
  const service = { ingest, preferences: new PreferenceStore(), getDecision: (id) => logger.get(id), getTrace: (id) => tracer.getByDecision(id),
    getDecisionAnchor: async (id) => anchors.get(id) ?? { available: false, state: 'DISABLED', decision_id: id } };
  const route = createAgentRoutes({ getService: () => service, runtimeMode: () => ({ mode: 'demo' }) });
  const app = await listen(http.createServer((req, res) => route(req, res, new URL(req.url, 'http://localhost')).catch((error) => sendError(res, error, { logger: { warn() {}, error() {} } }))));
  t.after(() => app.close());
  const get = (path, headers = {}) => requestJson(app.base, 'GET', path, undefined, headers);
  // Supported retention: 99 newer finished runs and one still in flight push the private decision out of the log.
  const prune = async (finished = 99) => {
    for (let n = 0; n <= finished; n++) {
      const record = await logger.record({ case_id: `PUBLIC-${n}`, action: 'OPEN', reasoning_summary: 'Synthetic decision', status: n < finished ? 'COMPLETED' : 'DECIDED' });
      if (n < finished) await tracer.startRun({ decision_id: record.decision_id, name: 'agent.event', attributes: {} }).end();
    }
    await logger.prune({ maxRecords: 100, olderThanMs: 90 * 86400000 });
    const protectedDecisions = new Set((await logger.list()).filter((r) => !['COMPLETED', 'FAILED', 'SKIPPED', 'REJECTED'].includes(r.status)).map((r) => r.decision_id));
    await tracer.prune({ now: Date.now(), retentionDays: 90, maxRecords: 100, protectedDecisions });
  };
  return { ingest, logger, tracer, get, prune, admin: { Authorization: `Bearer ${ADMIN}` } };
}

test('F04 a private trace stays private after its decision record is pruned', async (t) => {
  const h = await fixture(t);
  const decision = await h.logger.record({ case_id: 'PRIVATE-TRACE', action: 'HOLD_FOR_REVIEW', event_type: 'DOCUMENTS_INGESTED', reasoning_summary: 'Synthetic', status: 'COMPLETED' });
  const run = h.tracer.startRun({ decision_id: decision.decision_id, name: 'agent.event', attributes: { case_id: 'PRIVATE-TRACE', event_type: 'DOCUMENTS_INGESTED', source: 'ingest', mode: 'demo' } });
  await run.span('policy', async () => {}); await run.end();
  const path = `/api/agent/decisions/${decision.decision_id}/trace`;
  assert.equal((await h.get(path)).status, 404);
  await h.prune();
  assert.equal(await h.logger.get(decision.decision_id), null, 'the decision record is gone');
  assert.ok(await h.tracer.getByDecision(decision.decision_id), 'its trace is still kept');
  // Before the fix this answered 200 with the private case ID, event type, source, mode and spans.
  const anonymous = await h.get(path);
  assert.equal(anonymous.status, 404);
  assert.doesNotMatch(JSON.stringify(anonymous.data), /PRIVATE-TRACE/u);
  const admin = await h.get(path, h.admin);
  assert.equal(admin.status, 200);
  assert.equal(admin.data.trace.attributes.case_id, 'PRIVATE-TRACE');
});

test('F04 a pruned trace that names no case is for an administrator; one of a public case stays public', async (t) => {
  const h = await fixture(t);
  const unnamed = await h.logger.record({ case_id: 'PRIVATE-TRACE', action: 'OPEN', reasoning_summary: 'Synthetic', status: 'COMPLETED' });
  await h.tracer.startRun({ decision_id: unnamed.decision_id, name: 'agent.execute' }).end();
  const sample = await h.logger.record({ case_id: 'CASE-EBL-CU-SIN-SHA', action: 'OPEN', reasoning_summary: 'Synthetic', status: 'COMPLETED' });
  await h.tracer.startRun({ decision_id: sample.decision_id, name: 'agent.event', attributes: { case_id: 'CASE-EBL-CU-SIN-SHA' } }).end();
  await h.prune(98);
  assert.equal(await h.logger.get(unnamed.decision_id), null);
  assert.equal((await h.get(`/api/agent/decisions/${unnamed.decision_id}/trace`)).status, 404);
  assert.equal((await h.get(`/api/agent/decisions/${unnamed.decision_id}/trace`, h.admin)).status, 200);
  assert.equal((await h.get(`/api/agent/decisions/${sample.decision_id}/trace`)).status, 200);
});

test('F04 an archived anchor leaf naming a private case in clear is authorized against that case; a hashed one is proof material', async (t) => {
  const anchors = new Map([
    ['clear', { available: true, archived: true, decision_id: 'clear', payload: { schema: ANCHOR_SCHEMA, decision_id: 'clear', case_id: 'PRIVATE-TRACE' } }],
    ['hashed', { available: true, archived: true, decision_id: 'hashed', payload: { schema: PRIVATE_ANCHOR_SCHEMA, decision_id: 'hashed', case_id: `0x${'ab'.repeat(32)}` } }]
  ]);
  const h = await fixture(t, { anchors });
  assert.equal((await h.get('/api/agent/decisions/clear/anchor')).status, 404);
  assert.equal((await h.get('/api/agent/decisions/clear/anchor', h.admin)).status, 200);
  assert.equal((await h.get('/api/agent/decisions/hashed/anchor')).status, 200);
});
