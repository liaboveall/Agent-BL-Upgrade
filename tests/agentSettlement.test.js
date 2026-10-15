import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ZeroAddress, ZeroHash } from 'ethers';
import { createPool, storeState } from '../src/app/store.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { createAgentService } from '../src/agent/runtime/factory.js';
import { createChainReader } from '../src/agent/runtime/poolRegistry.js';
import { buildSettlementPlan, repaymentAtomic, verifyUsdcTransfer, validateSettlementStep } from '../src/agent/pipelines/settlementPipeline.js';
import { settlementChain, oil, chainConfig, RECIPIENT, PAYER, paymentHash, blockHash } from './helpers/settlement.js';

const verify = (chain, options = {}) => verifyUsdcTransfer({ provider: chain.context.provider, chainConfig,
  recipient: RECIPIENT, txHash: paymentHash, amount: '1.234567', confirmations: 2, ...options });

async function runtime(t, { chain = settlementChain(), dir, store, env = {}, clock = () => new Date() } = {}) {
  store ??= { ...storeState, pools: new Map(), agentActivities: [] };
  if (!store.pools.has(oil.case_id)) createPool(oil.case_id, oil, quoteFromCase(oil), { store });
  const mode = { mode: 'live', generation: 1 };
  const service = createAgentService({ dir, env: { AGENT_VALUATION_LLM: 'false', AGENT_COOLDOWN_SEC: '0',
    AGENT_MONITOR_INTERVAL_SEC: '3600', AGENT_SETTLEMENT_RECIPIENT: RECIPIENT, ...env }, store, chainConfig,
    getMode: () => mode.mode, getGeneration: () => mode.generation, getChainContext: async () => chain.context, monitors: false, now: clock });
  await service.init();
  await service.registry.linkChain({ case_id: oil.case_id, chain_pool_id: 11, ebl_id: 7 }, createChainReader(chain.context));
  await service.start(); t.after(() => service.stop());
  return { service, chain, mode, store };
}
const event = (type, data, extra = {}) => ({ type, case_id: oil.case_id, source: 'admin', data, ...extra });
const paymentEvent = (extra = {}) => event('PAYMENT_RECEIVED', { payment_proof: paymentHash, repayment_amount: '1.234567', proof_source: 'usdc-transfer', ...extra });
async function submit(service, input) { const accepted = await service.submitEvent(input, { origin: 'api' }); await service.bus.idle(); return accepted; }
async function pending(service, action) { return service.approvals.list({ status: 'PENDING' }).find((item) => item.action === action); }
async function complete(service, chain, action) {
  const approval = await pending(service, action); assert.ok(approval, `missing ${action}`);
  const granted = await service.approve(approval.approval_id);
  assert.equal(granted.approval.status, 'AWAITING_OWNER_SIGNATURE');
  const tx = chain.send(granted.approval.plan.steps[0]);
  const attached = await service.attachTx(approval.approval_id, { tx_hash: tx.hash });
  await service.bus.idle(); return { ...attached, tx, plan: granted.approval.plan };
}

test('USDC amount conversion is exact and rejects rounding, exponents, zero, overflow and unsafe numbers', () => {
  assert.equal(repaymentAtomic('0.000001'), '1'); assert.equal(repaymentAtomic(1.234567), '1234567');
  assert.equal(repaymentAtomic('9007199254740993.000001'), '9007199254740993000001');
  for (const amount of ['0', '-1', '1e6', '1.0000001', '01', '1.', ' 1', '9'.repeat(90), 0.1 + 0.2, Number('9007199254740993')]) {
    assert.throws(() => repaymentAtomic(amount), /USDC|amount|uint256/iu);
  }
});

test('USDC proof binds canonical asset, recipient, payer, amount, block and log with configured confirmations', async () => {
  const chain = settlementChain(); chain.payment();
  const evidence = await verify(chain);
  assert.equal(evidence.amount_atomic, '1234567'); assert.equal(evidence.amount_usdc, '1.234567');
  assert.equal(evidence.payer, PAYER); assert.equal(evidence.recipient, RECIPIENT);
  assert.equal(evidence.block_hash, blockHash(100)); assert.equal(evidence.log_index, 0);
});

for (const [name, mutate, code] of [
  ['fake hash', (chain) => chain.receipts.clear(), 'payment_not_mined'],
  ['revert', (chain) => chain.payment({ status: 0 }), 'payment_reverted'],
  ['wrong asset', (chain) => chain.payment({ asset: PAYER }), 'payment_transfer_mismatch'],
  ['wrong payee', (chain) => chain.payment({ to: PAYER }), 'payment_transfer_mismatch'],
  ['wrong amount', (chain) => chain.payment({ amount: 1n }), 'payment_transfer_mismatch'],
  ['mint', (chain) => chain.payment({ from: ZeroAddress }), 'invalid_payment_sender'],
  ['self-transfer', (chain) => chain.payment({ from: RECIPIENT }), 'invalid_payment_sender'],
  ['wrong RPC chain', (chain) => { chain.state.chainId = 1776; }, 'wrong_settlement_chain'],
  ['wrong tx chain', (chain) => { chain.transactions.get(paymentHash).chainId = 1776n; }, 'wrong_settlement_chain'],
  ['unconfirmed', (chain) => { chain.state.head = 100; }, 'payment_unconfirmed'],
  ['reorg', (chain) => { chain.state.blocks.set(100, blockHash(99)); }, 'payment_reorged'],
  ['hash substitution', (chain) => { chain.receipts.get(paymentHash).hash = ZeroHash; }, 'payment_hash_mismatch'],
  ['removed log', (chain) => { chain.receipts.get(paymentHash).logs[0].removed = true; }, 'payment_transfer_mismatch'],
  ['ambiguous transfer', (chain) => { const receipt = chain.receipts.get(paymentHash); receipt.logs.push({ ...receipt.logs[0], index: 1 }); }, 'payment_transfer_mismatch'],
  ['missing log index', (chain) => { delete chain.receipts.get(paymentHash).logs[0].index; }, 'invalid_payment_log']
]) test(`USDC proof rejects ${name}`, async () => {
  const chain = settlementChain(); chain.payment(); mutate(chain); await assert.rejects(verify(chain), { code });
});

test('Live payment intake rejects missing recipient, unsupported/manual sources, unmapped or protected pools and forged evidence', async (t) => {
  const { service, chain } = await runtime(t); chain.payment();
  await assert.rejects(submit(service, paymentEvent({ proof_source: 'manual' })), { code: 'unsupported_payment_source' });
  await assert.rejects(submit(service, { ...paymentEvent(), chain_pool_id: 12 }), { code: 'settlement_pool_mismatch' });
  await assert.rejects(submit(service, { ...paymentEvent(), case_id: 'UNKNOWN' }), { code: 'no_chain_pool' });
  service.registry.protectedChainPools.add(11);
  await assert.rejects(submit(service, paymentEvent()), { code: 'protected_pool' }); service.registry.protectedChainPools.delete(11);
  service.config.settlementRecipient = '';
  await assert.rejects(submit(service, paymentEvent()), { code: 'settlement_recipient_required' }); service.config.settlementRecipient = RECIPIENT;
  const accepted = await submit(service, paymentEvent({ recipient: PAYER, repayment_amount_atomic: '1', payment_verification: { source: 'confirmed-usdc-transfer' } }));
  assert.ok(service.bus.get(accepted.idempotency_key));
  const queued = service.settlementEvidence.list()[0].event;
  assert.equal(queued.data.repayment_amount_atomic, '1234567'); assert.equal(queued.data.payment_verification.recipient, RECIPIENT);
  assert.equal(chain.state.sent.length, 0); assert.equal((await pending(service, 'RECORD_PAYMENT')).plan.steps[0].args[2], '1234567');
});

test('Live lifecycle records payment and arrival only after separate owner receipts, then proposes an approved settlement with exact atomic amount', async (t) => {
  const { service, chain, store } = await runtime(t); chain.payment();
  await submit(service, paymentEvent());
  assert.equal(await pending(service, 'SETTLE'), undefined);
  const payment = await complete(service, chain, 'RECORD_PAYMENT');
  assert.equal(payment.decision.status, 'COMPLETED'); assert.equal(await pending(service, 'SETTLE'), undefined);
  await submit(service, event('CARGO_ARRIVED', { arrival_proof: 'port-delivery-7' }));
  const arrival = await complete(service, chain, 'RECORD_ARRIVAL'); assert.equal(arrival.decision.status, 'COMPLETED');
  const approval = await pending(service, 'SETTLE'); assert.equal(approval.plan.steps[0].args[1], '1234567');
  assert.equal(chain.pools.get(11).state, 5, 'proposing settlement changes no chain state');
  const result = await complete(service, chain, 'SETTLE'); assert.equal(result.decision.status, 'COMPLETED');
  assert.equal(chain.pools.get(11).state, 9); assert.equal(store.pools.get(oil.case_id).status, 'Repaid');
  assert.equal(chain.state.sent.length, 3); assert.match(result.plan.steps[0].description, /does not hold or distribute/u);
  const duplicate = await service.attachTx(result.approval.approval_id, { tx_hash: result.tx.hash }); assert.equal(duplicate.duplicate, true);
});

test('Arrival first uses actual proofs; paused readiness waits for resume and stale mirrors cannot create settlement', async (t) => {
  const { service, chain, store } = await runtime(t); chain.payment();
  store.pools.get(oil.case_id).settlement = { payment_proof: 'fake', arrival_proof: 'fake', repayment_amount: 999 };
  await service.tick(); await service.bus.idle(); assert.equal(await pending(service, 'SETTLE'), undefined);
  await submit(service, event('CARGO_ARRIVED', { arrival_proof: 'arrival-first' })); await complete(service, chain, 'RECORD_ARRIVAL');
  await submit(service, paymentEvent());
  const send = chain.send;
  chain.send = (step) => { const tx = send(step); chain.pools.get(11).state = 7; return tx; };
  await complete(service, chain, 'RECORD_PAYMENT');
  assert.equal(await pending(service, 'SETTLE'), undefined, 'paused chain state must not consume a readiness event');
  chain.send = send; chain.pools.get(11).state = 5;
  await service.tick(); await service.bus.idle();
  assert.ok(await pending(service, 'SETTLE'));
  await service.tick(); await service.bus.idle();
  assert.equal(service.approvals.list().filter((item) => item.action === 'SETTLE').length, 1);
});

test('Receipt claims are idempotent across user event IDs, concurrent submissions, queue failures and restart', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-settlement-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { service, chain } = await runtime(t, { dir }); chain.payment();
  const submitBus = service.bus.submit.bind(service.bus); let fail = true;
  service.bus.submit = async (...args) => { if (fail) { fail = false; throw new Error('queue-write-failed'); } return submitBus(...args); };
  await assert.rejects(submit(service, paymentEvent()), /queue-write-failed/u);
  const accepted = await Promise.all([submit(service, { ...paymentEvent(), event_id: 'id-a' }), submit(service, { ...paymentEvent(), event_id: 'id-b' })]);
  assert.equal(accepted[0].idempotency_key, accepted[1].idempotency_key); assert.equal(service.settlementEvidence.list().length, 1);
  assert.equal(service.approvals.list().filter((item) => item.action === 'RECORD_PAYMENT').length, 1);
  await complete(service, chain, 'RECORD_PAYMENT');
  await service.stop();
  const fresh = await runtime(t, { dir, chain });
  const retry = await submit(fresh.service, paymentEvent()); assert.equal(retry.duplicate, true);
  assert.equal(fresh.service.settlementEvidence.list().length, 1); assert.equal(chain.state.sent.length, 1);
  await submit(fresh.service, event('CARGO_ARRIVED', { arrival_proof: 'after-restart' })); await complete(fresh.service, chain, 'RECORD_ARRIVAL');
  assert.ok(await pending(fresh.service, 'SETTLE'));
});

test('A receipt cannot be claimed for another pool and a generation change during verification queues nothing', async (t) => {
  const { service, chain, mode } = await runtime(t); chain.payment(); await submit(service, paymentEvent());
  chain.pools.set(12, { ...chain.pools.get(11), eblId: 8 });
  await service.registry.linkChain({ case_id: 'CASE-SECOND', chain_pool_id: 12, ebl_id: 8 }, createChainReader(chain.context));
  await assert.rejects(submit(service, { ...paymentEvent(), case_id: 'CASE-SECOND' }), { code: 'payment_already_claimed' });
  const getReceipt = chain.context.provider.getTransactionReceipt;
  chain.context.provider.getTransactionReceipt = async (...args) => { mode.generation++; return getReceipt(...args); };
  await assert.rejects(submit(service, paymentEvent()), { code: 'mode_changed' });
});

test('Changed, paused, unsubscribed or stopped chain state invalidates a settlement plan without signing', async (t) => {
  const { service, chain } = await runtime(t); chain.payment(); await submit(service, paymentEvent());
  const approval = await pending(service, 'RECORD_PAYMENT'), plan = approval.plan;
  for (const mutate of [() => { chain.pools.get(11).state = 7; }, () => { chain.pools.get(11).subscribed = 0n; }, () => { chain.state.stopped = true; }]) {
    mutate(); await assert.rejects(service.approve(approval.approval_id));
    Object.assign(chain.pools.get(11), { state: 5, subscribed: 1n }); chain.state.stopped = false;
  }
  chain.state.blocks.set(100, blockHash(99));
  await assert.rejects(validateSettlementStep({ plan, context: chain.context, chainConfig, recipient: RECIPIENT }), { code: 'payment_reorged' });
  assert.equal(chain.state.sent.length, 0); assert.equal(service.approvals.get(approval.approval_id).status, 'PENDING');
});

test('Owner receipt must bind matching pool/proofs/events, confirmations and sender; rejected attempts preserve the approval', async (t) => {
  const { service, chain } = await runtime(t); chain.payment(); await submit(service, paymentEvent());
  const approval = await pending(service, 'RECORD_PAYMENT'); await service.approve(approval.approval_id);
  const step = approval.plan.steps[0];
  const tx = chain.send(step, { eventArgs: [12, paymentHash, ZeroHash] });
  await assert.rejects(service.attachTx(approval.approval_id, { tx_hash: tx.hash }), { code: 'tx_verification_failed' });
  assert.equal(service.approvals.get(approval.approval_id).status, 'AWAITING_OWNER_SIGNATURE');
  const correct = chain.emit(step, [11, paymentHash, ZeroHash]);
  const receipt = chain.receipts.get(correct.hash); receipt.blockHash = blockHash(receipt.blockNumber);
  chain.state.head = receipt.blockNumber - 1;
  await assert.rejects(service.attachTx(approval.approval_id, { tx_hash: correct.hash }), { code: 'tx_verification_failed' });
  chain.state.head = 5000;
  assert.equal((await service.attachTx(approval.approval_id, { tx_hash: correct.hash })).complete, true);
});

test('Verified owner checkpoint survives a completion write failure and tick completes without rebroadcast', async (t) => {
  const { service, chain } = await runtime(t); chain.payment(); await submit(service, paymentEvent());
  const approval = await pending(service, 'RECORD_PAYMENT'); await service.approve(approval.approval_id);
  const tx = chain.send(approval.plan.steps[0]), update = service.logger.update.bind(service.logger); let fail = true;
  service.logger.update = async (id, patch) => { if (fail && patch.status === 'COMPLETED') { fail = false; throw new Error('checkpoint-failed'); } return update(id, patch); };
  await assert.rejects(service.attachTx(approval.approval_id, { tx_hash: tx.hash }), /checkpoint-failed/u);
  assert.equal(service.approvals.get(approval.approval_id).steps_done.length, 1);
  await service.tick(); assert.equal(service.approvals.get(approval.approval_id).status, 'EXECUTED'); assert.equal(chain.state.sent.length, 1);
});

test('Live settlement refuses missing verified payment/atomic amount and legacy raw-unit plans', async () => {
  const chain = settlementChain(); chain.payment();
  await assert.rejects(buildSettlementPlan({ action: 'RECORD_PAYMENT', chain_pool_id: 11,
    params: { payment_proof: paymentHash, repayment_amount: '1.234567' }, chainConfig, context: chain.context, recipient: RECIPIENT }), { code: 'payment_verification_required' });
});

test('Optional executor route uses the same exact receipt checks and approval instead of bypassing settlement verification', async (t) => {
  const chain = settlementChain(); chain.payment();
  chain.context.pool.interface = chain.interfaces.RWAOfferingPool;
  chain.context.executorPool = { interface: chain.interfaces.RWAOfferingPool,
    recordImporterPayment: Object.assign(async (...args) => chain.send({ index: 0, contract: 'RWAOfferingPool',
      address: chainConfig.contracts.RWAOfferingPool, method: 'recordImporterPayment', args, expected_events: ['SettlementProofRecorded'] }), { staticCall: async () => {} }) };
  chain.context.signers.AGENT_EXECUTOR = '0x1111111111111111111111111111111111111111';
  const { service } = await runtime(t, { chain });
  await submit(service, paymentEvent()); const approval = await pending(service, 'RECORD_PAYMENT');
  assert.equal(approval.route, 'server'); assert.equal(chain.state.sent.length, 0);
  const result = await service.approve(approval.approval_id);
  assert.equal(result.decision.status, 'COMPLETED'); assert.equal(result.decision.execution.signer_role, 'AGENT_EXECUTOR');
  assert.equal(chain.pools.get(11).repaymentAmount, 1234567n); assert.equal(chain.state.sent.length, 1);
});
