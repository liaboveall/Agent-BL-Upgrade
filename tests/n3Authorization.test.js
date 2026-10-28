import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Wallet, id } from 'ethers';
import { RightsService } from '../src/rights/service.js';
import http from 'node:http';
import { listen, requestJson } from './helpers/http.js';
import { readJsonBody, sendError } from '../src/app/http.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'n3-authorization-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let generation = 1, now = Date.now();
  const wallet = Wallet.createRandom(), chain = { prepare: async (principal, input) => ({ chain_id: '31337', pool: `0x${'22'.repeat(20)}`,
    controller: `0x${'33'.repeat(20)}`, from: principal.wallet, to: `0x${'44'.repeat(20)}`, calldata: '0x12345678', nonce: 0, operation: input.operation, material_id: input.material_id }) };
  const service = new RightsService({ directory, env: { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') }, chain, clock: () => now, getMode: () => 'live', getGeneration: () => generation });
  const enroll = async (organization, roles, signer = Wallet.createRandom()) => {
    const subject = await service.createSubject({ organization, roles, wallet: signer.address });
    const login = async () => { const challenge = await service.createChallenge(subject.subject_id); return service.openSession({ challenge_id: challenge.challenge_id, signature: await signer.signTypedData(challenge.domain, challenge.types, challenge.message) }); };
    return { subject, login, signer, session: await login() };
  };
  const owner = await enroll('tenant-a', ['issuer'], wallet), outsider = await enroll('tenant-b', ['issuer']);
  const material = await service.createMaterial(owner.session.token, { material: { confidential: 'fictional cargo' }, public_summary: { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 30, terms_hash: id('terms'), risk_flags: ['simulated_title'] } });
  const input = { operation: 'register_title', material_id: material.material_id, payload: { issuance: { documentHash: material.document_hash } } };
  return { service, chain, owner, outsider, material, input, bump: () => { generation++; }, advance: (ms) => { now += ms; } };
}

test('N3 wallet sessions retain tenant boundaries, bounded challenges and immediate enrollment revocation', async (t) => {
  const h = await fixture(t);
  assert.equal((await h.service.listMaterials(h.owner.session.token)).materials.length, 1);
  assert.equal((await h.service.listMaterials(h.outsider.session.token)).materials.length, 0);
  await assert.rejects(h.service.workflow(h.outsider.session.token, h.material.material_id), { code: 'rights_material_not_found' });
  // Unsigned requests share the open challenge instead of using up the wallet's sign-in: a wrong signature does not
  // spend it, one with under two minutes left is replaced, and the wallet's own signature spends it once.
  const asked = [];
  for (let i = 0; i < 5; i++) asked.push(await h.service.createChallenge(h.owner.subject.subject_id, { selfService: true }));
  assert.equal(new Set(asked.map((c) => c.challenge_id)).size, 1, 'repeated unsigned requests never block the wallet');
  const [shared] = asked, sign = (signer, c) => signer.signTypedData(c.domain, c.types, c.message);
  await assert.rejects(h.service.openSession({ challenge_id: shared.challenge_id, signature: await sign(h.outsider.signer, shared) }), { code: 'rights_signature_invalid' });
  h.advance(181000);
  assert.notEqual((await h.service.createChallenge(h.owner.subject.subject_id, { selfService: true })).challenge_id, shared.challenge_id);
  assert.ok((await h.service.openSession({ challenge_id: shared.challenge_id, signature: await sign(h.owner.signer, shared) })).token);
  await assert.rejects(h.service.openSession({ challenge_id: shared.challenge_id, signature: await sign(h.owner.signer, shared) }), { code: 'rights_challenge_invalid' });
  await h.service.revokeSubject(h.owner.subject.subject_id);
  await assert.rejects(h.service.listMaterials(h.owner.session.token), { code: 'rights_session_required' });
  const challenge = await h.service.createChallenge(h.owner.subject.subject_id, { selfService: true, exitOnly: true });
  assert.equal((await h.service.createChallenge(h.owner.subject.subject_id, { selfService: true, exitOnly: true })).challenge_id, challenge.challenge_id, 'Exit challenge can be reused without allocating more challenges or waiting for intake limits');
  const exit = await h.service.openSession({ challenge_id: challenge.challenge_id, signature: await h.owner.signer.signTypedData(challenge.domain, challenge.types, challenge.message) });
  assert.equal(exit.exit_only, true);
  const principal = await h.service.principal(exit.token, { allowExitOnly: true }); assert.equal(principal.wallet, h.owner.subject.wallet); assert.deepEqual(principal.roles, []);
  await assert.rejects(h.service.listMaterials(exit.token), { code: 'rights_session_required' });
  await assert.rejects(h.service.prepareTransaction(exit.token, h.input), { code: 'rights_session_required' });
});

test('N3 a wallet finds only its own enrolled identities by signing a lookup, which opens no session', async (t) => {
  const h = await fixture(t), sign = (signer, c) => signer.signTypedData(c.domain, c.types, c.message);
  const lookup = h.service.identityChallenge(h.owner.signer.address);
  assert.equal(h.service.identityChallenge(h.owner.signer.address.toLowerCase()).challenge_id, lookup.challenge_id, 'asking again shares the open lookup');
  await assert.rejects(h.service.findIdentities({ challenge_id: lookup.challenge_id, signature: await sign(h.outsider.signer, lookup) }), { code: 'identity_lookup_invalid' });
  const found = await h.service.findIdentities({ challenge_id: lookup.challenge_id, signature: await sign(h.owner.signer, lookup) });
  assert.deepEqual(found, { identities: [{ subject_id: h.owner.subject.subject_id, organization: 'tenant-a', roles: ['issuer'], revoked: false }] });
  assert.equal(JSON.stringify(found).includes('token'), false);
  await assert.rejects(h.service.findIdentities({ challenge_id: lookup.challenge_id, signature: await sign(h.owner.signer, lookup) }), { code: 'identity_lookup_invalid' }, 'a lookup is spent once');
  await h.service.revokeSubject(h.owner.subject.subject_id);
  const again = h.service.identityChallenge(h.owner.signer.address);
  assert.equal((await h.service.findIdentities({ challenge_id: again.challenge_id, signature: await sign(h.owner.signer, again) })).identities[0].revoked, true);
  assert.throws(() => h.service.identityChallenge('0x123'), { code: 'rights_invalid_input' });
});

test('N3 vault drops challenges and sessions a day after they expire, keeping live ones', async (t) => {
  const h = await fixture(t);
  const { unseal } = await import('../src/rights/vault.js');
  const vault = async () => unseal(Buffer.from(h.service.env.AGENTBL_RIGHTS_KEY, 'hex'), JSON.parse(await fs.readFile(path.join(h.service.directory, 'vault.json'), 'utf8')), 'agentbl-rights-vault-v1');
  for (let i = 0; i < 3; i++) await h.service.createChallenge(h.owner.subject.subject_id, { selfService: true });
  const before = await vault();
  assert.ok(Object.keys(before.challenges).length >= 3);
  // Sessions last an hour and challenges five minutes; after a day of grace both are gone on the next write.
  h.advance(25 * 60 * 60 * 1000);
  const fresh = await h.owner.login();
  const after = await vault();
  assert.deepEqual(Object.values(after.challenges).map((challenge) => challenge.used), [true], 'only the challenge behind the new session remains');
  assert.deepEqual(Object.values(after.sessions).map((session) => session.session_id), [fresh.session_id]);
  assert.equal((await h.service.listMaterials(fresh.token)).materials.length, 1);
});

test('N3 draft authorization is invalidated by material, session, mode generation or instance changes', async (t) => {
  const h = await fixture(t), token = h.owner.session.token;
  await assert.rejects(h.service.prepareTransaction(h.outsider.session.token, h.input), { code: 'rights_material_not_found' });
  const materialDraft = await h.service.prepareTransaction(token, h.input);
  await h.service.bindTerms(token, h.material.material_id, id('changed terms'));
  await assert.rejects(h.service.checkpointPlan(token, materialDraft.plan_id), { code: 'execution_context_changed' });
  const sessionDraft = await h.service.prepareTransaction(token, h.input), nextSession = await h.owner.login();
  await assert.rejects(h.service.checkpointPlan(nextSession.token, sessionDraft.plan_id), { code: 'execution_context_changed' });
  const modeDraft = await h.service.prepareTransaction(token, h.input); h.bump();
  await assert.rejects(h.service.checkpointPlan(token, modeDraft.plan_id), { code: 'execution_context_changed' });
  const instanceDraft = await h.service.prepareTransaction(token, h.input), original = h.chain.prepare;
  h.chain.prepare = async (...args) => ({ ...await original(...args), pool: `0x${'55'.repeat(20)}` });
  await assert.rejects(h.service.checkpointPlan(token, instanceDraft.plan_id), { code: 'rights_plan_changed' });
  h.chain.prepare = async (...args) => { h.bump(); return original(...args); };
  await assert.rejects(h.service.prepareTransaction(token, h.input), { code: 'execution_context_changed' });
});

test('N3 malformed private attachments and provider failures do not echo their bytes into responses or logs', async (t) => {
  const secret = 'synthetic-private-attachment-and-rpc-token', logs = [];
  const app = await listen(http.createServer((request, response) => (async () => {
    if (request.url === '/provider') throw Object.assign(new Error(`https://rpc.invalid/${secret}`), { privatePayload: secret });
    await readJsonBody(request);
  })().catch((error) => sendError(response, error, { requestId: 'synthetic-request', logger: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) } }))));
  t.after(() => app.close());
  const malformed = await requestJson(app.base, 'POST', '/attachment', `{${secret}`);
  assert.equal(malformed.status, 400); assert.equal(malformed.data.code, 'invalid_json');
  const provider = await requestJson(app.base, 'GET', '/provider');
  assert.equal(provider.status, 500); assert.equal(provider.data.request_id, 'synthetic-request');
  assert.equal(JSON.stringify({ malformed: malformed.data, provider: provider.data, logs }).includes(secret), false);
  assert.ok(JSON.stringify(logs).includes('internal_error'));
});
