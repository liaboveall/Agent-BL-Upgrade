// Assessment 2026-11-05 F01: one finality rule for every receipt. A failed (status 0) receipt used to end a role plan at
// once, so it stopped blocking the wallet and left the recovery list while the same signed transaction could still read
// differently on another branch. Now a failed receipt is `confirming` (receipt_status 0) until it is as deep as a
// successful one, and only then `reverted`. The real RightsChainService.verifyTransaction runs here against a provider
// model; the same sequence on a real local EVM is in tests/rightsRecovery.integration.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { RightsChainService } from '../src/rights/chain.js';
import { RightsService } from '../src/rights/service.js';
import { SUCCESSOR_BLOCKS, confirmationsFor, hasSuccessors, successorBlocks } from '../src/chain/finality.js';
import { controlledCapitalConfig } from '../src/app/controlledRoutes.js';

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const POOL = `0x${'22'.repeat(20)}`, CONTROLLER = `0x${'33'.repeat(20)}`, TARGET = `0x${'44'.repeat(20)}`;

test('the finality policy is one rule: two successor blocks on a public chain, none on the local chain, and unreadable ids wait', () => {
  assert.equal(SUCCESSOR_BLOCKS, 2);
  assert.deepEqual([1439, '1439', 1439n, 31337, '31337', 31337n].map(successorBlocks), [2, 2, 2, 0, 0, 0]);
  assert.deepEqual([undefined, null, 'not a chain', {}].map(successorBlocks), [2, 2, 2, 2], 'a chain that cannot be read gets the longer wait');
  assert.deepEqual([1439, 31337].map(confirmationsFor), [3, 1], 'the capital ledger counts the receipt\'s own block as the first confirmation');
  assert.equal(hasSuccessors(102, 100, 2), true);
  assert.equal(hasSuccessors(101, 100, 2), false);
  assert.equal(hasSuccessors(100, 100, 0), true);
  // The capital ledger is configured from the same rule, so a role plan and a subscription decide at the same depth.
  for (const chainId of [1439, 31337]) {
    const config = controlledCapitalConfig({ chain_id: chainId, control_version: 4, contracts: { RWAOfferingPoolV5: POOL, ControlledRWAToken: TARGET }, deployment_block: 1 });
    assert.equal(config.confirmations - 1, successorBlocks(chainId), `chain ${chainId}`);
  }
});

/** A provider that answers what verifyTransaction reads about one broadcast transaction; `world` is edited between calls. */
function worldFixture(chainId = 1439) {
  const plan = { from: `0x${'aa'.repeat(20)}`, to: TARGET, calldata: '0x1234', nonce: 5, chain_id: String(chainId) };
  const world = { latest: 100, receipt: null, tx: { from: plan.from, to: plan.to, data: plan.calldata, value: 0n, nonce: plan.nonce, chainId }, blocks: new Map() };
  const provider = {
    getTransaction: async () => world.tx,
    getTransactionReceipt: async () => world.receipt,
    getBlock: async (number) => world.blocks.get(number) ?? { hash: world.receipt?.blockHash },
    getBlockNumber: async () => world.latest
  };
  const chain = new RightsChainService({ provider, controller: {}, registry: {}, pool: {}, token: {}, governance: {}, artifacts: {}, chainId });
  chain.verify = async () => ({ chain_id: String(chainId), pool: POOL, controller: CONTROLLER });
  const mined = (status, block = 100, blockHash = hash(block)) => { world.receipt = { status, blockNumber: block, blockHash }; };
  return { chain, plan, world, mined, check: (extra = {}) => chain.verifyTransaction({ ...plan, ...extra }, hash(0xabc)) };
}

test('F01 a failed receipt is judged by the same depth as a successful one', async () => {
  for (const [status, expected] of [[1, ['confirming', 'confirming', 'confirmed']], [0, ['confirming', 'confirming', 'reverted']]]) {
    const f = worldFixture(); f.mined(status);
    const seen = [];
    for (const latest of [100, 101, 102]) { f.world.latest = latest; const view = await f.check(); seen.push(view.status); assert.equal(view.receipt_status, status); assert.equal(view.block_number, 100); }
    assert.deepEqual(seen, expected, `receipt status ${status} at 0, 1 and 2 successors`);
  }
});

test('F01 the local chain decides at once for both outcomes, since nothing there can be replaced', async () => {
  for (const [status, expected] of [[1, 'confirmed'], [0, 'reverted']]) {
    const f = worldFixture(31337); f.mined(status);
    assert.equal((await f.check()).status, expected);
  }
});

test('F01 a receipt that disappears or changes block is reconciled, never read as final, and never keeps its old reading', async () => {
  const f = worldFixture(); f.mined(0); f.world.latest = 102;
  assert.equal((await f.check()).status, 'reverted');
  // The block was replaced: no receipt any more. A plan that already knew its block reconciles; a fresh one is pending.
  f.world.receipt = null;
  assert.deepEqual(pick(await f.check({ block_hash: hash(100) })), ['reconciling', null]);
  assert.deepEqual(pick(await f.check()), ['pending', null]);
  // The same signed bytes now succeed in another block: the earlier failed reading must not carry over.
  f.mined(1, 101, hash(0x101)); f.world.latest = 101;
  assert.deepEqual(pick(await f.check({ block_hash: hash(100) })), ['confirming', 1]);
  f.world.latest = 103;
  assert.deepEqual(pick(await f.check({ block_hash: hash(100) })), ['confirmed', 1]);
  // A receipt whose block is no longer the canonical one it names is reconciled too.
  f.world.blocks.set(101, { hash: hash(0x999) });
  assert.deepEqual(pick(await f.check()), ['reconciling', null]);
  // The transaction itself vanished (mempool eviction after a reorganisation) while the plan holds its hash.
  f.world.tx = null;
  assert.deepEqual(pick(await f.check({ tx_hash: hash(0xabc) })), ['reconciling', null]);
});
const pick = (view) => [view.status, view.receipt_status];

/** The server side: a RightsService over the real verifyTransaction, with nonce arithmetic modelled around it. */
async function serviceFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rights-finality-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = worldFixture(), env = { AGENTBL_RIGHTS_KEY: randomBytes(32).toString('hex') };
  const signer = Wallet.createRandom();
  f.plan.from = signer.address; f.world.tx.from = signer.address;
  const account = { nonce: 0 };
  // A transaction the wallet sent is bound to the plan's own calldata; the model only needs the nonce the next plan takes.
  f.chain.prepare = async (principal, input) => ({ chain_id: '1439', pool: POOL, controller: CONTROLLER, from: principal.wallet, to: TARGET,
    calldata: `0x${Buffer.from(input.operation + (input.evidence_hash ?? '')).toString('hex')}`, nonce: account.nonce, prepared_block: f.world.latest, operation: input.operation });
  const make = () => new RightsService({ directory, env, chain: f.chain, getMode: () => 'live', getGeneration: () => 1 });
  const service = make(), subject = await service.createSubject({ organization: 'f01-finality', roles: ['compliance'], wallet: signer.address });
  const signIn = async (rights = service) => {
    const challenge = await rights.createChallenge(subject.subject_id);
    return (await rights.openSession({ challenge_id: challenge.challenge_id, signature: await signer.signTypedData(challenge.domain, challenge.types, challenge.message) })).token;
  };
  const input = (n) => ({ operation: 'refresh_screening', valid_until: '1900000000', evidence_hash: hash(n) });
  /** The wallet broadcast `plan`; it was mined at `block` with `status`, and the account's next nonce moved on. */
  const mine = (plan, status, block = 100) => {
    f.world.tx = { from: signer.address, to: plan.to, data: plan.calldata, value: 0n, nonce: plan.nonce, chainId: 1439 };
    f.mined(status, block); f.world.latest = block; account.nonce = plan.nonce + 1;
  };
  return { ...f, service, make, signIn, input, mine, token: await signIn(), account };
}

test('F01 a shallow failed receipt keeps the plan listed and the wallet blocked until it is deep; then the retry may go', async (t) => {
  const h = await serviceFixture(t);
  const first = await h.service.prepareTransaction(h.token, h.input(1));
  await h.service.checkpointPlan(h.token, first.plan_id);
  h.mine(first, 0);
  const attached = await h.service.attachTransaction(h.token, first.plan_id, hash(0xabc));
  assert.deepEqual([attached.status, attached.receipt_status], ['confirming', 0], 'failed, but not yet final');
  // The failure is not hidden: the plan is still discoverable (also after a restart) and says what the receipt says.
  const listed = (rights, token) => rights.listPendingPlans(token).then((value) => value.plans.map((plan) => [plan.plan_id, plan.status, plan.receipt_status]));
  assert.deepEqual(await listed(h.service, h.token), [[first.plan_id, 'confirming', 0]]);
  // A retry prepared on the next nonce cannot pass the checkpoint beside it.
  const retry = await h.service.prepareTransaction(h.token, h.input(2));
  assert.equal(retry.nonce, first.nonce + 1);
  await assert.rejects(h.service.checkpointPlan(h.token, retry.plan_id), (error) => error.code === 'rights_plan_reconcile_required' && error.details.plan_ids.includes(first.plan_id));
  // One successor: still shallow, still blocked, also for a restarted service in a new session that reads everything back
  // (a plan prepared in another session has to be prepared again, so the retry is prepared afresh).
  h.world.latest = 101;
  const restarted = h.make(), again = await h.signIn(restarted), retryAgain = await restarted.prepareTransaction(again, h.input(3));
  assert.equal((await restarted.getPlan(again, first.plan_id)).status, 'confirming');
  assert.deepEqual(await listed(restarted, again), [[first.plan_id, 'confirming', 0]]);
  await assert.rejects(restarted.checkpointPlan(again, retryAgain.plan_id), { code: 'rights_plan_reconcile_required' });
  // Two successors: the failure is final, the plan leaves the list and the retry goes through.
  h.world.latest = 102;
  assert.equal((await restarted.getPlan(again, first.plan_id)).status, 'reverted');
  assert.deepEqual(await listed(restarted, again), []);
  assert.equal((await restarted.checkpointPlan(again, retryAgain.plan_id)).status, 'broadcast_prepared');
});

test('F01 a failed receipt that vanishes in a reorganisation never frees the wallet, and the original may then succeed', async (t) => {
  const h = await serviceFixture(t);
  const first = await h.service.prepareTransaction(h.token, h.input(1));
  await h.service.checkpointPlan(h.token, first.plan_id);
  h.mine(first, 0);
  assert.equal((await h.service.attachTransaction(h.token, first.plan_id, hash(0xabc))).status, 'confirming');
  const retry = await h.service.prepareTransaction(h.token, h.input(2));
  await assert.rejects(h.service.checkpointPlan(h.token, retry.plan_id), { code: 'rights_plan_reconcile_required' });
  // The block is replaced: the receipt is gone, so the plan is reconciled rather than settled, and still blocks.
  h.world.receipt = null; h.world.latest = 101;
  const reconciling = await h.service.getPlan(h.token, first.plan_id);
  assert.deepEqual([reconciling.status, reconciling.receipt_status], ['reconciling', null]);
  await assert.rejects(h.service.checkpointPlan(h.token, retry.plan_id), { code: 'rights_plan_reconcile_required' });
  // On the new branch the same signed transaction succeeds. The plan follows it, and the retry never left while that was open.
  h.mined(1, 101, hash(0x2101)); h.world.latest = 103;
  const settled = await h.service.getPlan(h.token, first.plan_id);
  assert.deepEqual([settled.status, settled.receipt_status, settled.block_hash], ['confirmed', 1, hash(0x2101)]);
  assert.equal(settled.receipt_history.length, 1, 'the earlier block is kept as history');
  // Only now is the wallet free again, and the person who sees the original succeeded decides whether another is wanted.
  assert.equal((await h.service.checkpointPlan(h.token, retry.plan_id)).status, 'broadcast_prepared');
});

test('F01 a failure that was final and is later seen to succeed is corrected on the next look', async (t) => {
  const h = await serviceFixture(t);
  const first = await h.service.prepareTransaction(h.token, h.input(1));
  await h.service.checkpointPlan(h.token, first.plan_id);
  h.mine(first, 0); h.world.latest = 102;
  assert.equal((await h.service.attachTransaction(h.token, first.plan_id, hash(0xabc))).status, 'reverted');
  assert.deepEqual((await h.service.listPendingPlans(h.token)).plans, []);
  h.mined(1, 101, hash(0x3101)); h.world.latest = 104;
  const corrected = await h.service.getPlan(h.token, first.plan_id);
  assert.deepEqual([corrected.status, corrected.receipt_status], ['confirmed', 1]);
});
