// F01 (comprehensive review 2026-10-29, v4): degraded operational readiness pauses every way new risk enters, at the
// draft and again at the broadcast checkpoint, while exits, reconciliation and reads stay available. The shared policy is
// src/ops/intakePolicy.js; the same flow against a local EVM is in tests/w3CrossLayer.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { RightsService } from '../src/rights/service.js';
import { createRightsRoutes } from '../src/app/rightsRoutes.js';
import { sendError } from '../src/app/http.js';
import { CapitalLedgerService } from '../src/ledger/service.js';
import { NEW_RISK_CAPITAL_OPERATIONS, NEW_RISK_RIGHTS_OPERATIONS, isNewIntake } from '../src/ops/intakePolicy.js';
import { listen, requestJson } from './helpers/http.js';

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const paused = { code: 'operations_not_ready', status: 503 };

async function fixture(t, { readiness = { ok: true } } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-readiness-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const state = { ready: true, duringRead: null };
  const chain = {
    prepare: async (principal, input) => {
      state.duringRead?.(); // lets a test change readiness while the checkpoint's chain reads run unlocked
      return { chain_id: '31337', pool: `0x${'22'.repeat(20)}`, controller: `0x${'33'.repeat(20)}`, from: principal.wallet, to: `0x${'44'.repeat(20)}`,
        calldata: `0x${Buffer.from(input.operation + (input.evidence_hash ?? '')).toString('hex')}`, nonce: 0, prepared_block: 1, operation: input.operation };
    },
    recoverTransaction: async () => null,
    releaseObservation: async () => ({ state: 'unused' })
  };
  const env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') };
  const service = new RightsService({ directory, env, chain, getMode: () => 'live', getGeneration: () => 1, intakeGate: () => (state.ready ? readiness : { ok: false }) });
  const signer = Wallet.createRandom();
  const subject = await service.createSubject({ organization: 'readiness-review', roles: ['operator', 'compliance', 'holder'], wallet: signer.address });
  const challenge = await service.createChallenge(subject.subject_id);
  const token = (await service.openSession({ challenge_id: challenge.challenge_id, signature: await signer.signTypedData(challenge.domain, challenge.types, challenge.message) })).token;
  return { service, state, token, directory, env };
}

test('F01 the shared policy lists new risk only: drafts, materials and subscriptions, never exits or reconciliation', () => {
  assert.deepEqual([...NEW_RISK_RIGHTS_OPERATIONS].sort(), ['acknowledge_terms', 'create_offering', 'disburse', 'pledge', 'register_title']);
  assert.deepEqual(NEW_RISK_CAPITAL_OPERATIONS, ['SUBSCRIBE']);
  const id = '0b0e6a1c-1111-4c1d-9d1e-123456789abc';
  for (const route of ['/api/rights/materials', '/api/rights/evidence', `/api/rights/materials/${id}/financing-disclosure`, `/api/rights/materials/${id}/terms`,
    `/api/rights/materials/${id}/publish`, `/api/rights/materials/${id}/signing-request`]) assert.equal(isNewIntake('POST', route), true, route);
  for (const route of [`/api/rights/materials/${id}/financing-disclosure-preview`, `/api/rights/materials/${id}/review`, `/api/rights/transaction-plans/${id}/broadcast`,
    `/api/rights/transaction-plans/${id}/transaction`, `/api/rights/transaction-plans/${id}/release`, `/api/rights/evidence/${id}/review`, `/api/controlled/intents/${id}/broadcast`,
    '/api/controlled/claim-intents', '/api/controlled/refund-intents']) assert.equal(isNewIntake('POST', route), false, route);
  assert.equal(isNewIntake('GET', '/api/rights/materials'), false);
});

test('F01 a draft saved while ready is refused at the broadcast checkpoint once readiness drops; exits and recovery continue', async (t) => {
  const h = await fixture(t);
  const draw = { operation: 'disburse', pool_id: '1', amount_atomic: '8000000', evidence_hash: hash(1) };
  const saved = await h.service.prepareTransaction(h.token, draw);
  h.state.ready = false;
  await assert.rejects(h.service.prepareTransaction(h.token, { ...draw, evidence_hash: hash(2) }), paused);
  await assert.rejects(h.service.checkpointPlan(h.token, saved.plan_id), paused);
  assert.equal((await h.service.getPlan(h.token, saved.plan_id)).status, 'draft', 'the refused draft never reached the wallet');
  // A role action that adds no risk is prepared and checkpointed as usual while degraded.
  const screening = await h.service.prepareTransaction(h.token, { operation: 'refresh_screening', valid_until: '1900000000', evidence_hash: hash(3) });
  assert.equal(screening.status, 'draft');
  // The paused draft can be dismissed, which unblocks the wallet's next send.
  assert.equal((await h.service.releasePlan(h.token, saved.plan_id)).status, 'abandoned');
  assert.equal((await h.service.checkpointPlan(h.token, screening.plan_id)).status, 'broadcast_prepared');
  // Back to ready: a new draw is prepared and checkpointed.
  h.state.ready = true;
  await h.service.releasePlan(h.token, screening.plan_id);
  const again = await h.service.prepareTransaction(h.token, { ...draw, evidence_hash: hash(4) });
  assert.equal((await h.service.checkpointPlan(h.token, again.plan_id)).status, 'broadcast_prepared');
});

test('F01 readiness that drops while the checkpoint reads the chain still stops the send at its commit', async (t) => {
  const h = await fixture(t);
  const saved = await h.service.prepareTransaction(h.token, { operation: 'pledge', terms_hash: hash(5), valid_until: '1900000000', payload: { ebl_id: '1' } });
  h.state.duringRead = () => { h.state.ready = false; };
  await assert.rejects(h.service.checkpointPlan(h.token, saved.plan_id), paused);
  h.state.duringRead = null;
  assert.equal((await h.service.getPlan(h.token, saved.plan_id)).status, 'draft');
});

test('F01 rights routes pause new material, evidence and terms writes and answer reads, also without the global guard', async (t) => {
  const h = await fixture(t);
  let ready = true;
  const routes = createRightsRoutes({ env: h.env, service: h.service });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url, 'http://local')).catch((error) => sendError(res, error, { logger: { warn() {}, error() {} } })));
  server.operations = { readiness: () => ({ ok: ready }) };
  const app = await listen(server); t.after(() => app.close());
  const headers = { 'x-rights-session': h.token };
  const material = { material: { synthetic: true }, public_summary: { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 30, terms_hash: hash(6), risk_flags: ['simulated_title'] } };
  const created = await requestJson(app.base, 'POST', '/api/rights/materials', material, headers);
  assert.equal(created.status, 200);
  const draft = await requestJson(app.base, 'POST', '/api/rights/transaction-plans', { operation: 'disburse', pool_id: '1', amount_atomic: '1', evidence_hash: hash(7) }, headers);
  assert.equal(draft.status, 200);
  ready = false;
  for (const [route, body] of [['materials', material], ['evidence', { material_id: created.data.material_id, kind: 'note', source: 'synthetic', data: { note: 'x' } }],
    [`materials/${created.data.material_id}/terms`, { terms_hash: hash(8) }], [`materials/${created.data.material_id}/publish`, {}],
    [`transaction-plans/${draft.data.plan_id}/broadcast`, {}], ['transaction-plans', { operation: 'acknowledge_terms', pool_id: '1' }]]) {
    const response = await requestJson(app.base, 'POST', `/api/rights/${route}`, body, headers);
    assert.deepEqual([response.status, response.data.code], [503, 'operations_not_ready'], route);
  }
  assert.equal((await requestJson(app.base, 'GET', '/api/rights/materials', undefined, headers)).status, 200);
  assert.equal((await requestJson(app.base, 'GET', `/api/rights/transaction-plans/${draft.data.plan_id}`, undefined, headers)).status, 200);
  assert.equal((await requestJson(app.base, 'POST', `/api/rights/transaction-plans/${draft.data.plan_id}/release`, {}, headers)).data.status, 'abandoned');
  // Mounted on a server without monitoring, the service's own readiness gate applies.
  delete server.operations; h.state.ready = false;
  assert.equal((await requestJson(app.base, 'POST', '/api/rights/materials', material, headers)).status, 503);
  h.state.ready = true;
  assert.equal((await requestJson(app.base, 'POST', '/api/rights/materials', material, headers)).status, 200);
});

test('F01 a saved subscription is refused at its broadcast checkpoint while degraded; claims and refunds pass the gate', async () => {
  const intents = new Map([['sub', { intent_id: 'sub', operation: 'SUBSCRIBE' }], ['claim', { intent_id: 'claim', operation: 'CLAIM' }], ['refund', { intent_id: 'refund', operation: 'REFUND' }]]);
  let contextReads = 0;
  const capital = new CapitalLedgerService({ ledger: { getIntent: async (key) => intents.get(key) }, chainConfig: null, getMode: () => 'live',
    getContext: async () => { contextReads++; return null; }, intakeGate: () => ({ ok: false }) });
  await assert.rejects(capital.checkpointBroadcast('sub'), paused);
  await assert.rejects(capital.prepareSubscription({ wallet: `0x${'11'.repeat(20)}`, chain_pool_id: 1, shares: '1' }), paused);
  assert.equal(contextReads, 0, 'refused before any chain read');
  // Exits go on to their own checks (here: no configured protocol), never operations_not_ready.
  for (const key of ['claim', 'refund']) await assert.rejects(capital.checkpointBroadcast(key), (error) => error.code === 'capital_protocol_unavailable');
  await assert.rejects(capital.checkpointBroadcast('sub', { readiness: () => ({ ok: true }) }), (error) => error.code === 'capital_protocol_unavailable');
});
