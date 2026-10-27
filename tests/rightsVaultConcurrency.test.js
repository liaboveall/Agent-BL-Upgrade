import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Wallet, id } from 'ethers';
import { RightsService } from '../src/rights/service.js';

const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; };
const within = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} still waiting after ${ms}ms`)), ms))]);

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rights-vault-queue-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const chain = {
    prepare: async (principal, input) => ({ chain_id: '31337', pool: `0x${'22'.repeat(20)}`, controller: `0x${'33'.repeat(20)}`, from: principal.wallet,
      to: `0x${'44'.repeat(20)}`, calldata: '0x12345678', nonce: 0, prepared_block: 1, operation: input.operation, material_id: input.material_id }),
    recoverTransaction: async () => null,
    verifyTransaction: async (_plan, txHash) => ({ tx_hash: txHash, status: 'pending', block_number: null, block_hash: null })
  };
  const service = new RightsService({ directory, env: { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') }, chain, getMode: () => 'live', getGeneration: () => 1, ...options });
  const enroll = async (organization, roles) => {
    const signer = Wallet.createRandom(), subject = await service.createSubject({ organization, roles, wallet: signer.address });
    const challenge = await service.createChallenge(subject.subject_id);
    return { subject, session: await service.openSession({ challenge_id: challenge.challenge_id, signature: await signer.signTypedData(challenge.domain, challenge.types, challenge.message) }) };
  };
  const owner = await enroll('tenant-a', ['issuer']), other = await enroll('tenant-b', ['issuer']);
  const material = await service.createMaterial(owner.session.token, { material: { confidential: 'fictional cargo' },
    public_summary: { asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 30, terms_hash: id('terms'), risk_flags: ['simulated_title'] } });
  const plan = await service.prepareTransaction(owner.session.token, { operation: 'register_title', material_id: material.material_id, payload: { issuance: { documentHash: material.document_hash } } });
  return { service, chain, owner, other, plan };
}

test('F04 a slow chain recovery read does not hold the vault: another organization keeps reading its identity and materials', async (t) => {
  const h = await fixture(t), rpc = gate();
  let reading = false;
  h.chain.recoverTransaction = async () => { reading = true; await rpc.promise; return null; };
  const slow = h.service.getPlan(h.owner.session.token, h.plan.plan_id);
  while (!reading) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await within(h.service.principal(h.other.session.token), 2000, 'principal')).organization, 'tenant-b');
  assert.deepEqual((await within(h.service.listMaterials(h.other.session.token), 2000, 'materials')).materials, []);
  rpc.open();
  assert.equal((await slow).plan_id, h.plan.plan_id);
  assert.ok(h.service.queueMetrics().completed > 0);
  assert.equal(h.service.queueMetrics().queued, 0);
});

test('F04 the commit after an unlocked chain read re-checks the session and never writes a stale observation', async (t) => {
  const h = await fixture(t), rpc = gate();
  let reads = 0;
  h.chain.recoverTransaction = async () => { reads++; if (reads === 1) await rpc.promise; return { status: 'nonce_consumed_by_other_transaction', observed_tx_hash: `0x${'99'.repeat(32)}` }; };
  const slow = h.service.getPlan(h.owner.session.token, h.plan.plan_id);
  while (!reads) await new Promise((resolve) => setImmediate(resolve));
  // While the scan is outstanding the wallet hash is attached; the scan's older view must not overwrite it.
  const attached = await h.service.attachTransaction(h.owner.session.token, h.plan.plan_id, `0x${'aa'.repeat(32)}`);
  assert.equal(attached.status, 'pending');
  rpc.open();
  const result = await slow;
  assert.equal(result.tx_hash, `0x${'aa'.repeat(32)}`);
  assert.equal(result.status, 'pending', 'the retried read verified the attached hash instead of applying the stale scan');
  assert.equal(reads, 1);

  const revoke = gate(); let verifying = false;
  h.chain.verifyTransaction = async (_plan, txHash) => { verifying = true; await revoke.promise; return { tx_hash: txHash, status: 'confirmed', block_number: 9, block_hash: `0x${'bb'.repeat(32)}` }; };
  const pending = h.service.getPlan(h.owner.session.token, h.plan.plan_id);
  while (!verifying) await new Promise((resolve) => setImmediate(resolve));
  await h.service.revokeSession(h.owner.session.session_id);
  revoke.open();
  await assert.rejects(pending, { code: 'rights_session_required' });
});

test('F04 the vault queue is bounded and a request that waited too long is refused, not run later', async (t) => {
  const h = await fixture(t, { queueLimit: 2, waitMs: 50 }), held = gate(), original = h.service.writer;
  let ran = 0;
  h.service.writer = { exclusive: async (task) => { await held.promise; return task(); } };
  const waiting = [h.service.principal(h.owner.session.token), h.service.principal(h.other.session.token)];
  await assert.rejects(h.service.principal(h.owner.session.token), { code: 'rights_vault_busy' }, 'beyond the queue limit');
  for (const request of waiting) await assert.rejects(request, { code: 'rights_vault_busy' }, 'waited past the limit');
  assert.equal(h.service.queueMetrics().queued, 0);
  assert.equal(h.service.queueMetrics().rejected, 3);
  h.service.writer = { exclusive: (task) => original.exclusive(async () => { ran++; return task(); }) };
  held.open(); await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ran, 0, 'abandoned requests did not take the lock once it was free');
  assert.equal((await h.service.principal(h.owner.session.token)).organization, 'tenant-a');
  assert.equal(ran, 1);
});
