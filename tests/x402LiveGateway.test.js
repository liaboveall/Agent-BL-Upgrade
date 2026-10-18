// End-to-end: the REAL app server in Live mode, a local mock facilitator over real HTTP,
// and a fake PaymentOracle. In Live mode every paid route used to answer 503 because the
// verified V2 payment middleware was never mounted on the app server.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AbiCoder, Wallet } from 'ethers';
import {
  createInjectiveClient,
  encodePaymentSignatureHeader,
  parsePaymentRequired,
  parsePaymentResponseHeader
} from '@injectivelabs/x402/client';
import { listen, requestJson } from './helpers/http.js';
import { createPaidFetch, fetchPaidIntel } from '../src/x402/client.js';
import { payV2WithWallet } from '../web/src/lib/x402-v2.js';
import { syntheticPaymentVerifier } from './helpers/paymentVerifier.js';

const TESTNET_USDC = '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const SETTLEMENT_TX = `0x${'ab'.repeat(32)}`;
const ATTEST_TX = `0x${'cd'.repeat(32)}`;

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-x402-live-'));

/** Mock x402 facilitator: /supported, /verify and /settle with counters and failure switches. */
async function startFacilitator() {
  const state = { supported: 0, verify: 0, settle: 0, supportedStatus: 200, settleStatus: 200, nextTx: null, requests: [] };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    state.requests.push({ url: request.url, body });
    const send = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    const payer = (body?.paymentPayload ?? body?.payload?.paymentPayload ?? body)?.payload?.authorization?.from;
    if (request.url === '/supported') {
      state.supported += 1;
      if (state.supportedStatus !== 200) return send(state.supportedStatus, { error: 'down' });
      return send(200, {
        kinds: [{
          x402Version: 2,
          scheme: 'exact',
          network: 'eip155:1439',
          extra: {
            supportedAssets: [{
              address: TESTNET_USDC,
              decimals: 6,
              assetTransferMethod: 'eip3009',
              eip712: { name: 'USDC', version: '2', primaryType: 'TransferWithAuthorization' }
            }]
          }
        }],
        extensions: [],
        signers: { 'eip155:1439': ['0x3333333333333333333333333333333333333333'] }
      });
    }
    if (request.url === '/verify') {
      state.verify += 1;
      return send(200, { isValid: true, payer });
    }
    if (request.url === '/settle') {
      state.settle += 1;
      if (state.settleStatus !== 200) return send(state.settleStatus, { error: 'settlement unavailable' });
      const transaction = state.nextTx ?? (state.settle === 1 ? SETTLEMENT_TX : uniqueTx());
      state.nextTx = null;
      return send(200, { success: true, payer, transaction, network: 'eip155:1439' });
    }
    return send(404, {});
  });
  const handle = await listen(server);
  return { ...handle, state };
}

/** A fake PaymentOracle that remembers attested payment transactions like the contract does. */
function fakeOracle() {
  const oracle = {
    calls: [],
    attested: new Set(),
    failNext: null,
    async paymentTransactionAttested(tx) { return oracle.attested.has(tx); },
    async attestPayment(...args) {
      if (oracle.failNext) {
        const error = oracle.failNext;
        oracle.failNext = null;
        throw error;
      }
      oracle.calls.push(args);
      oracle.attested.add(args[3]);
      return { wait: async () => ({ hash: ATTEST_TX, blockNumber: 4242 }) };
    }
  };
  return oracle;
}


/** Minimal JSON-RPC node: answers the USDC name()/version() reads the official client needs. */
async function startRpc() {
  const abi = AbiCoder.defaultAbiCoder();
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const answer = (call) => {
      calls.push(call.method);
      if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: '0x59f' };
      if (call.method === 'eth_call') {
        const data = call.params[0].data;
        if (data.startsWith('0x06fdde03')) return { jsonrpc: '2.0', id: call.id, result: abi.encode(['string'], ['USDC']) };
        if (data.startsWith('0x54fd4d50')) return { jsonrpc: '2.0', id: call.id, result: abi.encode(['string'], ['2']) };
      }
      return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `not mocked: ${call.method}` } };
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
  });
  const handle = await listen(server);
  return { ...handle, calls };
}


/** A local key posing as a browser wallet (EIP-1193): signs typed data v4 and answers the name() read. */
function browserWallet(wallet) {
  const abi = AbiCoder.defaultAbiCoder();
  const calls = [];
  return {
    calls,
    async request({ method, params }) {
      calls.push(method);
      if (method === 'eth_call') return abi.encode(['string'], ['USDC']);
      if (method === 'eth_signTypedData_v4') {
        const typed = JSON.parse(params[1]);
        const { EIP712Domain, ...types } = typed.types;
        return wallet.signTypedData(typed.domain, types, typed.message);
      }
      throw new Error(`unexpected wallet call ${method}`);
    }
  };
}

const facilitator = await startFacilitator();
Object.assign(process.env, {
  DEMO_MODE: 'false',
  X402_MODE: 'live',
  X402_NETWORK: 'eip155:1439',
  X402_FACILITATOR_URL: facilitator.base,
  X402_ALLOW_INSECURE_TESTNET: 'true',
  X402_PAY_TO: PAY_TO,
  X402_RECEIPT_STORE_PATH: path.join(directory, 'receipts.json'),
  X402_REPORT_CACHE_PATH: path.join(directory, 'reports.json'),
  MYSTERY_STORE_PATH: path.join(directory, 'reveals.json'),
  X402_GATEWAY_RETRY_MS: '40',
  AGENTBL_RATE_LIMIT_PER_MIN: '0',
  AGENTBL_WRITE_RATE_LIMIT_PER_MIN: '0'
});
delete process.env.AGENTBL_ADMIN_TOKEN;

const { createServer } = await import('../src/app/server.js');
const { storeState, createPool } = await import('../src/app/store.js');
const { quoteFromCase } = await import('../src/core/pricingEngine.js');
const { setPaymentOracleOverride } = await import('../src/x402/settlement.js');
const { createUserNonce } = await import('../src/mystery/fairness.js');
const { assertPaidReportEnvelope } = await import('../src/x402/paidReport.js');

function paymentHeader(requirement, from, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    x402Version: 2,
    accepted: structuredClone(requirement),
    payload: {
      signature: `0x${'aa'.repeat(65)}`,
      authorization: {
        from,
        to: requirement.payTo,
        value: requirement.amount,
        validAfter: String(now - 10),
        validBefore: String(now + 60),
        nonce: `0x${crypto.randomBytes(32).toString('hex')}`,
        ...overrides
      }
    }
  };
  return { header: encodePaymentSignatureHeader(payload), payload };
}

const uniqueTx = () => `0x${crypto.randomBytes(32).toString('hex')}`;
const post = (base, endpoint, body, headers = {}) => requestJson(base, 'POST', endpoint, body, headers);
const RISK = '/api/x402/intel/premium-risk';

test('x402 live gateway on the real app server', async (t) => {
  const app = await listen(createServer({ x402Options: { verifier: syntheticPaymentVerifier, deliveryKey: crypto.randomBytes(32) } }));
  const oracle = fakeOracle();
  setPaymentOracleOverride(oracle);
  t.after(async () => {
    setPaymentOracleOverride(null);
    await app.close();
    await facilitator.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const payer = Wallet.createRandom().address;
  const counters = () => ({ supported: facilitator.state.supported, verify: facilitator.state.verify, settle: facilitator.state.settle });

  await t.test('an unavailable facilitator is a 503, and the gateway recovers once it is back', async () => {
    facilitator.state.supportedStatus = 503;
    const down = await post(app.base, RISK, {});
    assert.equal(down.status, 503);
    assert.equal(down.data.code, 'x402_v2_live_transport_required');

    facilitator.state.supportedStatus = 200;
    await new Promise((resolve) => setTimeout(resolve, 80)); // past X402_GATEWAY_RETRY_MS
    const challenge = await post(app.base, RISK, {});
    assert.equal(challenge.status, 402, 'the gateway must initialise once the facilitator answers');
  });

  await t.test('unpaid requests get a decodable V2 challenge priced from the service catalog', async () => {
    const expected = {
      '/api/x402/intel/premium-risk': '1000',
      '/api/x402/valuation/premium': '2000',
      '/api/x402/documents/fraud-review': '1500',
      '/api/x402/mystery/voyage': '1000'
    };
    for (const [endpoint, amount] of Object.entries(expected)) {
      const res = await post(app.base, endpoint, {});
      assert.equal(res.status, 402, endpoint);
      assert.equal(res.data.x402Version, 2);
      assert.equal(res.data.accepts[0].amount, amount, `${endpoint} price`);
      assert.equal(res.data.accepts[0].payTo, PAY_TO);
      assert.equal(res.data.accepts[0].asset, TESTNET_USDC);
      assert.equal(res.data.accepts[0].network, 'eip155:1439');
      const decoded = parsePaymentRequired(res.headers.get('payment-required'));
      assert.deepEqual(decoded.accepts, res.data.accepts);
    }
  });

  await t.test('the personal-sign (demo) headers do not unlock anything in Live mode', async () => {
    const res = await post(app.base, RISK, {}, {
      'x402-signature': `0x${'11'.repeat(65)}`,
      'x402-signer': payer
    });
    assert.equal(res.status, 402);
    assert.equal(res.data.x402Version, 2);
    assert.equal(counters().settle, 0);
  });

  let requirement;
  let reportId;
  let signed;
  await t.test('a verified payment settles once, delivers the report, and attests it on-chain', async () => {
    requirement = (await post(app.base, RISK, {})).data.accepts[0];
    signed = paymentHeader(requirement, payer);
    const before = counters();
    const res = await post(app.base, RISK, {}, { 'payment-signature': signed.header });

    assert.equal(res.status, 200, res.text);
    assert.equal(res.data.kind, 'risk-intelligence');
    assert.equal(res.data.payment.status, 'settled');
    assert.equal(res.data.payment.live, true);
    assert.equal(res.data.payment.txHash, SETTLEMENT_TX);
    assert.equal(res.data.payment.attestationTxHash, ATTEST_TX);
    assert.equal(res.data.payment.attestation, 'recorded');
    assert.equal(res.data.payment.amountUSDC, 0.001);
    assert.equal(counters().verify, before.verify + 1);
    assert.equal(counters().settle, before.settle + 1);

    const receipt = JSON.parse(Buffer.from(res.headers.get('payment-response'), 'base64').toString('utf8'));
    assert.equal(receipt.success, true);
    assert.equal(receipt.transaction, SETTLEMENT_TX);
    assert.equal(receipt.payer.toLowerCase(), payer.toLowerCase());

    const envelope = res.data.report_envelope;
    assertPaidReportEnvelope(envelope);
    assert.equal(envelope.payment_tx, SETTLEMENT_TX, 'the envelope binds the REAL settlement transaction');
    reportId = envelope.report_id;
    assert.equal(envelope.payer.toLowerCase(), payer.toLowerCase());
    assert.equal(envelope.payee.toLowerCase(), PAY_TO.toLowerCase());
    assert.equal(envelope.amount, '1000');

    assert.equal(oracle.calls.length, 1);
    const [receiptId, reportHash, caseIdHash, paymentTx, attestedPayer, asset, amount] = oracle.calls[0];
    assert.equal(receiptId, `0x${envelope.report_id.slice(4)}`);
    assert.equal(reportHash, envelope.report_hash);
    assert.equal(caseIdHash, `0x${crypto.createHash('sha256').update(envelope.case_id).digest('hex')}`);
    assert.equal(paymentTx, SETTLEMENT_TX);
    assert.equal(attestedPayer.toLowerCase(), payer.toLowerCase());
    assert.equal(asset.toLowerCase(), TESTNET_USDC.toLowerCase());
    assert.equal(amount, 1000n);
  });

  await t.test('replaying the same signed authorization re-delivers without a second charge or attestation', async () => {
    const before = counters();
    const callsBefore = oracle.calls.length;
    const res = await post(app.base, RISK, {}, { 'payment-signature': signed.header });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(counters(), before, 'the facilitator must not be charged again');
    assert.equal(oracle.calls.length, callsBefore, 'the oracle must not be written twice');
    assert.equal(res.data.payment.attestation, 'recorded');
  });

  await t.test('the paid report can be re-read from the cache without paying again', async () => {
    const denied = await requestJson(app.base, 'GET', `/api/x402/report/${reportId}`);
    assert.equal(denied.status, 401);
    const res = await requestJson(app.base, 'GET', `/api/x402/report/${reportId}`, undefined, { 'payment-signature': signed.header });
    assert.equal(res.status, 200);
    assert.equal(res.data.cached, true);
    assert.equal(res.data.report_envelope.report_id, reportId);
  });

  await t.test('payments that do not match the protected resource never reach the facilitator', async () => {
    const before = counters();
    const bad = [
      paymentHeader(requirement, payer, { value: '999' }),                                  // wrong amount (signed)
      paymentHeader({ ...requirement, payTo: '0x4444444444444444444444444444444444444444' }, payer), // wrong recipient
      paymentHeader({ ...requirement, network: 'eip155:1776' }, payer)                      // wrong network
    ];
    for (const attempt of bad) {
      const res = await post(app.base, RISK, {}, { 'payment-signature': attempt.header });
      assert.equal(res.status, 402);
    }
    assert.deepEqual(counters(), before);
  });

  await t.test('a facilitator settlement failure never delivers the report', async () => {
    facilitator.state.settleStatus = 503;
    try {
      const res = await post(app.base, RISK, {}, { 'payment-signature': paymentHeader(requirement, payer).header });
      assert.equal(res.status, 402);
      assert.ok(res.data.extensions.errorCode);
      assert.equal(res.data.kind, undefined);
    } finally {
      facilitator.state.settleStatus = 200;
    }
  });

  await t.test('malformed input is refused BEFORE the buyer is charged', async () => {
    const before = counters();
    const header = paymentHeader(requirement, payer).header;
    const res = await post(app.base, RISK, { case: 'not an object' }, { 'payment-signature': header });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'invalid_request');
    assert.deepEqual(counters(), before, 'no verify/settle call for a request that cannot be served');
  });

  await t.test('a failure after settlement says the payment went through and that a retry is free', async () => {
    const fresh = paymentHeader(requirement, payer);
    oracle.failNext = Object.assign(new Error('rpc connection reset'), { code: 'NETWORK_ERROR' });
    oracle.attested.clear();
    const before = counters();
    const failed = await post(app.base, RISK, {}, { 'payment-signature': fresh.header });
    assert.equal(failed.status, 502);
    assert.equal(failed.data.code, 'payment_oracle_write_failed');
    assert.equal(failed.data.payment.status, 'settled');
    assert.match(failed.data.payment.retry, /never charged twice/u);
    assert.equal(counters().settle, before.settle + 1);

    const retried = await post(app.base, RISK, {}, { 'payment-signature': fresh.header });
    assert.equal(retried.status, 200, retried.text);
    assert.equal(counters().settle, before.settle + 1, 'the retry must reuse the settled payment');
    assert.equal(retried.data.payment.attestation, 'recorded');
  });

  await t.test('without a configured attestor the report is not delivered (Live never fakes a receipt)', async () => {
    setPaymentOracleOverride(null);
    delete process.env.PAYMENT_ATTESTOR_PRIVATE_KEY;
    delete process.env.DEPLOYER_PRIVATE_KEY;
    try {
      const res = await post(app.base, RISK, {}, { 'payment-signature': paymentHeader(requirement, payer).header });
      assert.equal(res.status, 503);
      assert.equal(res.data.code, 'payment_oracle_unavailable');
      assert.match(res.data.error, /PAYMENT_ATTESTOR_PRIVATE_KEY/u);
      assert.equal(res.data.payment.status, 'settled');
      assert.equal(res.data.kind, undefined, 'no simulated report/receipt in Live mode');
    } finally {
      setPaymentOracleOverride(oracle);
    }
  });

  await t.test('Mystery Voyage: invalid reveals are rejected before payment, a valid one completes after it', async () => {
    // Payment-path fixture only: W4 deliberately pauses source-unverified Live finance.
    // These public research pools exercise the reveal/payment protocol, not Live eligibility.
    const blocked = await post(app.base, '/api/mystery/preview', { wallet_address: Wallet.createRandom().address,
      idempotency_key: 'unverified-live-source', risk_passport: { tier: 'ADVENTUROUS' } });
    assert.equal(blocked.status, 400); assert.equal(blocked.data.code, 'mystery_no_candidates');
    for (const pool of [...storeState.pools.values()]) {
      createPool(pool.poolId, pool.caseData, quoteFromCase(pool.caseData, { payout_speed: pool.quote.payout_speed, require_source_validation: false }),
        { investorEligible: pool.investorEligible });
    }
    const wallet = Wallet.createRandom();
    const previewed = await post(app.base, '/api/mystery/preview', {
      wallet_address: wallet.address,
      idempotency_key: 'live-gateway',
      risk_passport: { tier: 'ADVENTUROUS' }
    });
    assert.equal(previewed.status, 201, previewed.text);
    const mystery = (await post(app.base, '/api/x402/mystery/voyage', {})).data.accepts[0];
    const userNonce = createUserNonce();
    const mysteryTx = uniqueTx();
    const before = counters();

    const wrongWallet = paymentHeader(mystery, Wallet.createRandom().address);
    const mismatch = await post(app.base, '/api/x402/mystery/voyage',
      { reveal_id: previewed.data.reveal_id, user_nonce: userNonce }, { 'payment-signature': wrongWallet.header });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.data.code, 'wallet_mismatch');

    const unknownReveal = await post(app.base, '/api/x402/mystery/voyage',
      { reveal_id: 'does-not-exist', user_nonce: userNonce }, { 'payment-signature': paymentHeader(mystery, wallet.address).header });
    assert.equal(unknownReveal.status, 404);
    assert.deepEqual(counters(), before, 'neither rejected request may reach the facilitator');

    facilitator.state.nextTx = mysteryTx;
    const paid = await post(app.base, '/api/x402/mystery/voyage',
      { reveal_id: previewed.data.reveal_id, user_nonce: userNonce }, { 'payment-signature': paymentHeader(mystery, wallet.address).header });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.data.kind, 'mystery-voyage-risk-passport');
    assert.equal(paid.data.reveal_state, 'REVEALED');
    assert.equal(paid.data.payment.live, true);
    assert.equal(paid.data.proof.payment_tx_hash, mysteryTx, 'the reveal is bound to the real settlement transaction');
    assert.equal(counters().settle, before.settle + 1);
  });

  await t.test('the OFFICIAL x402 client (real EIP-3009 signing) can pay the gateway', async () => {
    const rpc = await startRpc();
    try {
      const wallet = Wallet.createRandom();
      const client = createInjectiveClient({ privateKey: wallet.privateKey, rpcUrl: rpc.base, preferredNetworks: ['eip155:1439'] });
      const before = counters();
      const res = await client.fetch(`${app.base}${RISK}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.kind, 'risk-intelligence');
      assert.equal(body.payment.live, true);
      assert.equal(body.payment.payer.toLowerCase(), wallet.address.toLowerCase());
      const receipt = parsePaymentResponseHeader(res);
      assert.equal(receipt.success, true);
      assert.equal(receipt.transaction, body.payment.txHash);
      assert.equal(counters().settle, before.settle + 1);
      assert.deepEqual([...new Set(rpc.calls)], ['eth_call'], 'only read-only RPC calls');
    } finally {
      await rpc.close();
    }
  });

  await t.test('the repo CLI client pays a Live endpoint, but enforces budget, network and signer BEFORE signing', async () => {
    const rpc = await startRpc();
    try {
      const wallet = Wallet.createRandom();
      const before = counters();
      const result = await fetchPaidIntel(app.base, RISK, {
        recoveryKey: crypto.randomBytes(32), recoveryDirectory: path.join(directory, 'client-recovery'),
        privateKey: wallet.privateKey,
        rpcUrl: rpc.base,
        budgetUSDC: 0.005,
        timeoutMs: 15_000,
        payload: {}
      });
      assert.equal(result.x402_required, true);
      assert.equal(result.paid.kind, 'risk-intelligence');
      assert.equal(result.paymentTxHash, result.paid.payment.txHash);
      assert.equal(result.network, 'eip155:1439');
      assert.equal(result.priceUSDC, 0.001);
      assert.equal(counters().settle, before.settle + 1);

      const afterPaid = counters();
      const paidFetch = (options) => createPaidFetch({ timeoutMs: 15_000, rpcUrl: rpc.base, ...options })(`${app.base}${RISK}`, { method: 'POST', body: '{}' });
      await assert.rejects(paidFetch({ privateKey: wallet.privateKey, budgetUSDC: 0.0001 }), (error) => error.code === 'X402_BUDGET_EXCEEDED');
      await assert.rejects(paidFetch({ privateKey: wallet.privateKey, allowedNetworks: ['eip155:1776'] }), (error) => error.code === 'X402_WRONG_NETWORK');
      await assert.rejects(paidFetch({ budgetUSDC: 0.005 }), (error) => error.code === 'X402_SIGNER_REQUIRED');
      assert.deepEqual(counters(), afterPaid, 'refused payments must never reach the facilitator');
    } finally {
      await rpc.close();
    }
  });

  await t.test('the BROWSER wallet flow (eth_signTypedData_v4) pays the gateway like the official client', async () => {
    const wallet = Wallet.createRandom();
    const provider = browserWallet(wallet);
    const stages = [];
    const before = counters();
    const { response, requirement: paid } = await payV2WithWallet({
      endpoint: `${app.base}${RISK}`,
      body: {},
      provider,
      from: wallet.address,
      expectedAmountAtomic: 1000,
      onStage: (stage) => stages.push(stage)
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(stages, ['challenge', 'sign', 'settle']);
    assert.equal(paid.amount, '1000');
    assert.equal(body.kind, 'risk-intelligence');
    assert.equal(body.payment.live, true);
    assert.equal(body.payment.payer.toLowerCase(), wallet.address.toLowerCase());
    assert.equal(body.report_envelope.payer.toLowerCase(), wallet.address.toLowerCase());
    assert.equal(counters().settle, before.settle + 1);
    assert.deepEqual(provider.calls, ['eth_call', 'eth_signTypedData_v4']);
  });

  await t.test('the browser flow completes a Mystery Voyage reveal (wallet = previewing wallet)', async () => {
    const wallet = Wallet.createRandom();
    const previewed = await post(app.base, '/api/mystery/preview', {
      wallet_address: wallet.address,
      idempotency_key: 'browser-v2',
      risk_passport: { tier: 'ADVENTUROUS' }
    });
    assert.equal(previewed.status, 201, previewed.text);
    const before = counters();
    facilitator.state.nextTx = uniqueTx();
    const { response } = await payV2WithWallet({
      endpoint: `${app.base}/api/x402/mystery/voyage`,
      body: { reveal_id: previewed.data.reveal_id, user_nonce: createUserNonce() },
      provider: browserWallet(wallet),
      from: wallet.address,
      expectedAmountAtomic: 1000
    });
    const report = await response.json();
    assert.equal(response.status, 200, JSON.stringify(report));
    assert.equal(report.reveal_state, 'REVEALED');
    assert.equal(counters().settle, before.settle + 1);
  });

  await t.test('a wrong-wallet Mystery payment is refused before the browser wallet is even asked to sign', async () => {
    const owner = Wallet.createRandom();
    const intruder = Wallet.createRandom();
    const previewed = await post(app.base, '/api/mystery/preview', {
      wallet_address: owner.address, idempotency_key: 'browser-v2-intruder', risk_passport: { tier: 'ADVENTUROUS' }
    });
    const before = counters();
    const provider = browserWallet(intruder);
    const { response } = await payV2WithWallet({
      endpoint: `${app.base}/api/x402/mystery/voyage`,
      body: { reveal_id: previewed.data.reveal_id, user_nonce: createUserNonce() },
      provider,
      from: intruder.address,
      expectedAmountAtomic: 1000
    });
    assert.equal(response.status, 409, 'the server-side preflight rejects the mismatch after signing, before settlement');
    assert.deepEqual(counters(), before, 'and no money moved');
  });
});
