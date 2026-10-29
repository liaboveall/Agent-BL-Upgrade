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
  const signIn = async () => {
    const challenge = await service.createChallenge(subject.subject_id);
    return (await service.openSession({ challenge_id: challenge.challenge_id, signature: await signer.signTypedData(challenge.domain, challenge.types, challenge.message) })).token;
  };
  const token = await signIn();
  const input = (n = 1) => ({ operation: 'refresh_screening', valid_until: '1900000000', evidence_hash: hash(n) });
  return { chain, service, token, signIn, input, directory, env };
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
