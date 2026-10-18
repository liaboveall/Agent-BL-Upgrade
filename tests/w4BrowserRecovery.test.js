import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, AbiCoder } from 'ethers';
import { payV2WithWallet } from '../web/src/lib/x402-v2.js';
import { reportAuthorization } from '../web/src/lib/payment-recovery.js';

test('W4 browser saves the exact authorization before sending; lost response/reload never asks for another payment signature', async () => {
  const values = new Map(), recoveryStore = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const wallet = Wallet.createRandom(), signatures = [], headers = [];
  const requirement = { scheme: 'exact', network: 'eip155:1439', asset: `0x${'11'.repeat(20)}`, payTo: `0x${'22'.repeat(20)}`,
    amount: '1000', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' } };
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_call') return AbiCoder.defaultAbiCoder().encode(['string'], ['USDC']);
    if (method === 'eth_signTypedData_v4') { signatures.push(params[1]); const typed = JSON.parse(params[1]); const { EIP712Domain: _domain, ...types } = typed.types; return wallet.signTypedData(typed.domain, types, typed.message); }
    throw new Error('Unexpected wallet operation');
  } };
  let lose = true;
  const fetchImpl = async (_url, init) => {
    const header = init.headers['PAYMENT-SIGNATURE'];
    if (!header) return new Response(JSON.stringify({ x402Version: 2, accepts: [requirement] }), { status: 402 });
    headers.push(header); assert.ok([...values.values()].some((value) => value.includes(header)), 'authorization must be durable before any paid request');
    if (lose) { lose = false; throw new Error('Response lost after debit'); }
    return new Response(JSON.stringify({ report_envelope: { report_id: 'rpt_public-test' }, payment: { status: 'settled' } }), { status: 200 });
  };
  const options = { endpoint: '/paid', from: wallet.address, body: { case_id: 'research' }, provider, recoveryStore, fetchImpl, expectedAmountAtomic: 1000 };
  await assert.rejects(payV2WithWallet(options), /lost/u); assert.equal(signatures.length, 1);
  await assert.rejects(payV2WithWallet({ ...options, body: { case_id: 'another' } }), /Reconcile/u); assert.equal(signatures.length, 1);
  const replay = await payV2WithWallet({ ...options, now: () => 4_000_000_000 });
  assert.equal(replay.replayed, true); assert.equal(replay.response.status, 200); assert.equal(signatures.length, 1); assert.equal(headers[0], headers[1]);
  assert.equal(reportAuthorization('rpt_public-test', recoveryStore), headers[0]);
  const final = await payV2WithWallet(options); assert.equal(final.replayed, true); assert.equal(signatures.length, 1);
});

test('W4 browser storage corruption/quota prevents sending a signed payment without a recovery checkpoint', async () => {
  const options = { endpoint: '/paid', from: Wallet.createRandom().address, body: {}, provider: { request: () => { throw new Error('must not sign'); } },
    recoveryStore: { getItem: () => '{invalid', setItem: () => {} }, fetchImpl: () => { throw new Error('must not request'); } };
  await assert.rejects(payV2WithWallet(options), SyntaxError);
});
