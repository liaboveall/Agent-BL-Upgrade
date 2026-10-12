import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import {
  SIGNER_ROLES,
  resetSignerKeyWarnings,
  resolveSignerKey,
  signerKeyRequirement
} from '../src/chain/signerKeys.js';
import { createPaidReportEnvelope } from '../src/x402/paidReport.js';
import {
  PaymentSettlementError,
  recordPaymentEvidence,
  setPaymentOracleOverride,
  usdcToAtomic
} from '../src/x402/settlement.js';
import { readMcpResource } from '../src/mcp/resources.js';
import { runtimeDir, runtimePath } from '../src/runtimePaths.js';
import { loadX402Config } from '../src/x402/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAYER = '0x3333333333333333333333333333333333333333';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const ASSET = '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d';
const PAYMENT_TX = `0x${'ab'.repeat(32)}`;
const ATTEST_TX = `0x${'cd'.repeat(32)}`;

function envelope(overrides = {}) {
  return createPaidReportEnvelope({
    kind: 'risk-intelligence',
    case_id: 'CASE-HARDENING',
    payer: PAYER,
    payee: PAY_TO,
    network: 'eip155:1439',
    asset: ASSET,
    amount: '1000',
    payment_tx: PAYMENT_TX,
    settled_at: new Date().toISOString(),
    data_snapshot: { risk_level: 'LOW' },
    model_provider: 'unit-test',
    evidence_hash: `0x${'ef'.repeat(32)}`,
    ...overrides
  });
}

function fakeOracle({ attested = false, failWith } = {}) {
  const oracle = {
    attempts: [],
    async paymentTransactionAttested() { return attested; },
    async attestPayment(...args) {
      oracle.attempts.push(args);
      if (failWith) throw failWith;
      return { wait: async () => ({ hash: ATTEST_TX, blockNumber: 77 }) };
    }
  };
  return oracle;
}

async function withDemoMode(mode, run) {
  const previous = process.env.DEMO_MODE;
  process.env.DEMO_MODE = mode;
  try { return await run(); } finally {
    if (previous === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = previous;
  }
}

test('usdcToAtomic rounds instead of truncating', () => {
  assert.equal(usdcToAtomic(0.001), 1000n);
  assert.equal(usdcToAtomic(0.0015), 1500n);
  assert.equal(usdcToAtomic(0.002), 2000n);
  // Math.floor(price * 1e6) loses an atomic unit for prices like these; rounding does not.
  for (const [price, atomic] of [[0.000249, 249n], [0.000251, 251n], [0.000489, 489n]]) {
    assert.equal(Math.floor(price * 1_000_000), Number(atomic) - 1, `floor() under-counts ${price}`);
    assert.equal(usdcToAtomic(price), atomic);
  }
  assert.equal(usdcToAtomic(1), 1_000_000n);
});

test('resolveSignerKey prefers the dedicated key and only falls back (loudly, once) to the owner key', () => {
  resetSignerKeyWarnings();
  const warnings = [];
  const warn = (message) => warnings.push(message);
  const dedicated = { PAYMENT_ATTESTOR_PRIVATE_KEY: ' 0xattestor ', DEPLOYER_PRIVATE_KEY: '0xowner' };
  assert.deepEqual(resolveSignerKey('PAYMENT_ATTESTOR', dedicated, { warn }),
    { privateKey: '0xattestor', source: 'PAYMENT_ATTESTOR_PRIVATE_KEY', dedicated: true });
  assert.equal(warnings.length, 0, 'no warning when the dedicated key is configured');

  const ownerOnly = { DEPLOYER_PRIVATE_KEY: '0xowner' };
  assert.deepEqual(resolveSignerKey('PAYMENT_ATTESTOR', ownerOnly, { warn }),
    { privateKey: '0xowner', source: 'DEPLOYER_PRIVATE_KEY', dedicated: false });
  resolveSignerKey('PAYMENT_ATTESTOR', ownerOnly, { warn });
  assert.equal(warnings.length, 1, 'the fallback warning is printed once per role');
  assert.match(warnings[0], /contract OWNER key/u);
  assert.match(warnings[0], /setAttestor/u);
  resolveSignerKey('PRICING_UPDATER', ownerOnly, { warn });
  assert.equal(warnings.length, 2, 'each role warns separately');

  assert.equal(resolveSignerKey('PAYMENT_ATTESTOR', {}, { warn }), null);
  assert.equal(resolveSignerKey('PAYMENT_ATTESTOR', { ...ownerOnly, SIGNER_KEYS_STRICT: 'true' }, { warn }), null,
    'strict mode forbids the owner-key fallback');
  assert.deepEqual(resolveSignerKey('PAYMENT_ATTESTOR', { SIGNER_KEYS_STRICT: 'true', PAYMENT_ATTESTOR_PRIVATE_KEY: '0xa' }, { warn }).dedicated, true);
  assert.throws(() => resolveSignerKey('SOMETHING_ELSE', {}), /Unknown signer role/u);
  assert.match(signerKeyRequirement('PRICING_UPDATER'), /PRICING_UPDATER_PRIVATE_KEY.*setUpdater/u);
  // AGENT_EXECUTOR is the optional, never-owner-fallback role of the agent runtime (plan D2).
  assert.deepEqual(Object.keys(SIGNER_ROLES).sort(), ['AGENT_EXECUTOR', 'PAYMENT_ATTESTOR', 'PRICING_UPDATER']);
});

test('recordPaymentEvidence: Demo mode returns a clearly simulated receipt', async () => {
  await withDemoMode('true', async () => {
    const { payment } = await recordPaymentEvidence({ serviceId: 'premium-risk', amountUSDC: 0.001, payer: PAYER, responseData: { a: 1 } });
    assert.equal(payment.live, false);
    assert.equal(payment.onchain, false);
    assert.equal(payment.mode, 'demo');
    assert.equal(payment.onChainEvent, null);
    assert.match(payment.txHash, /^0x[0-9a-f]{64}$/u);
  });
});

test('recordPaymentEvidence: Live mode fails closed instead of degrading to a fake receipt', async () => {
  await withDemoMode('false', async () => {
    setPaymentOracleOverride(null);
    // Previously: no envelope in Live mode silently produced a simulated receipt ("HACKATHON FIX").
    await assert.rejects(
      recordPaymentEvidence({ serviceId: 'premium-risk', amountUSDC: 0.001, payer: PAYER }),
      (error) => error instanceof PaymentSettlementError && error.code === 'paid_report_required'
    );
    await assert.rejects(
      recordPaymentEvidence({ serviceId: 'premium-risk', amountUSDC: 0.001, payer: PAYER, reportEnvelope: envelope(), paymentTxHash: 'demo://receipt/not-a-hash' }),
      (error) => error.code === 'payment_tx_invalid'
    );

    const saved = { a: process.env.PAYMENT_ATTESTOR_PRIVATE_KEY, d: process.env.DEPLOYER_PRIVATE_KEY };
    delete process.env.PAYMENT_ATTESTOR_PRIVATE_KEY;
    delete process.env.DEPLOYER_PRIVATE_KEY;
    try {
      await assert.rejects(
        recordPaymentEvidence({ serviceId: 'premium-risk', amountUSDC: 0.001, payer: PAYER, reportEnvelope: envelope(), paymentTxHash: PAYMENT_TX }),
        (error) => error.code === 'payment_oracle_unavailable' && /PAYMENT_ATTESTOR_PRIVATE_KEY/u.test(error.message)
      );
    } finally {
      if (saved.a !== undefined) process.env.PAYMENT_ATTESTOR_PRIVATE_KEY = saved.a;
      if (saved.d !== undefined) process.env.DEPLOYER_PRIVATE_KEY = saved.d;
    }
  });
});

test('recordPaymentEvidence: Live attestation writes the PaymentOracle once and is idempotent on retry', async () => {
  await withDemoMode('false', async () => {
    const report = envelope();
    const oracle = fakeOracle();
    const first = await recordPaymentEvidence({
      serviceId: 'premium-risk', amountUSDC: 0.001, payer: PAYER, reportEnvelope: report, paymentTxHash: PAYMENT_TX, oracle
    });
    assert.equal(first.payment.live, true);
    assert.equal(first.payment.onchain, true);
    assert.equal(first.payment.attestation, 'recorded');
    assert.equal(first.payment.attestationTxHash, ATTEST_TX);
    assert.equal(first.payment.onChainEvent, 'PaymentAttested');
    assert.equal(oracle.attempts.length, 1);
    const [receiptId, reportHash, caseIdHash, paymentTx, payer, asset, amount] = oracle.attempts[0];
    assert.equal(receiptId, `0x${report.report_id.slice(4)}`);
    assert.equal(reportHash, report.report_hash);
    assert.equal(caseIdHash, `0x${crypto.createHash('sha256').update('CASE-HARDENING').digest('hex')}`);
    assert.equal(paymentTx, PAYMENT_TX);
    assert.equal(payer.toLowerCase(), PAYER);
    assert.equal(asset.toLowerCase(), ASSET.toLowerCase());
    assert.equal(amount, 1000n);

    const alreadyRecorded = fakeOracle({ attested: true });
    const retry = await recordPaymentEvidence({
      serviceId: 'premium-risk', amountUSDC: 0.001, payer: PAYER, reportEnvelope: report, paymentTxHash: PAYMENT_TX, oracle: alreadyRecorded
    });
    assert.equal(retry.payment.attestation, 'already_recorded');
    assert.equal(retry.payment.attestationTxHash, null);
    assert.equal(alreadyRecorded.attempts.length, 0, 'a payment that is already attested must not be written again');
  });
});

test('recordPaymentEvidence: Live attestation rejects a payer mismatch and wraps chain failures', async () => {
  await withDemoMode('false', async () => {
    const report = envelope();
    await assert.rejects(
      recordPaymentEvidence({
        serviceId: 'premium-risk', amountUSDC: 0.001, payer: '0x4444444444444444444444444444444444444444',
        reportEnvelope: report, paymentTxHash: PAYMENT_TX, oracle: fakeOracle()
      }),
      (error) => error.code === 'payment_payer_mismatch'
    );
    await assert.rejects(
      recordPaymentEvidence({
        serviceId: 'premium-risk', amountUSDC: 0.001, payer: PAYER, reportEnvelope: report, paymentTxHash: PAYMENT_TX,
        oracle: fakeOracle({ failWith: new Error('execution reverted: DuplicateReceipt') })
      }),
      (error) => error instanceof PaymentSettlementError && error.code === 'payment_oracle_write_failed' && /DuplicateReceipt/u.test(error.message)
    );
    // The envelope is validated before anything touches the chain.
    const oracle = fakeOracle();
    await assert.rejects(
      recordPaymentEvidence({
        serviceId: 'premium-risk', amountUSDC: 0.001, payer: PAYER, reportEnvelope: { ...report, report_hash: 'tampered' }, paymentTxHash: PAYMENT_TX, oracle
      }),
      (error) => error.code === 'paid_report_invalid' && !(error instanceof PaymentSettlementError)
    );
    assert.equal(oracle.attempts.length, 0);
  });
});

test('runtime state lives under the project root regardless of the working directory', async () => {
  assert.equal(runtimeDir({}), path.join(root, 'data', 'runtime'));
  assert.equal(runtimePath('x.json', {}), path.join(root, 'data', 'runtime', 'x.json'));
  assert.equal(runtimeDir({ AGENTBL_RUNTIME_DIR: path.join(os.tmpdir(), 'agentbl-rt') }), path.join(os.tmpdir(), 'agentbl-rt'));
  assert.equal(runtimeDir({ AGENTBL_RUNTIME_DIR: '   ' }), path.join(root, 'data', 'runtime'), 'blank override is ignored');

  // The old code used path.resolve('data/runtime/...'): a different cwd moved the stores.
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-cwd-'));
  try {
    const probe = `
      import { runtimeDir } from ${JSON.stringify(new URL('../src/runtimePaths.js', import.meta.url).href)};
      import { loadX402Config } from ${JSON.stringify(new URL('../src/x402/config.js', import.meta.url).href)};
      console.log(JSON.stringify({ dir: runtimeDir({}), receipts: loadX402Config({}).receiptStorePath }));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: elsewhere, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.dir, path.join(root, 'data', 'runtime'));
    assert.equal(out.receipts, path.join(root, 'data', 'runtime', 'x402-receipts.json'));
  } finally {
    await fs.rm(elsewhere, { recursive: true, force: true });
  }
  assert.equal(loadX402Config({ AGENTBL_RUNTIME_DIR: os.tmpdir() }).receiptStorePath, path.join(os.tmpdir(), 'x402-receipts.json'));
});

test('the deployments MCP resource survives a missing docs/ folder (not shipped in the container image)', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-no-evidence-'));
  const previous = process.env.AGENTBL_EVIDENCE_DIR;
  process.env.AGENTBL_EVIDENCE_DIR = empty;
  try {
    const result = await readMcpResource('agentbl://contracts/deployments');
    const evidence = JSON.parse(result.contents[0].text);
    assert.equal(evidence.latestPaidPricingProof, null);
    assert.ok(Object.keys(evidence.contracts).length > 0, 'the rest of the resource is still served');
  } finally {
    if (previous === undefined) delete process.env.AGENTBL_EVIDENCE_DIR; else process.env.AGENTBL_EVIDENCE_DIR = previous;
    await fs.rm(empty, { recursive: true, force: true });
  }
  const withEvidence = JSON.parse((await readMcpResource('agentbl://contracts/deployments')).contents[0].text);
  assert.ok(withEvidence.latestPaidPricingProof, 'the repository evidence is used when present');
});

test('a Wallet-derived payer round-trips through the envelope as a valid address', () => {
  const wallet = Wallet.createRandom();
  const built = envelope({ payer: wallet.address });
  assert.equal(built.payer.toLowerCase(), wallet.address.toLowerCase());
});
