import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Wallet, id } from 'ethers';
import { canonicalEvidence, createEvidence, evidenceHash, evidenceProjection, verifyEvidencePackage } from '../src/evidence/schema.js';
import { RightsService } from '../src/rights/service.js';
import { privateCommitment } from '../src/rights/typedData.js';
import { createRightsRoutes } from '../src/app/rightsRoutes.js';
import { sendError } from '../src/app/http.js';
import { listen, requestJson } from './helpers/http.js';
import { seal, unseal } from '../src/rights/vault.js';

const now = Date.parse('2026-10-17T00:00:00.000Z');
const source = { provider: 'public-test-specimen', version: '1', level: 'public_specimen', source_hash: id('source'), observed_at: new Date(now).toISOString() };
const raw = () => { const material = { invoice: 'private-commercial-title', amount: '1000.50' }, c = privateCommitment(material);
  return createEvidence({ kind: 'raw_material', source, references: [], data: { material_json: JSON.stringify(material), document_hash: c.hash, document_salt: c.salt } }, { now }); };
const pack = (root, entries = [root]) => ({ schema: 'agentbl-evidence-package-v1', root_id: root.bundle.evidence_id, entries });

test('W4 evidence canonical encoding rejects lossy values and domain confusion; private salts stay out of projection', () => {
  assert.equal(canonicalEvidence({ z: null, a: ['1.00', 1, true] }), canonicalEvidence({ a: ['1.00', 1, true], z: null }));
  for (const value of [undefined, NaN, Infinity, 0.1, -0, 2 ** 54, { a: undefined }, new Date(), Array(2)]) assert.throws(() => canonicalEvidence(value));
  assert.notEqual(evidenceHash('a', { amount: '1000' }), evidenceHash('b', { amount: '1000' }));
  const first = raw(), second = raw(); assert.notEqual(first.commitment, second.commitment);
  assert.doesNotMatch(JSON.stringify(evidenceProjection(first)), /private-commercial-title|document_salt|material_json/u);
  assert.equal(verifyEvidencePackage(pack(first), { now }).passed, true);
  const altered = structuredClone(first); altered.bundle.data.material_json = '{"invoice":"changed"}';
  altered.commitment = evidenceHash('agentbl-evidence-v1', altered.bundle);
  assert.equal(verifyEvidencePackage(pack(altered), { now }).passed, false, 'source material commitment is independently checked');
});

test('W4 every evidence kind has typed amounts, explicit nullable execution, UTC/version/ref boundaries', () => {
  const root = raw();
  const data = {
    valuation: { amount_atomic: '1000000', currency: 'USD', decimals: 6, basis: 'rule_estimate', as_of: source.observed_at, expires_at: '2026-10-18T00:00:00.000Z', assumptions: { grade: 'research' } },
    offering_terms: { terms_hash: id('terms'), network: 'eip155:31337', terms: { issuePrice: '800000' } },
    approval: { target_hash: root.commitment, version_hash: id('version'), verdict: 'REVIEW', actor_ref: 'private-reviewer', reason: 'Missing source' },
    execution: { plan_hash: id('plan'), network: 'eip155:31337', transaction_hash: null, block_hash: null, status: 'UNKNOWN' },
    payment: { network: 'eip155:31337', asset: `0x${'11'.repeat(20)}`, payer: `0x${'22'.repeat(20)}`, payee: `0x${'33'.repeat(20)}`, amount_atomic: '1000', nonce: id('nonce'), transaction_hash: id('tx'), block_hash: id('block'), confirmations: 2 }
  };
  for (const [kind, value] of Object.entries(data)) {
    const entry = createEvidence({ kind, source, data: value, references: [{ evidence_id: root.bundle.evidence_id, commitment: root.commitment }] }, { now });
    assert.equal(verifyEvidencePackage(pack(entry, [entry, root]), { now }).passed, true, kind);
    assert.equal(verifyEvidencePackage(pack(entry), { now }).passed, false, `${kind}: missing dependency`);
  }
  assert.throws(() => createEvidence({ kind: 'payment', source, references: [], data: { ...data.payment, amount_atomic: 1000 } }, { now }));
  const legacy = raw(); legacy.bundle.schema = 'agentbl-evidence-v0'; assert.equal(verifyEvidencePackage(pack(legacy), { now }).passed, false);
  assert.equal(verifyEvidencePackage(pack(root), { now: now + 91 * 86400000 }).passed, false);
});

test('W4 full private evidence preserves documents above the short-label limit and rejects oversized material', () => {
  const material = { invoice: 'private-commercial-content'.repeat(500), amount: '1000.50' };
  const committed = privateCommitment(material);
  const entry = createEvidence({ kind: 'raw_material', source, references: [], data: {
    material_json: JSON.stringify(material), document_hash: committed.hash, document_salt: committed.salt
  } }, { now });
  assert.ok(entry.bundle.data.material_json.length > 1000);
  assert.deepEqual(JSON.parse(entry.bundle.data.material_json), material);
  assert.equal(verifyEvidencePackage(pack(entry), { now }).passed, true);
  const oversized = { document: 'x'.repeat(500000) }, huge = privateCommitment(oversized);
  assert.throws(() => createEvidence({ kind: 'raw_material', source, references: [], data: {
    material_json: JSON.stringify(oversized), document_hash: huge.hash, document_salt: huge.salt
  } }, { now }));
});

async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'w4-evidence-')), env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') };
  const service = new RightsService({ directory, env, clock: () => now });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const login = async (roles, organization = 'research-org') => {
    const wallet = Wallet.createRandom(), subject = await service.createSubject({ organization, roles, wallet: wallet.address });
    const challenge = await service.createChallenge(subject.subject_id);
    return (await service.openSession({ challenge_id: challenge.challenge_id, signature: await wallet.signTypedData(challenge.domain, challenge.types, challenge.message) })).token;
  };
  const owner = await login(['issuer']), reviewer = await login(['reviewer']);
  const material = await service.createMaterial(owner, { material: { document: 'private-W4-commercial-content', fractional: 1.25 },
    public_summary: { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 30, terms_hash: id('terms'), risk_flags: ['test_asset'] } });
  const entry = await service.createEvidence(owner, { material_id: material.material_id, kind: 'raw_material', source });
  return { directory, env, service, login, owner, reviewer, material, entry };
}

test('W4 authorization, encrypted restart, new-process verification, missing dependency and initialized-vault loss fail explicitly', async (t) => {
  const h = await harness(t), alien = await h.login(['issuer'], 'other-org'), investor = await h.login(['investor']);
  for (const transport of ['http', 'download', 'sse', 'mcp', 'a2a']) {
    await assert.rejects(h.service.invoke(alien, 'read_evidence', h.entry.evidence_id, transport), (error) => error.code === 'evidence_not_found');
    assert.equal((await h.service.invoke(h.owner, 'read_evidence', h.entry.evidence_id, transport)).verification.passed, true);
  }
  const route = createRightsRoutes({ service: h.service, env: h.env });
  const server = await listen(http.createServer((req, res) => route(req, res, new URL(req.url, 'http://local')).catch((error) => sendError(res, error))));
  t.after(server.close);
  const endpoint = `/api/rights/evidence/${h.entry.evidence_id}/download`;
  for (const token of ['', alien, investor]) {
    const response = await requestJson(server.base, 'GET', endpoint, undefined, { 'x-rights-session': token });
    assert.ok([401, 404].includes(response.status));
  }
  const response = await requestJson(server.base, 'GET', endpoint, undefined, { 'x-rights-session': h.owner });
  assert.equal(response.status, 200); assert.equal(response.data.verification.passed, true);
  const file = path.join(h.directory, 'authorized-export.json'); await fs.writeFile(file, JSON.stringify(response.data));
  const child = await promisify(execFile)(process.execPath, ['scripts/verify-evidence.mjs', file], { cwd: process.cwd() });
  assert.equal(JSON.parse(child.stdout).passed, true);
  const restarted = new RightsService({ directory: h.directory, env: h.env, clock: () => now });
  assert.deepEqual(await restarted.exportEvidence(h.owner, h.entry.evidence_id), response.data);
  const vaultFile = path.join(h.directory, 'vault.json'), encrypted = await fs.readFile(vaultFile, 'utf8');
  assert.doesNotMatch(encrypted, /private-W4-commercial-content|document_salt/u); assert.equal(encrypted.includes(h.owner), false);
  const state = unseal(Buffer.from(h.env.AGENTBL_RIGHTS_KEY, 'hex'), JSON.parse(encrypted), 'agentbl-rights-vault-v1');
  state.evidence[h.entry.evidence_id].commitment = id('corrupt');
  await fs.writeFile(vaultFile, JSON.stringify(seal(Buffer.from(h.env.AGENTBL_RIGHTS_KEY, 'hex'), state, 'agentbl-rights-vault-v1')));
  await assert.rejects(restarted.exportEvidence(h.owner, h.entry.evidence_id), (error) => error.code === 'evidence_integrity_failed');
  await fs.rm(vaultFile); await assert.rejects(restarted.exportEvidence(h.owner, h.entry.evidence_id), (error) => error.code === 'rights_vault_missing');
});

test('W4 manual handover binds material revision and runtime version, excludes self-review and retains rejection', async (t) => {
  const h = await harness(t), review = await h.service.requestEvidenceReview(h.owner, h.entry.evidence_id, { reason: 'Provider timeout, inspect original' });
  await assert.rejects(h.service.resolveEvidenceReview(h.owner, review.review_id, { context_hash: review.context_hash, verdict: 'APPROVE', reason: 'Self' }), (error) => error.code === 'rights_independent_review_required');
  await assert.rejects(h.service.resolveEvidenceReview(h.reviewer, review.review_id, { context_hash: id('changed'), verdict: 'APPROVE', reason: 'Stale context' }), (error) => error.code === 'evidence_review_stale');
  const rejected = await h.service.resolveEvidenceReview(h.reviewer, review.review_id, { context_hash: review.context_hash, verdict: 'REJECT', reason: 'Source incomplete' });
  assert.equal(rejected.status, 'REJECTED'); assert.equal(rejected.business_enabled, false);
  await assert.rejects(h.service.resolveEvidenceReview(h.reviewer, review.review_id, { context_hash: review.context_hash, verdict: 'APPROVE', reason: 'Overwrite' }), (error) => error.code === 'evidence_review_stale');
  const policyReview = await h.service.requestEvidenceReview(h.owner, h.entry.evidence_id, { reason: 'Check current runtime policy' });
  h.service.getVersion = () => id('new-runtime-policy');
  await assert.rejects(h.service.resolveEvidenceReview(h.reviewer, policyReview.review_id, { context_hash: policyReview.context_hash, verdict: 'APPROVE', reason: 'Old runtime policy' }), (error) => error.code === 'evidence_review_stale');
  h.service.getVersion = null;
  const next = await h.service.requestEvidenceReview(h.owner, h.entry.evidence_id, { reason: 'Version drift' });
  await h.service.bindTerms(h.owner, h.material.material_id, id('revised terms'));
  await assert.rejects(h.service.resolveEvidenceReview(h.reviewer, next.review_id, { context_hash: next.context_hash, verdict: 'APPROVE', reason: 'Old revision' }), (error) => error.code === 'evidence_review_stale');
});
