import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Interface, keccak256, toUtf8Bytes } from 'ethers';
import { APPROVAL_STATUS, ApprovalError, ApprovalQueue } from '../src/agent/runtime/approvals.js';
import { OwnerPlanError, buildOwnerPlan, verifyOwnerTx } from '../src/agent/runtime/ownerTxPlan.js';

const registry = JSON.parse(await fs.readFile(new URL('../public/chain-config.json', import.meta.url), 'utf8'));
const chainConfig = registry.networks['injective-testnet'];
const poolIface = new Interface(chainConfig.abis.RWAOfferingPool);
const POOL = chainConfig.contracts.RWAOfferingPool;
const OWNER = '0x1111111111111111111111111111111111111111';
const TX = `0x${'cd'.repeat(32)}`;

// ---------------- ApprovalQueue ----------------

function clock(start = '2026-10-12T12:00:00Z') {
  let current = Date.parse(start);
  return { now: () => new Date(current), advance: (ms) => { current += ms; } };
}
const input = (extra = {}) => ({ decision_id: 'decision_a', route: 'server', case_id: 'C1', pool_id: 'P1', action: 'PAUSE', mode: 'live', ...extra });

test('approvals: create is idempotent per open decision and rejects bad input', async () => {
  const queue = new ApprovalQueue({ now: clock().now });
  const first = await queue.create(input());
  const again = await queue.create(input());
  assert.equal(again.approval_id, first.approval_id);
  assert.equal(first.status, 'PENDING');
  assert.match(first.approval_id, /^appr_[0-9a-f]{16}$/u);
  assert.equal(queue.pendingCount(), 1);
  assert.notEqual((await queue.create(input({ decision_id: 'decision_b' }))).approval_id, first.approval_id);
  await assert.rejects(queue.create(input({ route: 'magic' })), /route/u);
  await assert.rejects(queue.create(input({ decision_id: undefined })), /decision_id/u);
});

test('approvals: approve and reject follow the state machine', async () => {
  const queue = new ApprovalQueue({ now: clock().now });
  const a = await queue.create(input());
  const approved = await queue.approve(a.approval_id, { by: 'admin', note: 'ok' });
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.decided_by, 'admin');
  assert.ok(approved.decided_at);
  await assert.rejects(queue.approve(a.approval_id), (error) => error instanceof ApprovalError && error.code === 'invalid_transition');
  await assert.rejects(queue.reject(a.approval_id), { code: 'invalid_transition' });

  const b = await queue.create(input({ decision_id: 'decision_b' }));
  const rejected = await queue.reject(b.approval_id, { by: 'admin', note: 'no' });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.note, 'no');
  await assert.rejects(queue.approve(b.approval_id), { code: 'invalid_transition' });
  await assert.rejects(queue.approve('appr_missing'), (error) => error.code === 'approval_not_found' && error.status === 404);

  // After a terminal state a new proposal for the same decision opens a fresh approval.
  const c = await queue.create(input({ decision_id: 'decision_b' }));
  assert.notEqual(c.approval_id, b.approval_id);
});

test('approvals: a pending approval expires after its ttl and can no longer be approved', async () => {
  const time = clock();
  const queue = new ApprovalQueue({ now: time.now, ttlSec: 60 });
  const a = await queue.create(input());
  time.advance(61_000);
  await assert.rejects(queue.approve(a.approval_id), { code: 'approval_expired' });
  assert.equal(queue.get(a.approval_id).status, 'EXPIRED');
  assert.equal(queue.pendingCount(), 0);
  const fresh = await queue.create(input({ ttlSec: 10 }));
  time.advance(11_000);
  const expired = await queue.expireStale();
  assert.deepEqual(expired.map((r) => r.approval_id), [fresh.approval_id]);
});

test('approvals: owner-signed steps are recorded in order and complete the approval', async () => {
  const queue = new ApprovalQueue({ now: clock().now });
  const plan = { steps: [{ index: 0 }, { index: 1 }] };
  const a = await queue.create(input({ route: 'owner_cli', plan }));
  await assert.rejects(queue.recordStep(a.approval_id, { index: 0, tx_hash: TX }), { code: 'invalid_transition' }, 'not approved yet');
  await queue.approve(a.approval_id);
  await queue.markAwaitingOwner(a.approval_id);
  await assert.rejects(queue.recordStep(a.approval_id, { index: 1, tx_hash: TX }), { code: 'step_out_of_order' });
  const first = await queue.recordStep(a.approval_id, { index: 0, tx_hash: TX });
  assert.equal(first.complete, false);
  await assert.rejects(queue.recordStep(a.approval_id, { index: 0, tx_hash: TX }), { code: 'step_already_recorded' });
  const second = await queue.recordStep(a.approval_id, { index: 1, tx_hash: TX });
  assert.equal(second.complete, true);
  const done = await queue.markExecuted(a.approval_id, { tx_hashes: [TX, TX] });
  assert.equal(done.status, 'EXECUTED');
  await assert.rejects(queue.markFailed(a.approval_id, 'late'), { code: 'invalid_transition' });
});

test('approvals: failures keep a bounded reason; an approval awaiting a signature can expire', async () => {
  const time = clock();
  const queue = new ApprovalQueue({ now: time.now, ttlSec: 30 });
  const a = await queue.create(input({ route: 'owner_cli', plan: { steps: [{ index: 0 }] } }));
  await queue.approve(a.approval_id);
  await queue.markAwaitingOwner(a.approval_id);
  time.advance(31_000);
  assert.equal((await queue.expireStale()).length, 1);
  assert.equal(queue.get(a.approval_id).status, 'EXPIRED');

  const b = await queue.create(input({ decision_id: 'decision_f' }));
  await queue.approve(b.approval_id);
  const failed = await queue.markFailed(b.approval_id, Object.assign(new Error('x'.repeat(2000)), { code: 'would_revert' }));
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error.code, 'would_revert');
  assert.equal(failed.error.message.length, 500);
});

test('approvals: state survives a restart and the record cap never drops open approvals', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-appr-'));
  const file = path.join(dir, 'agent-approvals.json');
  const queue = new ApprovalQueue({ file, now: clock().now, maxRecords: 3 });
  const open = await queue.create(input({ decision_id: 'keep-open' }));
  for (let i = 0; i < 5; i += 1) {
    const done = await queue.create(input({ decision_id: `done-${i}` }));
    await queue.reject(done.approval_id);
  }
  assert.ok(queue.records.size <= 3 || [...queue.records.values()].every((r) => r.status !== 'REJECTED'));
  const reloaded = await new ApprovalQueue({ file, now: clock().now }).init();
  assert.equal(reloaded.get(open.approval_id).status, 'PENDING');
  assert.equal(reloaded.list({ status: 'PENDING' }).length, 1);
  assert.ok(reloaded.list({ decision_id: 'keep-open' })[0]);
  assert.equal(reloaded.list({ case_id: 'nope' }).length, 0);
  assert.deepEqual(Object.keys(APPROVAL_STATUS).length, 7);
});

// ---------------- owner plan ----------------

test('owner plan: departure and cancellation encode exact proofs; settlement refuses context-free legacy plans', async () => {
  const proof = keccak256(toUtf8Bytes('dep-1'));
  const mark = await buildOwnerPlan({ action: 'MARK_IN_TRANSIT', chain_pool_id: 5, params: { departure_proof: 'dep-1' }, chainConfig });
  assert.equal(mark.network, 'injective_testnet');
  assert.equal(mark.chain_id, 1439);
  assert.deepEqual(mark.steps, [{
    index: 0, contract: 'RWAOfferingPool', address: POOL, method: 'markInTransit', args: ['5', proof],
    description: mark.steps[0].description, expected_events: ['DepartureRecorded']
  }]);

  for (const action of ['RECORD_PAYMENT', 'RECORD_ARRIVAL', 'SETTLE']) {
    await assert.rejects(buildOwnerPlan({ action, chain_pool_id: 5, params: { payment_proof: 'pay-1', repayment_amount: 7 }, chainConfig }), { code: 'chain_unavailable' });
  }
  const cancel = await buildOwnerPlan({ action: 'CANCEL', chain_pool_id: 5, chainConfig });
  assert.equal(cancel.steps[0].method, 'cancelOffering');
});

test('owner plan: refuses what it cannot encode instead of guessing', async () => {
  await assert.rejects(buildOwnerPlan({ action: 'REPRICE', chain_pool_id: 1, chainConfig }), (e) => e instanceof OwnerPlanError && e.code === 'unsupported_action');
  await assert.rejects(buildOwnerPlan({ action: 'SETTLE', chain_pool_id: 0, params: { repayment_amount: 1 }, chainConfig }), { code: 'no_chain_pool' });
  await assert.rejects(buildOwnerPlan({ action: 'SETTLE', chain_pool_id: 1, params: { repayment_amount: 1 }, chainConfig: { ...chainConfig, contracts: {} } }), { code: 'contract_missing' });
  await assert.rejects(buildOwnerPlan({ action: 'MARK_IN_TRANSIT', chain_pool_id: 1, params: {}, chainConfig }), { code: 'proof_required' });
  await assert.rejects(buildOwnerPlan({ action: 'SETTLE', chain_pool_id: 1, params: { repayment_amount: 1.5 }, chainConfig }));
});

// ---------------- verifyOwnerTx ----------------

async function plannedStep() {
  const plan = await buildOwnerPlan({ action: 'MARK_IN_TRANSIT', chain_pool_id: 5, params: { departure_proof: 'dep-1' }, chainConfig });
  return plan.steps[0];
}

function chainFor(step, overrides = {}) {
  const proof = step.args[1];
  const data = overrides.data ?? poolIface.encodeFunctionData(step.method, step.args);
  const event = poolIface.getEvent('DepartureRecorded');
  const encoded = poolIface.encodeEventLog(event, [5, proof]);
  const logs = overrides.logs ?? [{ address: POOL, topics: encoded.topics, data: encoded.data }];
  const tx = overrides.tx === null ? null : { to: POOL, from: OWNER, data, value: 0n, ...overrides.tx };
  const receipt = overrides.receipt === null ? null : { status: 1, blockNumber: 777, logs, ...overrides.receipt };
  return {
    getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt
  };
}

test('verifyOwnerTx: accepts exactly the planned transaction and reports the confirmed events', async () => {
  const step = await plannedStep();
  const result = await verifyOwnerTx({ step, txHash: TX, provider: chainFor(step), iface: poolIface, allowedSenders: [OWNER] });
  assert.deepEqual(result, { ok: true, errors: [], block_number: 777, from: OWNER, confirmed_events: ['DepartureRecorded'] });
});

test('verifyOwnerTx: refuses a made-up hash, an unmined tx and a malformed hash', async () => {
  const step = await plannedStep();
  const missing = await verifyOwnerTx({ step, txHash: TX, provider: chainFor(step, { tx: null }), iface: poolIface });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /not found/u);
  const noReceipt = await verifyOwnerTx({ step, txHash: TX, provider: chainFor(step, { receipt: null }), iface: poolIface });
  assert.match(noReceipt.errors[0], /no receipt/u);
  const bad = await verifyOwnerTx({ step, txHash: '0x1234', provider: chainFor(step), iface: poolIface });
  assert.match(bad.errors[0], /32-byte/u);
});

test('verifyOwnerTx: wrong contract, method, argument, sender, revert or missing event each fail', async () => {
  const step = await plannedStep();
  const check = async (overrides, pattern, extra = {}) => {
    const result = await verifyOwnerTx({ step, txHash: TX, provider: chainFor(step, overrides), iface: poolIface, ...extra });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => pattern.test(e)), `${pattern} not in ${result.errors}`);
  };
  await check({ tx: { to: '0x2222222222222222222222222222222222222222' } }, /targets/u);
  await check({ data: poolIface.encodeFunctionData('recordCargoArrival', [5, step.args[1]]) }, /method is recordCargoArrival/u);
  await check({ data: poolIface.encodeFunctionData('markInTransit', [6, step.args[1]]) }, /argument 0 is 6, expected 5/u);
  await check({ data: poolIface.encodeFunctionData('markInTransit', [5, keccak256(toUtf8Bytes('other'))]) }, /argument 1/u);
  await check({ data: '0xdeadbeef' }, /does not decode/u);
  await check({ receipt: { status: 0 } }, /reverted/u);
  await check({ logs: [] }, /DepartureRecorded is missing/u);
  await check({}, /not an authorised signer/u, { allowedSenders: ['0x3333333333333333333333333333333333333333'] });
});

test('verifyOwnerTx: a log from another contract does not satisfy the expected event', async () => {
  const step = await plannedStep();
  const event = poolIface.getEvent('DepartureRecorded');
  const encoded = poolIface.encodeEventLog(event, [5, step.args[1]]);
  const foreign = [{ address: '0x4444444444444444444444444444444444444444', topics: encoded.topics, data: encoded.data }];
  const result = await verifyOwnerTx({ step, txHash: TX, provider: chainFor(step, { logs: foreign }), iface: poolIface });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /DepartureRecorded is missing/u.test(e)));
});
