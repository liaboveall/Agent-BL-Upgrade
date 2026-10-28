import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { PayerRecoverySessions } from '../src/x402/payerRecovery.js';
import { JsonReceiptStore, PaymentSettlementError, X402SettlementService } from '../src/x402/settlement.js';

const sign = (wallet, challenge) => wallet.signTypedData(challenge.domain, challenge.types, challenge.message);

test('F01 payer recovery sessions: one-time challenge, payer-only signature, expiry and mode change end them', async () => {
  let now = 1_900_000_000_000, generation = 1;
  const sessions = new PayerRecoverySessions({ clock: () => now, getGeneration: () => generation });
  const payer = Wallet.createRandom(), other = Wallet.createRandom();
  assert.throws(() => sessions.challenge('0x123'), { code: 'x402_recovery_payer_invalid' });

  const challenge = sessions.challenge(payer.address);
  for (let i = 0; i < 5; i++) assert.equal(sessions.challenge(payer.address).challenge_id, challenge.challenge_id, 'unsigned requests share the open challenge');
  await assert.rejects(async () => sessions.open({ challenge_id: challenge.challenge_id, signature: await sign(other, challenge) }), { code: 'x402_recovery_signature_invalid' });
  const opened = sessions.open({ challenge_id: challenge.challenge_id, signature: await sign(payer, challenge) });
  await assert.rejects(async () => sessions.open({ challenge_id: challenge.challenge_id, signature: await sign(payer, challenge) }), { code: 'x402_recovery_challenge_invalid' }, 'only the payer\'s valid signature spends it');
  assert.notEqual(sessions.challenge(payer.address).challenge_id, challenge.challenge_id);
  assert.equal(sessions.payer(opened.token), payer.address.toLowerCase());
  assert.throws(() => sessions.payer('ab'.repeat(32)), { code: 'x402_recovery_session_required' });
  generation++;
  assert.throws(() => sessions.payer(opened.token), { code: 'x402_recovery_session_required' }, 'a mode change ends recovery sessions');

  const late = sessions.challenge(payer.address); now += 6 * 60 * 1000;
  await assert.rejects(async () => sessions.open({ challenge_id: late.challenge_id, signature: await sign(payer, late) }), { code: 'x402_recovery_challenge_invalid' });
  const lapsing = sessions.challenge(other.address); now += 3.5 * 60 * 1000;
  assert.notEqual(sessions.challenge(other.address).challenge_id, lapsing.challenge_id, 'a challenge with under two minutes left is replaced');

  // At capacity the oldest open request gives way: a flood of other addresses delays a payer but never locks them out.
  const full = new PayerRecoverySessions({ clock: () => now, maxChallenges: 2 }), first = full.challenge(payer.address);
  full.challenge(Wallet.createRandom().address); full.challenge(Wallet.createRandom().address);
  const again = full.challenge(payer.address);
  assert.notEqual(again.challenge_id, first.challenge_id);
  assert.ok(full.open({ challenge_id: again.challenge_id, signature: await sign(payer, again) }).token);
});

function signedPayload(from, nowSeconds) {
  const requirement = { scheme: 'exact', network: 'eip155:1439', asset: `0x${'11'.repeat(20)}`, payTo: `0x${'22'.repeat(20)}`, amount: '1000', maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' } };
  const authorization = { from, to: requirement.payTo, value: '1000', validAfter: String(nowSeconds - 10), validBefore: String(nowSeconds + 60), nonce: `0x${randomBytes(32).toString('hex')}` };
  return { paymentPayload: { x402Version: 2, accepted: requirement, payload: { signature: `0x${'ab'.repeat(65)}`, authorization } }, paymentRequirements: requirement, resource: 'https://agentbl.invalid/api/x402/intel/premium-risk#request=00' };
}

async function interrupted({ deliveryKey }) {
  let now = 1_900_000_000_000;
  const facilitatorDown = new PaymentSettlementError('facilitator_verify_unavailable', 'Facilitator unavailable', { retryable: true });
  const service = new X402SettlementService({ mode: 'live', env: {}, deliveryKey, clock: () => new Date(now), store: new JsonReceiptStore({ filePath: null }),
    verifier: { prepare: async () => ({ from_block: 0, authorization_used: false }), locate: async () => null, verify: async () => { throw new Error('not settled'); } },
    adapter: { verify: async () => { throw facilitatorDown; }, settle: async () => { throw new Error('must not settle'); } } });
  const payer = Wallet.createRandom().address, input = signedPayload(payer, Math.floor(now / 1000));
  await assert.rejects(service.process(input), { code: 'facilitator_verify_unavailable' });
  const [record] = await service.store.list();
  return { service, payer, record, advance: (ms) => { now += ms; } };
}

test('F01 a signed but unsettled payment past its window is reported unspent, not failed, so the payer may buy again', async () => {
  const h = await interrupted({ deliveryKey: randomBytes(32) });
  assert.equal(h.record.state, 'SIGNED'); assert.ok(h.record.authorization_signature, 'the signature is sealed for later recovery');
  assert.equal(h.record.authorization_signature.algorithm, 'AES-256-GCM');
  assert.equal(JSON.stringify(h.record).includes('ab'.repeat(65)), false, 'the receipt history never holds the signature in clear');
  await assert.rejects(h.service.recoverForPayer(Wallet.createRandom().address, h.record.payment_id), { code: 'payment_not_found' });
  h.advance(2 * 60 * 1000);
  const result = await h.service.recoverForPayer(h.payer, h.record.payment_id);
  assert.equal(result.status, 'expired_unspent');
  assert.equal((await h.service.get(h.record.payment_id)).state, 'SIGNED');
  assert.deepEqual((await h.service.paymentsForPayer(h.payer)).map((entry) => [entry.payment_id, entry.error_code]), [[h.record.payment_id, 'payment_expired']]);
});

test('F01 an older record without a sealed signature asks for the original authorization and never marks it failed', async () => {
  const h = await interrupted({ deliveryKey: null });
  assert.equal(h.record.authorization_signature, undefined);
  assert.equal((await h.service.recoverForPayer(h.payer, h.record.payment_id)).status, 'original_authorization_required');
  assert.equal((await h.service.get(h.record.payment_id)).state, 'SIGNED');
});
