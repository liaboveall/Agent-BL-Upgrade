// F01 (full-project-assessment-2026-10-29): a wallet rejection after the checkpoint must not block the wallet's role
// operations. The chain here is a model of one account's nonces and mined transactions; the real adapter's reads are
// exercised against a local EVM in tests/w3CrossLayer.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { RightsService } from '../src/rights/service.js';

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;

/** One wallet's account: `latest` mined nonces, a mempool, and what was mined at each nonce. */
function modelChain() {
  const account = { latest: 0, mempool: new Map(), mined: new Map(), block: 10 };
  const calldata = (input) => `0x${Buffer.from(input.operation + (input.evidence_hash ?? '')).toString('hex')}`;
  const chain = {
    account,
    prepare: async (principal, input) => ({ chain_id: '1439', pool: `0x${'22'.repeat(20)}`, controller: `0x${'33'.repeat(20)}`, from: principal.wallet,
      to: `0x${'44'.repeat(20)}`, calldata: calldata(input), nonce: account.latest + account.mempool.size, prepared_block: account.block, operation: input.operation }),
    verifyTransaction: async (plan, txHash) => {
      const tx = [...account.mined.values()].find((item) => item.hash === txHash);
      if (!tx) return { tx_hash: txHash, status: 'pending', block_number: null, block_hash: null };
      return { tx_hash: txHash, status: account.block - tx.block >= 2 ? 'confirmed' : 'confirming', block_number: tx.block, block_hash: hash(tx.block) };
    },
    recoverTransaction: async (plan) => {
      const tx = account.mined.get(plan.nonce);
      if (!tx) return null;
      if (tx.data === plan.calldata) return chain.verifyTransaction(plan, tx.hash);
      return { status: 'nonce_consumed_by_other_transaction', observed_tx_hash: tx.hash, settled: account.block - tx.block >= 2, block_number: tx.block, block_hash: hash(tx.block) };
    },
    releaseObservation: async (plan) => {
      if (plan.tx_hash && [...account.mined.values()].some((tx) => tx.hash === plan.tx_hash)) return { state: 'own', observed: await chain.verifyTransaction(plan, plan.tx_hash) };
      if (account.latest <= plan.nonce) return { state: account.mempool.has(plan.nonce) ? 'pending' : 'unused' };
      const observed = await chain.recoverTransaction(plan);
      return observed.status === 'nonce_consumed_by_other_transaction' ? { state: 'other', ...observed } : { state: 'own', observed };
    },
    // The wallet's own sends: into the mempool, then mined one block at a time.
    send: (nonce, data, txHash) => { account.mempool.set(nonce, { nonce, data, hash: txHash }); },
    mine: (blocks = 1) => {
      for (const [nonce, tx] of [...account.mempool].sort(([a], [b]) => a - b)) {
        if (nonce !== account.latest) break;
        account.mined.set(nonce, { ...tx, block: account.block + 1 }); account.mempool.delete(nonce); account.latest++;
      }
      account.block += blocks;
    }
  };
  return chain;
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rights-plan-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const chain = modelChain(), env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') };
  const service = new RightsService({ directory, env, chain, getMode: () => 'live', getGeneration: () => 1 });
  const signer = Wallet.createRandom(), subject = await service.createSubject({ organization: 'f01-review', roles: ['compliance'], wallet: signer.address });
  const signIn = async (who = subject, { exitOnly = false } = {}) => {
    const challenge = await service.createChallenge(who.subject_id, { exitOnly });
    return (await service.openSession({ challenge_id: challenge.challenge_id, signature: await signer.signTypedData(challenge.domain, challenge.types, challenge.message) })).token;
  };
  const token = await signIn();
  const input = (n = 1) => ({ operation: 'refresh_screening', valid_until: '1900000000', evidence_hash: hash(n) });
  return { chain, service, token, signIn, input, directory, env, signer, subject };
}

test('F01 a rejected role transaction releases its plan, and the same or a new plan can then be sent', async (t) => {
  const h = await fixture(t);
  const first = await h.service.prepareTransaction(h.token, h.input());
  await h.service.checkpointPlan(h.token, first.plan_id);
  // The wallet rejects: nothing reaches the mempool. Before the fix both of these stayed blocked.
  const second = await h.service.prepareTransaction(h.token, h.input(2));
  await assert.rejects(h.service.checkpointPlan(h.token, second.plan_id), { code: 'rights_plan_reconcile_required' });
  const released = await h.service.releasePlan(h.token, first.plan_id);
  assert.equal(released.status, 'released');
  assert.equal((await h.service.getPlan(h.token, first.plan_id)).status, 'released', 'an unused nonce leaves it released');
  // Retrying the same reviewed plan reuses its reserved nonce.
  assert.equal((await h.service.checkpointPlan(h.token, first.plan_id)).status, 'broadcast_prepared');
  h.chain.send(first.nonce, first.calldata, hash(0xa1)); h.chain.mine(3);
  const attached = await h.service.attachTransaction(h.token, first.plan_id, hash(0xa1));
  assert.equal(attached.status, 'confirmed');
  // A plan prepared while the first was blocked was built on the same nonce: it can never be sent now.
  await assert.rejects(h.service.checkpointPlan(h.token, second.plan_id), { code: 'rights_plan_changed' });
  const third = await h.service.prepareTransaction(h.token, h.input(3));
  assert.equal((await h.service.checkpointPlan(h.token, third.plan_id)).status, 'broadcast_prepared');
});

test('F01 a new plan after a release must reuse the reserved nonce, and supersedes the released one once that is deep', async (t) => {
  const h = await fixture(t);
  const first = await h.service.prepareTransaction(h.token, h.input());
  await h.service.checkpointPlan(h.token, first.plan_id);
  await h.service.releasePlan(h.token, first.plan_id);
  const next = await h.service.prepareTransaction(h.token, h.input(2));
  assert.equal(next.nonce, first.nonce, 'the new send takes the reserved nonce, so at most one of them can be mined');
  await h.service.checkpointPlan(h.token, next.plan_id);
  h.chain.send(next.nonce, next.calldata, hash(0xb1)); h.chain.mine();
  assert.equal((await h.service.attachTransaction(h.token, next.plan_id, hash(0xb1))).status, 'confirming');
  // The released plan's nonce is now used by another transaction, but only one block deep: it stays released.
  const shallow = await h.service.getPlan(h.token, first.plan_id);
  assert.deepEqual([shallow.status, shallow.confirmation_pending], ['released', true]);
  h.chain.mine(2);
  assert.equal((await h.service.getPlan(h.token, next.plan_id)).status, 'confirmed');
  const deep = await h.service.getPlan(h.token, first.plan_id);
  assert.deepEqual([deep.status, deep.superseded_by_tx_hash], ['superseded', hash(0xb1)]);
  await assert.rejects(h.service.checkpointPlan(h.token, first.plan_id), { code: 'rights_plan_reconcile_required' });
});

test('F01 an unrelated transaction that consumed the nonce frees the wallet only once canonical and deep', async (t) => {
  const h = await fixture(t);
  const first = await h.service.prepareTransaction(h.token, h.input());
  await h.service.checkpointPlan(h.token, first.plan_id);
  // The report's counterexample: another transaction from the wallet takes the nonce.
  h.chain.send(first.nonce, '0xdead', hash(0xc1));
  await assert.rejects(h.service.releasePlan(h.token, first.plan_id), { code: 'rights_transaction_pending' });
  h.chain.mine();
  const pending = await h.service.releasePlan(h.token, first.plan_id);
  assert.deepEqual([pending.status, pending.confirmation_pending, pending.nonce_used_by_tx_hash], ['broadcast_prepared', true, hash(0xc1)]);
  const blocked = await h.service.prepareTransaction(h.token, h.input(2));
  await assert.rejects(h.service.checkpointPlan(h.token, blocked.plan_id), { code: 'rights_plan_reconcile_required' });
  h.chain.mine(2);
  const superseded = await h.service.getPlan(h.token, first.plan_id);
  assert.equal(superseded.status, 'superseded');
  const next = await h.service.prepareTransaction(h.token, h.input(3));
  assert.equal((await h.service.checkpointPlan(h.token, next.plan_id)).status, 'broadcast_prepared');
  // A reorganization that drops the superseding transaction reopens the plan; it never stays wrongly final.
  h.chain.account.mined.delete(first.nonce); h.chain.account.latest = first.nonce;
  const reopened = await h.service.getPlan(h.token, first.plan_id);
  assert.equal(reopened.status, 'broadcast_prepared');
  assert.equal(reopened.supersede_history.length, 1);
});

test('F01 a "rejected" answer for an operation that was in fact sent keeps it open and binds the transaction', async (t) => {
  const h = await fixture(t);
  const first = await h.service.prepareTransaction(h.token, h.input());
  await h.service.checkpointPlan(h.token, first.plan_id);
  h.chain.send(first.nonce, first.calldata, hash(0xd1));
  await assert.rejects(h.service.releasePlan(h.token, first.plan_id), { code: 'rights_transaction_pending' });
  h.chain.mine(3);
  const bound = await h.service.releasePlan(h.token, first.plan_id);
  assert.deepEqual([bound.status, bound.tx_hash], ['confirmed', hash(0xd1)]);
});

test('F01 recovery survives a new session and a restart; a released plan whose nonce was then used by itself is reported', async (t) => {
  const h = await fixture(t);
  const first = await h.service.prepareTransaction(h.token, h.input());
  await h.service.checkpointPlan(h.token, first.plan_id);
  const other = await h.signIn();
  const restarted = new RightsService({ directory: h.directory, env: h.env, chain: h.chain, getMode: () => 'live', getGeneration: () => 1 });
  assert.equal((await restarted.releasePlan(other, first.plan_id)).status, 'released');
  // The wallet had in fact broadcast it: a later send cannot silently take a second nonce.
  h.chain.send(first.nonce, first.calldata, hash(0xe1)); h.chain.mine(3);
  const next = await restarted.prepareTransaction(other, h.input(2));
  await assert.rejects(restarted.checkpointPlan(other, next.plan_id), { code: 'rights_released_operation_mined' });
  assert.equal((await restarted.getPlan(other, first.plan_id)).status, 'confirmed');
  const fresh = await restarted.prepareTransaction(other, h.input(3));
  assert.equal((await restarted.checkpointPlan(other, fresh.plan_id)).status, 'broadcast_prepared');
  // An unsent draft is abandoned rather than released.
  const draft = await restarted.prepareTransaction(other, h.input(4));
  assert.equal((await restarted.releasePlan(other, draft.plan_id)).status, 'abandoned');
});

test('pending plan discovery survives storage loss, is owner scoped, labels the instance and cannot release a pending nonce', async (t) => {
  const h = await fixture(t), first = await h.service.prepareTransaction(h.token, h.input());
  await h.service.checkpointPlan(h.token, first.plan_id);
  const token = await h.signIn();
  const restarted = new RightsService({ directory: h.directory, env: h.env, chain: h.chain, getMode: () => 'live', getGeneration: () => 1 });
  h.chain.verify = async () => ({ chain_id: first.chain_id, pool: first.pool, controller: first.controller });
  const found = await restarted.listPendingPlans(token);
  assert.deepEqual(found.plans.map(p => p.plan_id), [first.plan_id]);
  assert.equal(found.plans[0].calldata, undefined, 'discovery exposes minimal recovery metadata');
  await assert.rejects(restarted.listPendingPlans('invalid'));
  const stranger = Wallet.createRandom();
  const subject = await restarted.createSubject({ organization: 'f01-review', roles: ['compliance'], wallet: stranger.address });
  const challenge = await restarted.createChallenge(subject.subject_id);
  const other = await restarted.openSession({ challenge_id: challenge.challenge_id, signature: await stranger.signTypedData(challenge.domain, challenge.types, challenge.message) });
  assert.deepEqual((await restarted.listPendingPlans(other.token)).plans, []);
  await assert.rejects(restarted.getPlan(other.token, first.plan_id), { code: 'rights_plan_not_found' });
  assert.equal(found.plans[0].current_instance, true);
  // F03 (assessment 2026-11-04): a plan of an earlier instance on the same chain still holds the nonce, so it stays listed.
  h.chain.verify = async () => ({ chain_id: first.chain_id, pool: `0x${'99'.repeat(20)}`, controller: first.controller });
  assert.deepEqual((await restarted.listPendingPlans(token)).plans.map((p) => [p.plan_id, p.current_instance]), [[first.plan_id, false]]);
  // Another chain's nonces are another account history: nothing there blocks or reconciles this plan.
  h.chain.verify = async () => ({ chain_id: '31337', pool: first.pool, controller: first.controller });
  assert.deepEqual((await restarted.listPendingPlans(token)).plans, []);
  h.chain.verify = async () => ({ chain_id: first.chain_id, pool: first.pool, controller: first.controller });
  h.chain.send(first.nonce, first.calldata, hash(0xfa));
  await assert.rejects(restarted.releasePlan(token, found.plans[0].plan_id), { code: 'rights_transaction_pending' });
  assert.equal((await restarted.listPendingPlans(token)).plans.length, 1);
  h.chain.mine(3);
  assert.equal((await restarted.getPlan(token, found.plans[0].plan_id)).status, 'confirmed');
  assert.deepEqual((await restarted.listPendingPlans(token)).plans, []);
});

// What recovery may show of a plan: never its arguments, material or the identity that prepared it.
const PRIVATE_FIELDS = ['calldata', 'preview', 'plan_input', 'organization', 'subject_id', 'session_id', 'material_id', 'from'];
const summaryOnly = (plan) => { for (const key of PRIVATE_FIELDS) assert.equal(plan[key], undefined, `${key} must not be shown`); };

test('F02 a revoked identity settles its own saved operation in an exit-only session; the wallet then sends under its new identity', async (t) => {
  const h = await fixture(t);
  const old = await h.service.prepareTransaction(h.token, h.input());
  await h.service.checkpointPlan(h.token, old.plan_id);
  await h.service.revokeSubject(h.subject.subject_id);
  // Revocation removes every role at once: the old session can no longer prepare or send anything.
  await assert.rejects(h.service.prepareTransaction(h.token, h.input(2)), { code: 'rights_session_required' });
  const exit = await h.signIn(h.subject, { exitOnly: true });
  const listed = await h.service.listPendingPlans(exit);
  assert.deepEqual(listed.plans.map((plan) => [plan.plan_id, plan.status, plan.operation]), [[old.plan_id, 'broadcast_prepared', 'refresh_screening']]);
  summaryOnly(listed.plans[0]);
  const read = await h.service.getPlan(exit, old.plan_id);
  assert.equal(read.status, 'broadcast_prepared'); summaryOnly(read);
  // Recovery never sends and never reads material.
  await assert.rejects(h.service.checkpointPlan(exit, old.plan_id), { code: 'rights_session_required' });
  await assert.rejects(h.service.prepareTransaction(exit, h.input(3)), { code: 'rights_session_required' });
  await assert.rejects(h.service.listMaterials(exit), { code: 'rights_session_required' });
  // The same wallet enrolled in another organization is blocked, and told which identity holds the blocker.
  const replacement = await h.service.createSubject({ organization: 'f02-new-org', roles: ['compliance'], wallet: h.signer.address });
  const token = await h.signIn(replacement);
  const discovered = await h.service.listPendingPlans(token);
  assert.deepEqual(discovered.plans, []);
  assert.deepEqual(discovered.other_identities.map((identity) => [identity.subject_id, identity.organization, identity.revoked, identity.plans.map((plan) => plan.plan_id)]),
    [[h.subject.subject_id, 'f01-review', true, [old.plan_id]]]);
  summaryOnly(discovered.other_identities[0].plans[0]);
  const next = await h.service.prepareTransaction(token, h.input(4));
  const blocked = await h.service.checkpointPlan(token, next.plan_id).catch((error) => error);
  assert.equal(blocked.code, 'rights_plan_reconcile_required');
  assert.deepEqual(blocked.details, { plan_ids: [], other_identities: [{ subject_id: h.subject.subject_id, organization: 'f01-review', revoked: true, plan_ids: [old.plan_id] }] });
  // Each identity settles only its own plans.
  await assert.rejects(h.service.releasePlan(token, old.plan_id), { code: 'rights_plan_not_found' });
  const released = await h.service.releasePlan(exit, old.plan_id);
  assert.equal(released.status, 'released'); summaryOnly(released);
  assert.equal(next.nonce, old.nonce, 'the new send reuses the reserved nonce, so at most one of the two can be mined');
  assert.equal((await h.service.checkpointPlan(token, next.plan_id)).status, 'broadcast_prepared');
  assert.deepEqual((await h.service.listPendingPlans(exit)).plans, []);
});

test('F02 an exit-only session keeps a sent operation open and binds it once mined, without regaining a role', async (t) => {
  const h = await fixture(t);
  const old = await h.service.prepareTransaction(h.token, h.input());
  await h.service.checkpointPlan(h.token, old.plan_id);
  await h.service.revokeSubject(h.subject.subject_id);
  const exit = await h.signIn(h.subject, { exitOnly: true });
  h.chain.send(old.nonce, old.calldata, hash(0x51));
  await assert.rejects(h.service.releasePlan(exit, old.plan_id), { code: 'rights_transaction_pending' });
  h.chain.mine(3);
  const bound = await h.service.attachTransaction(exit, old.plan_id, hash(0x51));
  assert.deepEqual([bound.status, bound.tx_hash], ['confirmed', hash(0x51)]); summaryOnly(bound);
  assert.deepEqual((await h.service.listPendingPlans(exit)).plans, []);
  assert.deepEqual((await h.service.principal(exit, { allowExitOnly: true })).roles, []);
});

test('F03 after a move to another instance on the same chain the old plan is listed, reconciled and released, then the new one sends', async (t) => {
  const h = await fixture(t);
  const A = { pool: `0x${'22'.repeat(20)}`, controller: `0x${'33'.repeat(20)}` }, B = { pool: `0x${'55'.repeat(20)}`, controller: `0x${'66'.repeat(20)}` };
  h.chain.verify = async () => ({ chain_id: '1439', ...A });
  const old = await h.service.prepareTransaction(h.token, h.input());
  await h.service.checkpointPlan(h.token, old.plan_id);
  // Same wallet, same vault, same chain; the configuration now names instance B. The browser lost its local record.
  const moved = { ...h.chain, prepare: async (principal, input) => ({ ...await h.chain.prepare(principal, input), ...B }), verify: async () => ({ chain_id: '1439', ...B }) };
  const service = new RightsService({ directory: h.directory, env: h.env, chain: moved, getMode: () => 'live', getGeneration: () => 1 });
  const listed = await service.listPendingPlans(h.token);
  assert.deepEqual(listed.plans.map((plan) => [plan.plan_id, plan.current_instance, plan.pool, plan.controller]), [[old.plan_id, false, A.pool, A.controller]]);
  const fresh = await service.prepareTransaction(h.token, h.input(2));
  const blocked = await service.checkpointPlan(h.token, fresh.plan_id).catch((error) => error);
  assert.equal(blocked.code, 'rights_plan_reconcile_required');
  assert.deepEqual(blocked.details.plan_ids, [old.plan_id], 'what blocks the send is exactly what discovery lists');
  // Reconciled against its own saved transaction: the nonce is unused, so the wallet's word releases it.
  assert.equal((await service.getPlan(h.token, old.plan_id)).status, 'broadcast_prepared');
  assert.equal((await service.releasePlan(h.token, old.plan_id)).status, 'released');
  assert.equal((await service.checkpointPlan(h.token, fresh.plan_id)).status, 'broadcast_prepared');
  assert.deepEqual((await service.listPendingPlans(h.token)).plans.map((plan) => [plan.plan_id, plan.current_instance]), [[fresh.plan_id, true]]);
  // A service configured for another network refuses to reconcile it: that chain's nonces say nothing about this plan.
  const elsewhere = new RightsService({ directory: h.directory, env: h.env, chain: { ...moved, chainId: '31337' }, getMode: () => 'live', getGeneration: () => 1 });
  await assert.rejects(elsewhere.getPlan(h.token, fresh.plan_id), { code: 'rights_plan_other_network' });
  await assert.rejects(elsewhere.releasePlan(h.token, fresh.plan_id), { code: 'rights_plan_other_network' });
});
