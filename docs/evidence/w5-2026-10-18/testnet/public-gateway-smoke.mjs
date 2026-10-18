// W5 evidence runner: production gateway/client, official Injective facilitator,
// canonical test USDC and real PaymentOracle. No synthetic facilitator or verifier.
import '../../../../src/env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { createLiveGateway } from '../../../../src/x402/liveGateway.js';
import { createPaidFetch } from '../../../../src/x402/client.js';
import { loadX402Config, X402_SERVICES } from '../../../../src/x402/config.js';
import { recordPaymentEvidence } from '../../../../src/x402/settlement.js';
import { resolveSignerKey } from '../../../../src/chain/signerKeys.js';
import { seal, unseal } from '../../../../src/rights/vault.js';
import { readJson, writeJsonAtomic } from '../../../../src/lib/jsonStore.js';
import chainConfigLib from '../../../../scripts/lib/chain-config.cjs';

const root = process.cwd(), dir = path.join(root, 'data/runtime/w5-public-gateway');
await fs.mkdir(dir, { recursive: true });
const key = Buffer.from((await fs.readFile(path.join(os.homedir(), '.agentbl/w5-2026-10-18/rights-key.hex'), 'utf8')).trim(), 'hex');
process.env.DEMO_MODE = 'false'; process.env.X402_MODE = 'live';
process.env.AGENTBL_RIGHTS_KEY = key.toString('hex');
process.env.X402_RECEIPT_STORE_PATH = path.join(dir, 'receipts.json');
process.env.X402_TTL_SECONDS = '300';
const config = loadX402Config(process.env, { mode: 'live' });
assert.equal(config.network, 'eip155:1439');
const cfg = chainConfigLib.resolveNetworkConfig(await readJson(path.join(root, 'public/chain-config.json')), 'injective-testnet');
const provider = new ethers.JsonRpcProvider('https://k8s.testnet.json-rpc.injective.network');
const buyerKey = process.env.X402_BUYER_PRIVATE_KEY || process.env.WHITE_AGENT_PRIVATE_KEY;
const buyer = new ethers.Wallet(buyerKey), role = resolveSignerKey('PAYMENT_ATTESTOR', process.env, { warn: () => {} });
assert.ok(role, 'An authorized testnet PaymentOracle signer is required');
const signer = new ethers.Wallet(role.privateKey, provider);
const oracle = new ethers.Contract(cfg.contracts.PaymentOracle, cfg.paymentOracle.abi, provider);
const erc20 = new ethers.Contract(config.asset, ['function balanceOf(address) view returns(uint256)'], provider);
const checkpointFile = path.join(dir, 'attestation.json'), baselineFile = path.join(dir, 'baseline.json');
let baseline = await readJson(baselineFile);
if (!baseline) { baseline = { payer: buyer.address, payee: config.payTo, payer_balance: String(await erc20.balanceOf(buyer.address)), payee_balance: String(await erc20.balanceOf(config.payTo)) }; await writeJsonAtomic(baselineFile, baseline, { durable: true }); }
assert.equal(baseline.payer.toLowerCase(), buyer.address.toLowerCase());
const durableOracle = {
  paymentTransactionAttested: (hash) => oracle.paymentTransactionAttested(hash),
  async attestPayment(...args) {
    const data = oracle.interface.encodeFunctionData('attestPayment', args);
    let saved = await readJson(checkpointFile);
    if (!saved) {
      const nonce = await provider.getTransactionCount(signer.address, 'pending');
      const tx = await signer.populateTransaction({ to: oracle.target, data, nonce });
      const raw = await signer.signTransaction(tx), hash = ethers.keccak256(raw);
      saved = { hash, raw: seal(key, { raw }, 'w5-public-attestation'), data };
      await writeJsonAtomic(checkpointFile, saved, { durable: true });
    }
    assert.equal(saved.data, data, 'Reconcile the original attestation before changing its report');
    let receipt = await provider.getTransactionReceipt(saved.hash);
    if (!receipt) {
      try { await provider.broadcastTransaction(unseal(key, saved.raw, 'w5-public-attestation').raw); }
      catch (error) { if (!await provider.getTransaction(saved.hash)) throw error; }
      receipt = await provider.waitForTransaction(saved.hash, 3, 120000);
    }
    assert.equal(receipt.status, 1); assert.equal((await provider.getBlock(receipt.blockNumber)).hash, receipt.blockHash);
    return { wait: async () => receipt };
  }
};
const service = X402_SERVICES.find((s) => s.serviceId === 'premium-risk');
let handlerCalls = 0;
const replayed = [];
const gateway = await createLiveGateway({ env: process.env, config, services: [service], baseUrl: 'http://127.0.0.1:4198', confirmations: 3,
  definitions: { 'premium-risk': { handler: async () => { handlerCalls++; return { kind: 'risk-intelligence', case_id: 'W5_PUBLIC_PROVIDER_SYNTHETIC_REPORT', provider: 'deterministic-research-fixture', scope: 'synthetic business report; actual public testnet payment and onchain report attestation', result: 'research acceptance only' }; } } },
  attest: (input) => recordPaymentEvidence({ ...input, oracle: durableOracle }) });
const server = http.createServer(gateway.app);
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4198, '127.0.0.1', resolve); });
  const paidFetch = createPaidFetch({ privateKey: buyerKey, rpcUrl: 'https://k8s.testnet.json-rpc.injective.network', budgetUSDC: 0.001,
    allowedNetworks: ['eip155:1439'], timeoutMs: 60000, recoveryDirectory: path.join(dir, 'client'), recoveryKey: key,
    onPayment: (event) => replayed.push(event.replayed) });
  const request = () => paidFetch(`http://127.0.0.1:4198${service.endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ case_id: 'W5_PUBLIC_PROVIDER_SYNTHETIC_REPORT', request_id: 'W5_PUBLIC_PROVIDER_20261018' }) });
  const first = await request(), report = await first.json();
  await writeJsonAtomic(path.join(root, 'docs/evidence/w5-2026-10-18/testnet/public-gateway-attempt.json'), { at: new Date().toISOString(), http_status: first.status, code: report.code, payment: report.payment, report_id: report.report_envelope?.report_id }, { durable: true });
  assert.equal(first.status, 200, report.code || 'Public gateway purchase failed');
  assert.equal(report.payment.live, true); assert.ok(await oracle.paymentTransactionAttested(report.payment.txHash));
  const second = await request(), again = await second.json(); assert.equal(second.status, 200); assert.deepEqual(again, report);
  const payerAfter = await erc20.balanceOf(buyer.address), payeeAfter = await erc20.balanceOf(config.payTo);
  assert.equal(BigInt(baseline.payer_balance) - payerAfter, 1000n); assert.equal(payeeAfter - BigInt(baseline.payee_balance), 1000n);
  const records = await gateway.runtime.settlementService.store.list();
  const receipt = records.find((r) => r.transaction?.toLowerCase() === report.payment.txHash.toLowerCase());
  assert.equal(receipt.independent_verification.verified, true);
  const result = { schema: 'agentbl-w5-public-gateway-acceptance-v1', passed: true, generated_at: new Date().toISOString(),
    scope: 'Official public testnet facilitator, canonical test USDC, production gateway/client/verification/delivery and actual PaymentOracle; deterministic synthetic report, no model quality claim',
    network: config.network, facilitator: config.facilitatorUrl, asset: config.asset, payer: buyer.address, payee: config.payTo, amount_atomic: '1000',
    payer_balance_before: baseline.payer_balance, payer_balance_after: String(payerAfter), payee_balance_before: baseline.payee_balance, payee_balance_after: String(payeeAfter),
    report, independent_verification: receipt.independent_verification, client_replays: replayed, handler_calls_this_run: handlerCalls,
    repeated_response_equal: true, payer_charged_once: true };
  await writeJsonAtomic(path.join(root, 'docs/evidence/w5-2026-10-18/testnet/public-gateway-acceptance.json'), result, { durable: true });
  console.log(JSON.stringify({ passed: true, payment_tx: report.payment.txHash, attestation_tx: report.payment.attestationTxHash, amount_atomic: '1000', repeated_response_equal: true }));
} finally { await new Promise((resolve) => server.close(resolve)); await provider.destroy(); }
