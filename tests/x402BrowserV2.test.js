// The browser-side x402 V2 payment builder must be indistinguishable from the official
// client's output, because the gateway and the facilitator cannot tell them apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Wallet, verifyTypedData } from 'ethers';
import { decodePaymentSignatureHeader, encodePaymentSignatureHeader } from '@injectivelabs/x402/client';
import {
  TRANSFER_WITH_AUTHORIZATION_TYPE as OFFICIAL_TYPE,
  buildTransferWithAuthorizationTypedData
} from '@injectivelabs/x402/eip3009';
import {
  TRANSFER_WITH_AUTHORIZATION_TYPE,
  X402V2Error,
  buildAuthorization,
  buildPaymentPayload,
  buildTypedData,
  decodeAbiString,
  encodePaymentHeader,
  isV2Challenge,
  payV2WithWallet,
  pickRequirement,
  randomNonce,
  readTokenName,
  toWalletTypedDataJson
} from '../web/src/lib/x402-v2.js';

const ASSET = '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const abi = AbiCoder.defaultAbiCoder();

function requirement(overrides = {}) {
  return {
    scheme: 'exact',
    network: 'eip155:1439',
    amount: '1000',
    asset: ASSET,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009', chainId: 1439, verifyingContract: ASSET, primaryType: 'TransferWithAuthorization' },
    ...overrides
  };
}

/** An EIP-1193 provider backed by a local key; records what the wallet was asked to do. */
function walletProvider(wallet, { tokenName = 'USDC' } = {}) {
  const calls = [];
  return {
    calls,
    async request({ method, params }) {
      calls.push(method);
      if (method === 'eth_call') return abi.encode(['string'], [tokenName]);
      if (method === 'eth_signTypedData_v4') {
        const [account, json] = params;
        assert.equal(account, wallet.address);
        const typed = JSON.parse(json);
        const { EIP712Domain, ...types } = typed.types;
        assert.ok(EIP712Domain, 'wallets need EIP712Domain spelled out');
        return wallet.signTypedData(typed.domain, types, typed.message);
      }
      throw new Error(`unexpected wallet call ${method}`);
    }
  };
}

test('the EIP-712 type list matches the official client field for field', () => {
  assert.deepEqual(TRANSFER_WITH_AUTHORIZATION_TYPE, OFFICIAL_TYPE.TransferWithAuthorization);
});

test('typed data and authorization window match the official construction', () => {
  const wallet = Wallet.createRandom();
  const nowSeconds = 1_900_000_000;
  const nonce = `0x${'07'.repeat(32)}`;
  const req = requirement();
  const authorization = buildAuthorization({ requirement: req, from: wallet.address, nowSeconds, nonce });

  // Official client: validAfter = now - 10, validBefore = now + maxTimeoutSeconds, to = payTo, value = amount.
  assert.deepEqual(authorization, {
    from: wallet.address,
    to: PAY_TO,
    value: '1000',
    validAfter: String(nowSeconds - 10),
    validBefore: String(nowSeconds + 60),
    nonce
  });

  const ours = buildTypedData({ requirement: req, tokenName: 'USDC', authorization });
  const official = buildTransferWithAuthorizationTypedData({
    tokenName: 'USDC',
    tokenVersion: '2',
    chainId: 1439,
    tokenAddress: ASSET,
    authorization: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) }
  });
  assert.deepEqual(ours.domain, official.domain);
  assert.deepEqual(ours.types, official.types);
  assert.equal(ours.primaryType, official.primaryType);
  const stringifyMessage = (message) => Object.fromEntries(Object.entries(message).map(([key, value]) => [key, String(value)]));
  assert.deepEqual(ours.message, stringifyMessage(official.message));
});

test('a browser-signed authorization is a valid EIP-3009 signature by the paying wallet', async () => {
  const wallet = Wallet.createRandom();
  const req = requirement();
  const authorization = buildAuthorization({ requirement: req, from: wallet.address, nowSeconds: 1_900_000_000, nonce: randomNonce() });
  const typed = buildTypedData({ requirement: req, tokenName: 'USDC', authorization });
  const signature = await walletProvider(wallet).request({ method: 'eth_signTypedData_v4', params: [wallet.address, toWalletTypedDataJson(typed)] });
  assert.equal(verifyTypedData(typed.domain, typed.types, typed.message, signature), wallet.address);

  // Signing a different token name (a spoofed domain) must NOT verify against the real one.
  const spoofed = buildTypedData({ requirement: req, tokenName: 'Not USDC', authorization });
  assert.notEqual(verifyTypedData(spoofed.domain, spoofed.types, spoofed.message, signature), wallet.address);
});

test('the PAYMENT-SIGNATURE header decodes with the official decoder to the same payload', async () => {
  const wallet = Wallet.createRandom();
  const req = requirement();
  const authorization = buildAuthorization({ requirement: req, from: wallet.address, nowSeconds: Math.floor(Date.now() / 1000), nonce: randomNonce() });
  const typed = buildTypedData({ requirement: req, tokenName: 'USDC', authorization });
  const signature = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  const payload = buildPaymentPayload({ requirement: req, authorization, signature });

  const ours = decodePaymentSignatureHeader(encodePaymentHeader(payload));
  const official = decodePaymentSignatureHeader(encodePaymentSignatureHeader(payload));
  assert.deepEqual(ours, official);
  assert.equal(ours.x402Version, 2);
  assert.equal(ours.payload.authorization.value, '1000');
});

test('pickRequirement refuses anything unexpected before a signature is requested', () => {
  const challenge = (accepts) => ({ x402Version: 2, accepts });
  assert.equal(isV2Challenge(challenge([requirement()])), true);
  assert.equal(isV2Challenge({ challenge: 'sign me', nonce: 'x' }), false, 'the demo challenge is not V2');

  assert.equal(pickRequirement(challenge([requirement()]), { expectedAmountAtomic: 1000 }).amount, '1000');
  const refused = (value, code, options) => assert.throws(() => pickRequirement(value, options), (error) => error instanceof X402V2Error && error.code === code);
  refused({ challenge: 'demo' }, 'not_v2');
  refused(challenge([requirement({ network: 'eip155:1' })]), 'network_not_allowed');
  refused(challenge([requirement({ scheme: 'upto' })]), 'network_not_allowed');
  refused(challenge([requirement({ asset: 'not-an-address' })]), 'requirement_invalid');
  refused(challenge([requirement({ payTo: '0x123' })]), 'requirement_invalid');
  refused(challenge([requirement({ amount: '0' })]), 'requirement_invalid');
  refused(challenge([requirement({ amount: '1.5' })]), 'requirement_invalid');
  refused(challenge([requirement({ maxTimeoutSeconds: 99999 })]), 'requirement_invalid');
  refused(challenge([requirement({ amount: '5000' })]), 'price_mismatch', { expectedAmountAtomic: 1000 });
  assert.equal(pickRequirement(challenge([requirement({ network: 'eip155:1' }), requirement()])).network, 'eip155:1439', 'picks the first acceptable option');
});

test('decodeAbiString / readTokenName read the on-chain token name', async () => {
  for (const name of ['USDC', 'USD Coin', 'Tether USD ✓']) {
    assert.equal(decodeAbiString(abi.encode(['string'], [name])), name);
  }
  assert.throws(() => decodeAbiString('0x'), X402V2Error);
  assert.throws(() => decodeAbiString(`0x${'00'.repeat(31)}20${'00'.repeat(31)}ff`), X402V2Error, 'declared length beyond the data');
  const wallet = Wallet.createRandom();
  assert.equal(await readTokenName(walletProvider(wallet, { tokenName: 'USD Coin' }), ASSET), 'USD Coin');
});

test('payV2WithWallet signs only after validating the challenge, and never signs a wrong price', async () => {
  const wallet = Wallet.createRandom();
  const provider = walletProvider(wallet);
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body });
    if (!init.headers['PAYMENT-SIGNATURE']) {
      return new Response(JSON.stringify({ x402Version: 2, accepts: [requirement({ amount: '9000000' })] }), { status: 402 });
    }
    return new Response('{}', { status: 200 });
  };
  await assert.rejects(
    payV2WithWallet({ endpoint: '/api/x402/x', body: {}, provider, from: wallet.address, expectedAmountAtomic: 1000, fetchImpl }),
    (error) => error.code === 'price_mismatch'
  );
  assert.ok(!provider.calls.includes('eth_signTypedData_v4'), 'the wallet must never be asked to sign an unexpected price');
  assert.equal(sent.length, 1, 'no paid request was sent');
});

test('payV2WithWallet passes through a free / pre-payment rejection untouched', async () => {
  const wallet = Wallet.createRandom();
  const result = await payV2WithWallet({
    endpoint: '/x', body: {}, provider: walletProvider(wallet), from: wallet.address,
    fetchImpl: async () => new Response(JSON.stringify({ code: 'invalid_request' }), { status: 400 })
  });
  assert.equal(result.challenge, null);
  assert.equal(result.response.status, 400);
});
