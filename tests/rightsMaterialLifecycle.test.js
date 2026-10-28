import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { RightsService } from '../src/rights/service.js';
import { FINANCING_RECORD_RETENTION_MS, MATERIAL_ARCHIVE_MS } from '../src/rights/retention.js';
import { disclosureFixture } from './helpers/disclosure.js';

const DAY = 86_400_000;
const summary = (tenor_days) => ({ asset_class: 'copper', settlement: 'TEST_USDC', tenor_days, terms_hash: disclosureFixture().terms_hash, risk_flags: ['simulated_title'] });

async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rights-lifecycle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const start = Date.parse('2027-01-04T00:00:00Z'); let now = start;
  const service = new RightsService({ directory, env: { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') }, clock: () => now, getVersion: () => 'lifecycle-test' });
  const enroll = async (roles, wallet = Wallet.createRandom()) => {
    const subject = await service.createSubject({ organization: 'lifecycle', wallet: wallet.address, roles });
    const login = async () => {
      const challenge = await service.createChallenge(subject.subject_id);
      return (await service.openSession({ challenge_id: challenge.challenge_id, signature: await wallet.signTypedData(challenge.domain, challenge.types, challenge.message) })).token;
    };
    return { subject, wallet, login };
  };
  const source = () => ({ provider: 'lifecycle-fixture', version: '1', level: 'synthetic', source_hash: `0x${'ab'.repeat(32)}`, observed_at: new Date(now).toISOString() });
  return { service, enroll, source, day: (n) => { now = start + n * DAY; }, seconds: (n) => String(Math.floor((start + n * DAY) / 1000)) };
}
/** Saved terms for the material maturing on day `maturity` of the harness clock. */
function terms(h, issuer, material, maturity, revision = 1) {
  const { schema: _schema, policy: _policy, ...input } = structuredClone(disclosureFixture().document);
  Object.assign(input, { revision, parties: { ...input.parties, issuer: issuer.wallet.address } });
  Object.assign(input.terms, { documentHash: material.document_hash, subscribeUntil: h.seconds(maturity - 60), disburseUntil: h.seconds(maturity - 50), maturity: h.seconds(maturity) });
  return input;
}

test('a 180-day financing keeps its material readable and writable past day 91, 121 and to day 366', async (t) => {
  const h = await harness(t), issuer = await h.enroll(['issuer']);
  const material = await h.service.createMaterial(await issuer.login(), { material: { title: 'fictional 180-day cargo' }, public_summary: summary(180) });
  for (const day of [91, 121]) {
    h.day(day); const token = await issuer.login();
    assert.equal((await h.service.readMaterial(token, material.material_id)).archived, false, `day ${day}`);
    await h.service.createEvidence(token, { material_id: material.material_id, kind: 'raw_material', source: h.source() });
  }
  h.day(150); await h.service.createFinancingDisclosure(await issuer.login(), material.material_id, terms(h, issuer, material, 330));
  h.day(366); const token = await issuer.login();
  const read = await h.service.readMaterial(token, material.material_id);
  assert.equal(read.archived, false);
  assert.equal(read.retention_until, Number(h.seconds(330)) * 1000 + FINANCING_RECORD_RETENTION_MS, 'retention follows the pool maturity, not the creation date');
  const evidence = await h.service.createEvidence(token, { material_id: material.material_id, kind: 'raw_material', source: h.source() });
  const exported = await h.service.exportEvidence(token, evidence.evidence_id);
  assert.equal(Date.parse(exported.entries[0].bundle.expires_at), read.retention_until, 'new evidence lasts as long as the financing record');
});

test('material behind several financings follows the latest maturity; a finished one is archived, then leaves the vault', async (t) => {
  const h = await harness(t), issuer = await h.enroll(['issuer']);
  const material = await h.service.createMaterial(await issuer.login(), { material: { title: 'fictional cargo, two rounds' }, public_summary: summary(30) });
  await h.service.createFinancingDisclosure(await issuer.login(), material.material_id, terms(h, issuer, material, 100));
  await h.service.createFinancingDisclosure(await issuer.login(), material.material_id, terms(h, issuer, material, 200, 2));
  const end = 200 + FINANCING_RECORD_RETENTION_MS / DAY;
  h.day(end - 1); assert.equal((await h.service.readMaterial(await issuer.login(), material.material_id)).archived, false);
  h.day(end + 1); let token = await issuer.login();
  assert.equal((await h.service.readMaterial(token, material.material_id)).archived, true, 'archived is still readable');
  await assert.rejects(h.service.createEvidence(token, { material_id: material.material_id, kind: 'raw_material', source: null }), { code: 'rights_material_archived' });
  h.day(end + MATERIAL_ARCHIVE_MS / DAY + 1); token = await issuer.login(); // this login writes the vault, which prunes it
  await assert.rejects(h.service.readMaterial(token, material.material_id), { code: 'rights_material_not_found' });
});

test('an unreconciled wallet operation holds its material active past retention until it is reconciled', async (t) => {
  const h = await harness(t);
  let receipt = null;
  h.service.getMode = () => 'live';
  h.service.chain = { prepare: async (principal, input) => ({ chain_id: '31337', pool: `0x${'22'.repeat(20)}`, controller: `0x${'33'.repeat(20)}`, from: principal.wallet,
    to: `0x${'44'.repeat(20)}`, calldata: '0x12345678', nonce: 0, operation: input.operation, material_id: input.material_id }), recoverTransaction: async () => receipt };
  const issuer = await h.enroll(['issuer']);
  const material = await h.service.createMaterial(await issuer.login(), { material: { title: 'fictional cargo in flight' }, public_summary: summary(10) });
  let token = await issuer.login();
  const plan = await h.service.prepareTransaction(token, { operation: 'register_title', material_id: material.material_id, payload: { issuance: { documentHash: material.document_hash } } });
  await h.service.checkpointPlan(token, plan.plan_id);
  h.day(400); token = await issuer.login(); // far past retention (day 100) and its archive window
  assert.equal((await h.service.readMaterial(token, material.material_id)).archived, false, 'an operation awaiting reconciliation keeps the record active');
  receipt = { status: 'confirmed', tx_hash: `0x${'ab'.repeat(32)}` };
  assert.equal((await h.service.getPlan(token, plan.plan_id)).status, 'confirmed');
  await assert.rejects(h.service.readMaterial(await issuer.login(), material.material_id), { code: 'rights_material_not_found' }, 'once reconciled, the next write prunes it');
});
