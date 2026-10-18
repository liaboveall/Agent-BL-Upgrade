import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { X402SettlementService, FacilitatorAdapter, JsonReceiptStore, paymentIdFor } from '../src/x402/settlement.js';
import { syntheticPaymentVerifier } from './helpers/paymentVerifier.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ClientPaymentJournal } from '../src/x402/clientRecovery.js';

const tx = `0x${'ab'.repeat(32)}`, resource = 'https://local.test/report#request=unchanged';
const input = () => {
  const req = { scheme: 'exact', network: 'eip155:1439', asset: `0x${'01'.repeat(20)}`, payTo: `0x${'02'.repeat(20)}`,
    amount: '1000', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } };
  return { resource, paymentRequirements: req, paymentPayload: { x402Version: 2, accepted: req,
    payload: { signature: `0x${'11'.repeat(65)}`, authorization: { from: `0x${'03'.repeat(20)}`, to: req.payTo,
      value: '1000', nonce: `0x${'04'.repeat(32)}`, validAfter: '1', validBefore: '4000000000' } } } };
};
const adapter = (state) => ({ verify: async () => { state.verify++; return { response: { isValid: true }, attempts: 1 }; },
  settle: async () => { state.settle++; if (state.unknown) throw new Error('response lost after actual transfer');
    return { response: { success: true, transaction: tx, payer: input().paymentPayload.payload.authorization.from, network: 'eip155:1439' }, attempts: 1 }; } });

test('W4 fake facilitator success, missing verifier and canonical receipt failure never unlock', async () => {
  const state = { verify: 0, settle: 0 }, bad = { ...syntheticPaymentVerifier, verify: async () => { throw new Error('fake transaction'); } };
  const service = new X402SettlementService({ mode: 'live', adapter: adapter(state), verifier: bad });
  await assert.rejects(service.process(input()));
  const id = paymentIdFor(input().paymentPayload, input().paymentRequirements);
  assert.equal((await service.get(id)).state, 'RECONCILING'); await assert.rejects(service.markUnlocked(id));
  await assert.rejects(service.process(input()), (error) => error.code === 'settlement_reconciliation_required');
  assert.equal(state.settle, 1);
  const unconfigured = new X402SettlementService({ mode: 'live', adapter: adapter(state), verifier: { prepare: async () => { throw new Error('unconfigured'); } } });
  await assert.rejects(unconfigured.process(input())); assert.equal(state.settle, 1);
});

test('W4 nonce identity survives signature changes, rejects changed value/request and concurrent cross-resource replay', async () => {
  const state = { verify: 0, settle: 0 }, service = new X402SettlementService({ mode: 'live', adapter: adapter(state), verifier: syntheticPaymentVerifier });
  const first = input(), changedSignature = structuredClone(first); changedSignature.paymentPayload.payload.signature = `0x${'22'.repeat(65)}`;
  assert.equal(paymentIdFor(first.paymentPayload, first.paymentRequirements), paymentIdFor(changedSignature.paymentPayload, changedSignature.paymentRequirements));
  const pending = service.process(first);
  await assert.rejects(service.process({ ...first, resource: `${resource}other` }), (error) => error.code === 'payment_already_bound');
  await pending; assert.equal((await service.process(changedSignature)).replayed, true); assert.equal(state.settle, 1);
  const value = structuredClone(first); value.paymentPayload.payload.authorization.value = '2000';
  await assert.rejects(service.process(value), (error) => error.code === 'payment_authorization_reused');
});

test('W4 unknown settlement, expired authorization and restart recover read-only without another charge', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'w4-payment-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'receipts.json'), state = { verify: 0, settle: 0, unknown: true };
  const service = new X402SettlementService({ mode: 'live', store: new JsonReceiptStore({ filePath }), adapter: adapter(state), verifier: syntheticPaymentVerifier });
  await assert.rejects(service.process(input())); assert.equal(state.settle, 1);
  const recoveredVerifier = { ...syntheticPaymentVerifier, locate: async () => tx };
  const restarted = new X402SettlementService({ mode: 'live', store: new JsonReceiptStore({ filePath }), adapter: adapter(state), verifier: recoveredVerifier,
    deliveryKey: Buffer.alloc(32, 11),
    clock: () => new Date(4100000000000) });
  const recovered = await restarted.process(input()); assert.equal(recovered.record.state, 'SETTLED'); assert.equal(recovered.replayed, true); assert.equal(state.settle, 1);
  let calls = 0;
  await assert.rejects(restarted.deliver(recovered.record.payment_id, async (_prepared, checkpoint) => { calls++; await checkpoint({ envelope: 'durable-before-attestation' }); throw new Error('report delivery failed'); }));
  const body = await restarted.deliver(recovered.record.payment_id, async (prepared) => { assert.equal(prepared.envelope, 'durable-before-attestation'); return { report: 'paid-content' }; });
  assert.deepEqual(body, { report: 'paid-content' });
  assert.doesNotMatch(await fs.readFile(filePath, 'utf8'), /paid-content|durable-before-attestation/u);
  assert.deepEqual(await restarted.deliver(recovered.record.payment_id, () => { throw new Error('must reuse saved report'); }), body);
  assert.equal(calls, 1); assert.equal(state.settle, 1);
  await fs.rm(filePath);
  await assert.rejects(new X402SettlementService({ mode: 'live', store: new JsonReceiptStore({ filePath }), adapter: adapter(state), verifier: recoveredVerifier }).process(input()), /history is missing/u);
});

test('W4 independently confirmed payment losing its receipt blocks repeat delivery and keeps prior proof', async () => {
  const state = { verify: 0, settle: 0 }, verifier = { ...syntheticPaymentVerifier };
  const service = new X402SettlementService({ mode: 'live', adapter: adapter(state), verifier, deliveryKey: Buffer.alloc(32, 12) });
  const settled = await service.process(input()); await service.markUnlocked(settled.record.payment_id);
  verifier.verify = async () => { throw new Error('reorg'); };
  await assert.rejects(service.process(input()), (error) => error.code === 'payment_reverification_required');
  const record = await service.get(settled.record.payment_id); assert.equal(record.state, 'RECONCILING'); assert.equal(record.independent_verification.verified, true);
  await assert.rejects(service.deliver(record.payment_id, () => ({ unauthorized: true }))); assert.equal(state.settle, 1);
});

test('W4 facilitator verify retries reads; settle never repeats an unknown broadcast', async () => {
  let calls = 0;
  const transport = new FacilitatorAdapter({ facilitatorUrl: 'https://example.invalid', maxAttempts: 5, delay: async () => {},
    fetchImpl: async () => { calls++; throw new Error('connection lost'); } });
  await assert.rejects(transport.settle({ paymentPayload: input().paymentPayload, paymentRequirements: input().paymentRequirements }));
  assert.equal(calls, 1);
});

test('W4 two independent processes cannot settle the same authorization twice', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'w4-payment-processes-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const receipt = path.join(directory, 'receipts.json'), counter = path.join(directory, 'settles.txt'), file = path.join(directory, 'input.json');
  await fs.writeFile(file, JSON.stringify(input()));
  const run = () => promisify(execFile)(process.execPath, ['tests/helpers/w4PaymentWorker.js', receipt, counter, file]);
  const results = await Promise.all([run(), run()]); assert.equal((await fs.readFile(counter, 'utf8')).trim(), 'settled');
  assert.deepEqual(results.map((result) => JSON.parse(result.stdout).state), ['SETTLED', 'SETTLED']);
  assert.equal(results.filter((result) => JSON.parse(result.stdout).replayed).length, 1);
});

test('W4 CLI restart reuses the encrypted signed request; wrong keys and missing initialized history stop new payments', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'w4-client-recovery-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 14), identity = { url: 'https://local.invalid/report', method: 'POST', payer: 'research-wallet', body: '{}' };
  const first = new ClientPaymentJournal({ directory, key }); let signed = 0;
  const create = async () => { signed++; return 'private-signed-authorization-capability'; };
  await assert.rejects(first.run(identity, create, async () => { throw new Error('lost response after payment'); }));
  const bytes = await fs.readFile(path.join(directory, 'payments.json'), 'utf8'); assert.doesNotMatch(bytes, /private-signed-authorization-capability|research-wallet/u);
  const restarted = new ClientPaymentJournal({ directory, key });
  const retry = await restarted.run(identity, create, async (header) => { assert.equal(header, 'private-signed-authorization-capability'); return new Response('{}', { status: 200 }); });
  assert.equal(retry.replayed, true); assert.equal(signed, 1);
  await assert.rejects(new ClientPaymentJournal({ directory, key: Buffer.alloc(32, 15) }).run(identity, create, async () => new Response('{}')), (error) => error.code === 'rights_vault_unavailable');
  await fs.rm(path.join(directory, 'payments.json'));
  await assert.rejects(restarted.run(identity, create, async () => new Response('{}')), (error) => error.code === 'X402_RECOVERY_HISTORY_MISSING');
  assert.equal(signed, 1);
});
