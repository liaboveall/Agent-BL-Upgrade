import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Wallet, id } from 'ethers';
import { RightsService } from '../src/rights/service.js';
import { createRightsRoutes } from '../src/app/rightsRoutes.js';
import { sendError } from '../src/app/http.js';
import { listen, requestJson } from './helpers/http.js';
import { assetIdentity, privateCommitment, publicSummary } from '../src/rights/typedData.js';
import { unseal } from '../src/rights/vault.js';

const summary = { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 30, terms_hash: id('approved terms'), risk_flags: ['simulated_title', 'test_asset', 'capital_at_risk'] };
const errorCode = (code) => (error) => error?.code === code;
async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'w3-rights-')), env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex'), AGENTBL_ADMIN_TOKEN: 'synthetic-admin-for-w3-tests-only' };
  let now = Date.now();
  const service = new RightsService({ directory, env, clock: () => now });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const login = async (roles, organization = 'org-a', wallet = Wallet.createRandom()) => {
    const subject = await service.createSubject({ organization, wallet: wallet.address, roles });
    const challenge = await service.createChallenge(subject.subject_id), signature = await wallet.signTypedData(challenge.domain, challenge.types, challenge.message);
    const session = await service.openSession({ challenge_id: challenge.challenge_id, signature });
    return { subject, challenge, signature, session, token: session.token, wallet };
  };
  return { directory, env, service, login, advance: (ms) => { now += ms; } };
}
test('W3 uses stable issuer/original identity and salted commitments; public projection rejects arbitrary data', () => {
  assert.equal(assetIdentity('carrier a', '  Bl  123 '), assetIdentity('CARRIER A', 'BL 123'));
  assert.notEqual(assetIdentity('carrier a', 'BL 123'), assetIdentity('carrier b', 'BL 123'));
  const material = { title: 'private commercial title', quantity: '100' };
  assert.notEqual(privateCommitment(material).hash, privateCommitment(material).hash);
  const p = privateCommitment(material); assert.equal(privateCommitment(material, p.salt).hash, p.hash);
  assert.throws(() => publicSummary({ ...summary, exporter: 'private identity' }));
  assert.throws(() => publicSummary({ ...summary, risk_flags: ['Private Company Ltd'] }));
  assert.deepEqual(publicSummary(summary), summary);
});
test('W3 wallet-bound sessions reject wrong signer/replay/expiry and survive restart with immediate revocation', async (t) => {
  const h = await harness(t), owner = await h.login(['issuer']);
  await assert.rejects(h.service.openSession({ challenge_id: owner.challenge.challenge_id, signature: owner.signature }), errorCode('rights_challenge_invalid'));
  const next = await h.service.createChallenge(owner.subject.subject_id);
  await assert.rejects(h.service.openSession({ challenge_id: next.challenge_id, signature: await Wallet.createRandom().signTypedData(next.domain, next.types, next.message) }), errorCode('rights_signature_invalid'));
  const restarted = new RightsService({ directory: h.directory, env: h.env });
  assert.equal((await restarted.principal(owner.token)).subject_id, owner.subject.subject_id);
  await restarted.revokeSession(owner.session.session_id);
  await assert.rejects(h.service.principal(owner.token), errorCode('rights_session_required'));
  h.advance(301000);
  await assert.rejects(h.service.openSession({ challenge_id: next.challenge_id, signature: owner.signature }), errorCode('rights_challenge_invalid'));
});
test('W3 vault fails closed without separate key, wrong key or tampered ciphertext; no material/token/wallet plaintext persists', async (t) => {
  const h = await harness(t), owner = await h.login(['issuer']);
  const material = { document: 'unique-private-document-W3', wallet: owner.wallet.address };
  await h.service.createMaterial(owner.token, { material, public_summary: summary });
  const file = path.join(h.directory, 'vault.json'), bytes = await fs.readFile(file, 'utf8');
  for (const secret of [material.document, owner.wallet.address.toLowerCase(), owner.token, h.env.AGENTBL_RIGHTS_KEY]) assert.equal(bytes.includes(secret), false);
  const missing = new RightsService({ directory: h.directory, env: {} });
  await assert.rejects(missing.principal(owner.token), errorCode('rights_not_configured'));
  const wrong = new RightsService({ directory: h.directory, env: { AGENTBL_RIGHTS_KEY: '42'.repeat(32) } });
  await assert.rejects(wrong.principal(owner.token), errorCode('rights_vault_unavailable'));
  const envelope = JSON.parse(bytes); envelope.tag = '00'.repeat(16); await fs.writeFile(file, JSON.stringify(envelope));
  await assert.rejects(h.service.principal(owner.token), errorCode('rights_vault_unavailable'));
  assert.throws(() => unseal(Buffer.from(h.env.AGENTBL_RIGHTS_KEY, 'hex'), JSON.parse(bytes), 'different-domain'), errorCode('rights_vault_unavailable'));
});
test('W3 enforces same-object authorization over HTTP/download/SSE/MCP/A2A and keeps public projection independent', async (t) => {
  const h = await harness(t), owner = await h.login(['issuer']), reviewerA = await h.login(['reviewer']), reviewerB = await h.login(['reviewer']);
  const other = await h.login(['issuer', 'reviewer'], 'org-b'), investor = await h.login(['investor']);
  const record = await h.service.createMaterial(owner.token, { material: { exporter: 'Secret Exporter', text: 'private bill' }, public_summary: summary });
  for (const transport of ['http', 'download', 'sse', 'mcp', 'a2a']) {
    await assert.rejects(h.service.invoke(other.token, 'read_material', record.material_id, transport), errorCode('rights_material_not_found'));
    await assert.rejects(h.service.invoke(investor.token, 'read_material', record.material_id, transport), errorCode('rights_material_not_found'));
    assert.equal((await h.service.invoke(owner.token, 'read_material', record.material_id, transport)).material.exporter, 'Secret Exporter');
  }
  await assert.rejects(h.service.publishMaterial(owner.token, record.material_id), errorCode('rights_two_reviews_required'));
  await assert.rejects(h.service.reviewMaterial(owner.token, record.material_id, { document_hash: record.document_hash, terms_hash: summary.terms_hash }), errorCode('rights_independent_review_required'));
  await assert.rejects(h.service.reviewMaterial(reviewerA.token, record.material_id, { document_hash: record.document_hash, terms_hash: id('changed') }), errorCode('rights_review_changed'));
  const review = { document_hash: record.document_hash, terms_hash: summary.terms_hash };
  await h.service.reviewMaterial(reviewerA.token, record.material_id, review);
  await assert.rejects(h.service.reviewMaterial(reviewerA.token, record.material_id, review), errorCode('rights_already_reviewed'));
  await assert.rejects(h.service.publishMaterial(owner.token, record.material_id), errorCode('rights_two_reviews_required'));
  await h.service.reviewMaterial(reviewerB.token, record.material_id, review);
  const publication = await h.service.publishMaterial(owner.token, record.material_id);
  assert.deepEqual(publication.summary, summary); assert.equal(JSON.stringify(publication).includes('Secret Exporter'), false);
  assert.deepEqual(await h.service.publication(record.material_id), publication);
  await h.service.bindTerms(owner.token, record.material_id, id('new approved terms'));
  await assert.rejects(h.service.publishMaterial(owner.token, record.material_id), errorCode('rights_two_reviews_required'));
  assert.deepEqual(await h.service.publication(record.material_id), publication);
  assert.equal((await h.service.readMaterial(owner.token, record.material_id)).revision, 2);
  for (const reviewer of [reviewerA, reviewerB]) await h.service.reviewMaterial(reviewer.token, record.material_id,
    { document_hash: record.document_hash, terms_hash: id('new approved terms') });
  await h.service.publishMaterial(owner.token, record.material_id);
  await h.service.revokeSubject(reviewerB.subject.subject_id);
  await assert.rejects(h.service.publishMaterial(owner.token, record.material_id), errorCode('rights_two_reviews_required'));
});
test('W3 concurrent process-scoped writers do not overwrite subjects or permit two independent sessions from one challenge', async (t) => {
  const h = await harness(t), other = new RightsService({ directory: h.directory, env: h.env });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? h.service : other).createSubject({ organization: 'org-a', wallet: Wallet.createRandom().address, roles: ['issuer'] })));
  for (const subject of results) assert.ok(await h.service.createChallenge(subject.subject_id));
  const w = Wallet.createRandom(), subject = await h.service.createSubject({ organization: 'org-a', wallet: w.address, roles: ['issuer'] });
  const challenge = await h.service.createChallenge(subject.subject_id), signature = await w.signTypedData(challenge.domain, challenge.types, challenge.message);
  const logins = await Promise.allSettled([h.service.openSession({ challenge_id: challenge.challenge_id, signature }), other.openSession({ challenge_id: challenge.challenge_id, signature })]);
  assert.equal(logins.filter((result) => result.status === 'fulfilled').length, 1);
});
test('W3 HTTP admin bootstrap, RPC adapters, private download and session-revoked SSE share the same checks', async (t) => {
  const h = await harness(t), owner = await h.login(['issuer']), other = await h.login(['reviewer'], 'org-b');
  const route = createRightsRoutes({ env: h.env, service: h.service, streamInterval: 20 });
  const app = await listen(http.createServer((req, res) => route(req, res, new URL(req.url, 'http://local')).catch((error) => sendError(res, error, { logger: { warn() {}, error() {} } }))));
  t.after(() => app.close());
  const request = (method, url, body, token = owner.token) => requestJson(app.base, method, `/api/rights/${url}`, body, { 'x-rights-session': token });
  assert.equal((await request('POST', 'subjects', { organization: 'org-a', wallet: Wallet.createRandom().address, roles: ['issuer'] })).status, 401);
  assert.equal((await request('GET', 'status')).data.business_enabled, false);
  const record = await request('POST', 'materials', { material: { text: 'HTTP-private-W3' }, public_summary: summary });
  assert.equal(record.status, 200); const recordId = record.data.material_id;
  assert.equal((await request('GET', `materials/${recordId}/download`)).data.material.text, 'HTTP-private-W3');
  assert.equal((await request('GET', `materials/${recordId}/download`, undefined, other.token)).status, 404);
  for (const token of [owner.token, other.token]) {
    const mcp = await request('POST', 'mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_material', arguments: { material_id: recordId } } }, token);
    const a2a = await request('POST', 'a2a', { operation: 'read_material', material_id: recordId }, token);
    assert.equal(mcp.status, token === owner.token ? 200 : 404); assert.equal(a2a.status, mcp.status);
  }
  const stream = await fetch(`${app.base}/api/rights/materials/${recordId}/events`, { headers: { 'x-rights-session': owner.token } });
  assert.equal(stream.status, 200); const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: revision/u);
  await h.service.revokeSession(owner.session.session_id);
  let finished = false;
  for (let index = 0; index < 10 && !finished; index++) finished = (await reader.read()).done;
  assert.equal(finished, true);
  assert.equal((await request('GET', `materials/${recordId}`)).status, 401);
  assert.equal((await request('POST', 'transaction-plans', { operation: 'acknowledge_terms' }, other.token)).status, 409);
});
test('W3 expired sessions cannot read; retention archives material read-only, then removes it', async (t) => {
  const h = await harness(t), owner = await h.login(['issuer']);
  const record = await h.service.createMaterial(owner.token, { material: { private: true }, public_summary: summary });
  h.advance(3600001);
  await assert.rejects(h.service.readMaterial(owner.token, record.material_id), errorCode('rights_session_required'));
  const fresh = async () => {
    const challenge = await h.service.createChallenge(owner.subject.subject_id);
    return (await h.service.openSession({ challenge_id: challenge.challenge_id, signature: await owner.wallet.signTypedData(challenge.domain, challenge.types, challenge.message) })).token;
  };
  // Retention covers the declared 30-day tenor plus 90 days, then the record is archived read-only for 30 days.
  h.advance(119 * 86400000);
  assert.equal((await h.service.readMaterial(await fresh(), record.material_id)).archived, false);
  h.advance(2 * 86400000);
  let token = await fresh();
  assert.equal((await h.service.readMaterial(token, record.material_id)).archived, true);
  assert.equal((await h.service.listMaterials(token)).materials[0].archived, true);
  await assert.rejects(h.service.createEvidence(token, { material_id: record.material_id, kind: 'raw_material', source: null }), errorCode('rights_material_archived'));
  await assert.rejects(h.service.publishMaterial(token, record.material_id), errorCode('rights_material_archived'));
  h.advance(30 * 86400000); token = await fresh(); // signing in writes the vault, which removes the expired record
  await assert.rejects(h.service.readMaterial(token, record.material_id), errorCode('rights_material_not_found'));
  assert.equal((await h.service.listMaterials(token)).materials.length, 0);
});
test('W3 missing initialized vault refuses reinitialization and status reports unavailable chain controls', async (t) => {
  const h = await harness(t), owner = await h.login(['issuer']);
  await fs.rename(path.join(h.directory, 'vault.json'), path.join(h.directory, 'preserved-vault.json'));
  await assert.rejects(h.service.principal(owner.token), errorCode('rights_vault_missing'));
  await assert.rejects(h.service.createSubject({ organization: 'org-a', wallet: Wallet.createRandom().address, roles: ['issuer'] }), errorCode('rights_vault_missing'));
  h.service.chain = { verify: async () => { throw new Error('offline'); } };
  const status = await h.service.status(); assert.equal(status.unavailable, true); assert.equal(status.active_control_plane, false);
});
