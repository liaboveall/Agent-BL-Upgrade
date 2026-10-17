import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Interface, sha256, toUtf8Bytes } from 'ethers';
import chainConfigLib from '../scripts/lib/chain-config.cjs';
import { cargoIdentityHash, cargoIdentityPayload } from '../src/chain/cargoIdentity.js';
import { planWaveBGate, verifyWaveBPayment, gateMetadata } from '../src/chain/waveBGate.js';
import { run, optionsFor } from '../scripts/wave-b-gate.mjs';

const raw = JSON.parse(await fs.readFile(new URL('../public/chain-config.json', import.meta.url)));
const chain = chainConfigLib.resolveNetworkConfig(raw, 'injective-testnet');
const report = JSON.parse(await fs.readFile(new URL('../docs/evidence/x402-live-smoke.json', import.meta.url)));
const copper = JSON.parse(await fs.readFile(new URL('../data/cases/archive/copper-sg-shanghai-2026-06.case.json', import.meta.url)));
const owner = '0x3333333333333333333333333333333333333333';

const log = (abi, name, args, address) => ({ address, ...new Interface(abi).encodeEventLog(name, args) });
function fixture({ registered = true, state = 2n, processed = false } = {}) {
  const offering = { exists: true, eblId: 2n, issuePrice: 984700n, state, tokenSupply: 4125000n, subscribed: 0n };
  let currentEvidence = report.report_hash, currentQuote = null;
  const registry = { eblIdForCargo: async () => registered ? 2n : 0n, cargoHashOf: async () => cargoIdentityHash(copper),
    nextEblId: async () => 3n, owner: async () => owner, pledgedTo: async () => chain.contracts.RWAOfferingPool };
  const pool = { emergencyStopped: async () => false, poolOfEbl: async () => 2n, offerings: async () => offering,
    nextPoolId: async () => 3n, owner: async () => owner, eblRegistry: async () => chain.contracts.EBLRegistry };
  const oracle = { pool: async () => chain.contracts.RWAOfferingPool, isDecisionProcessed: async () => processed,
    latestEvidenceHash: async () => currentEvidence, latestQuoteHash: async () => currentQuote, isUpdater: async () => true };
  const paymentReceipt = { hash: report.payment_tx, status: 1, blockNumber: 42, logs: [
    log(['event Transfer(address indexed from,address indexed to,uint256 value)'], 'Transfer', [report.payer, report.payee, report.amount_atomic], report.asset)
  ] };
  const attestationReceipt = { hash: report.attestation_tx, status: 1, blockNumber: 43, logs: [
    log(chain.abis.PaymentOracle, 'PaymentAttested', ['0x' + '1'.repeat(64), report.report_hash, sha256(toUtf8Bytes(report.case_id)),
      report.payment_tx, report.payer, report.asset, report.amount_atomic, owner, 1791774145n], chain.contracts.PaymentOracle)
  ] };
  const input = { caseData: copper, report, chain, registry, pool, oracle };
  const plan = () => planWaveBGate(input);
  const provider = { getNetwork: async () => ({ chainId: 1439n }), getTransactionReceipt: async (hash) => hash === report.payment_tx ? paymentReceipt : attestationReceipt, destroy() {} };
  const contracts = { [chain.contracts.EBLRegistry]: registry, [chain.contracts.RWAOfferingPool]: pool, [chain.contracts.RiskPricingOracle]: oracle };
  const logs = [];
  const cli = { argv: [], env: {}, log: (value) => logs.push(value),
    readJson: async (file) => file === 'public/chain-config.json' ? raw : file.includes('x402-live') ? report : copper,
    providerFactory: () => provider, contractFactory: (address) => contracts[address],
    loadEnv: async () => { throw new Error('Dry run must not read .env'); }, walletFactory: () => { throw new Error('Dry run must not create a wallet'); } };
  return { input, plan, provider, paymentReceipt, attestationReceipt, offering, cli, logs,
    processed: (value) => { processed = value; }, registered: (value) => { registered = value; },
    latest: (evidence, quote) => { currentEvidence = evidence; currentQuote = quote; } };
}

test('cargo identity: deployed copper hash is frozen, including the legacy empty voyage and JSON key order', () => {
  assert.equal(cargoIdentityHash(copper), '0xcbb79a2dc7946a1b0db32fa57833f07d5130915393acbf4315ddc3958383ad2f');
  assert.equal(cargoIdentityPayload(copper).voyage, '');
  const altered = structuredClone(copper); altered.bill_of_lading.voyage_no = 'another';
  assert.equal(cargoIdentityHash(altered), cargoIdentityHash(copper));
  altered.bill_of_lading.voyage = 'another'; assert.notEqual(cargoIdentityHash(altered), cargoIdentityHash(copper));
  altered.bill_of_lading.voyage = undefined; altered.bill_of_lading.voyage_number = 'number';
  assert.equal(cargoIdentityPayload(altered).voyage, 'number');
});

test('Wave B plan: unregistered cargo plans mint, pledge, open and pricing without invoking any signer', async () => {
  const f = fixture({ registered: false }); const plan = await f.plan();
  assert.equal(plan.reused, false); assert.equal(plan.ebl_id, 3); assert.equal(plan.pool_id, 3);
  assert.deepEqual(plan.steps.map((step) => step.method), ['mintEBLV2', 'pledge', 'createOffering', 'updatePricing']);
  assert.equal(plan.steps[0].args[0], cargoIdentityHash(copper));
  assert.equal(plan.steps[1].args[0], '3'); assert.equal(plan.steps[2].args[0], '3');
  assert.equal(plan.steps[3].args[0], '3'); assert.equal(plan.steps[3].args[4], report.report_hash);
  assert.equal(gateMetadata(copper, report).metadata.voyage, '');
});

test('Wave B plan: registered active cargo reuses eBL/pool and only proposes pricing', async () => {
  const f = fixture(); const plan = await f.plan();
  assert.equal(plan.reused, true); assert.equal(plan.ebl_id, 2); assert.equal(plan.pool_id, 2);
  assert.deepEqual(plan.steps.map((step) => step.method), ['updatePricing']);
  assert.equal(plan.steps[0].args[2], 1); assert.equal(plan.steps[0].args[3], 0);
  assert.match(plan.steps[0].description, /restore.*pool #2/u);
});

test('Wave B plan: paused/terminal pools, wrong pledge, missing mapping and emergency stop fail before any transaction', async () => {
  for (const state of [7n, 8n, 9n, 10n, 11n, 12n]) {
    await assert.rejects(fixture({ state }).plan(), { code: 'pool_not_active' });
  }
  const f = fixture(); f.input.pool.emergencyStopped = async () => true;
  await assert.rejects(f.plan(), { code: 'emergency_stopped' });
  f.input.pool.emergencyStopped = async () => false; f.input.pool.poolOfEbl = async () => 0n;
  await assert.rejects(f.plan(), { code: 'registered_without_active_pool' });
  f.input.pool.poolOfEbl = async () => 2n; f.input.registry.pledgedTo = async () => owner;
  await assert.rejects(f.plan(), { code: 'pledge_mismatch' });
});

test('Wave B plan: already processed current quote is a no-op; a displaced commitment cannot bypass oracle replay', async () => {
  const f = fixture(); const initial = await f.plan(); f.processed(true); f.latest(report.report_hash, initial.pricing.quote_hash);
  const current = await f.plan(); assert.equal(current.no_op, true); assert.equal(current.steps.length, 0);
  f.offering.issuePrice = 982000n;
  await assert.rejects(f.plan(), { code: 'pricing_commitment_already_processed' });
  f.offering.issuePrice = 984700n; f.latest('0x' + '2'.repeat(64), initial.pricing.quote_hash);
  await assert.rejects(f.plan(), { code: 'pricing_commitment_already_processed' });
});

test('Wave B proof: only exact successful token transfer and PaymentAttested logs validate historical evidence', () => {
  const f = fixture();
  const proof = verifyWaveBPayment({ report, chain, paymentReceipt: f.paymentReceipt, attestationReceipt: f.attestationReceipt });
  assert.equal(proof.report_hash, report.report_hash); assert.equal(proof.payment_block, 42);
  for (const target of ['payment', 'attestation']) {
    const paymentReceipt = structuredClone(f.paymentReceipt), attestationReceipt = structuredClone(f.attestationReceipt);
    (target === 'payment' ? paymentReceipt : attestationReceipt).logs[0].address = owner;
    assert.throws(() => verifyWaveBPayment({ report, chain, paymentReceipt, attestationReceipt }), { code: target === 'payment' ? 'payment_transfer_mismatch' : 'attestation_mismatch' });
  }
  assert.throws(() => verifyWaveBPayment({ report, chain, paymentReceipt: { ...f.paymentReceipt, status: 0 }, attestationReceipt: f.attestationReceipt }), { code: 'invalid_receipt' });
  assert.throws(() => verifyWaveBPayment({ report: { ...report, amount_atomic: '2' }, chain, paymentReceipt: f.paymentReceipt, attestationReceipt: f.attestationReceipt }), { code: 'payment_transfer_mismatch' });
});

test('Wave B CLI: default and explicit dry-run never read .env/private keys, create a signer or send', async () => {
  for (const argv of [[], ['--dry-run']]) {
    const f = fixture();
    f.cli.env = new Proxy({}, { get: (_target, key) => { if (key === 'DEPLOYER_PRIVATE_KEY') throw new Error('Must not read a private key'); } });
    const result = await run({ ...f.cli, argv });
    assert.equal(result.mode, 'dry-run'); assert.equal(result.live_transactions, false); assert.equal(result.transactions.length, 0);
    assert.match(f.logs.at(-1), /no .env, signer key or transaction/u);
  }
  assert.deepEqual(optionsFor([]), { confirm: false, help: false, report: undefined });
  assert.throws(() => optionsFor(['--dry-run', '--confirm']), { code: 'invalid_options' });
  const result = await run({ argv: ['--help'], log() {}, readJson: async () => { throw new Error('Help should not access files'); } });
  assert.equal(result.help, true);
});

test('Wave B CLI: only fresh evidence paths are written; an existing historical file cannot be overwritten on failure', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave-b-gate-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'attempt.json'); const f = fixture();
  await run({ ...f.cli, argv: ['--dry-run', '--report', file] });
  const first = await fs.readFile(file, 'utf8'); assert.equal(JSON.parse(first).status, 'PLANNED');
  await assert.rejects(run({ ...f.cli, argv: ['--dry-run', '--report', file] }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(file, 'utf8'), first);
});

test('Wave B CLI: wrong network or cross-deployment contract links fail before planning', async () => {
  const f = fixture(); f.provider.getNetwork = async () => ({ chainId: 1n });
  await assert.rejects(run(f.cli), { code: 'wrong_network' });
  f.provider.getNetwork = async () => ({ chainId: 1439n }); f.input.oracle.pool = async () => owner;
  await assert.rejects(run(f.cli), { code: 'deployment_mismatch' });
});

test('Wave B CLI: explicit confirmation with an already current commitment does not need or construct a signer', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave-b-current-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = fixture(); const plan = await f.plan(); f.latest(report.report_hash, plan.pricing.quote_hash); f.processed(true);
  let loads = 0;
  const result = await run({ ...f.cli, argv: ['--confirm', '--report', path.join(dir, 'current.json')], loadEnv: async () => { loads += 1; } });
  assert.equal(result.status, 'ALREADY_CURRENT'); assert.equal(result.live_transactions, false); assert.equal(loads, 1);
});

async function confirmFixture(t, { registered = true, failure, changes } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wave-b-confirm-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'attempt.json');
  const f = fixture({ registered });
  const plan = await f.plan(); let sends = 0, simulations = 0, keyReads = 0;
  const names = { EBLRegistry: f.input.registry, RWAOfferingPool: f.input.pool, RiskPricingOracle: f.input.oracle };
  for (const contract of Object.values(names)) contract.connect = () => contract;
  for (const step of plan.steps) {
    const contract = names[step.contract];
    contract[step.method] = Object.assign(async (...values) => {
      sends += 1;
      if (failure === 'broadcast') throw new Error('unconfirmed broadcast result');
      assert.deepEqual(values.slice(0, -1), step.args);
      const hash = '0x' + String(sends).repeat(64);
      return { hash, wait: async () => {
        if (failure === 'timeout') return null;
        let eventName, eventArgs;
        if (step.method === 'mintEBLV2') {
          eventName = 'EBLMintedV2'; eventArgs = [plan.ebl_id, plan.cargo_hash, step.args[1], owner];
          f.registered(true); f.input.registry.eblIdForCargo = async () => BigInt(plan.ebl_id); f.offering.eblId = BigInt(plan.ebl_id);
        } else if (step.method === 'pledge') {
          eventName = 'EBLPledged'; eventArgs = [plan.ebl_id, chain.contracts.RWAOfferingPool, owner];
        } else if (step.method === 'createOffering' || step.method === 'createOfferingWithTerms') {
          eventName = 'OfferingCreated'; eventArgs = [plan.pool_id, plan.ebl_id, step.args[1], step.args[2], step.args[3]];
          f.input.pool.poolOfEbl = async () => BigInt(plan.pool_id);
        } else {
          eventName = 'PricingUpdated'; eventArgs = [...step.args.slice(0, 6), owner];
          f.processed(true); f.latest(report.report_hash, plan.pricing.quote_hash);
        }
        const eventLog = log(chain.abis[step.contract], eventName, eventArgs, failure === 'mismatch' ? owner : step.address);
        return { hash, status: failure === 'revert' ? 0 : 1, blockNumber: 60 + sends, logs: [eventLog] };
      } };
    }, { staticCall: async () => { simulations += 1; if (failure === 'static') throw new Error('static revert'); } });
  }
  const options = { ...f.cli, argv: ['--confirm', '--report', file], env: { DEPLOYER_PRIVATE_KEY: 'fake-private-test-value' },
    loadEnv: async () => {}, walletFactory: (value) => { assert.equal(value, 'fake-private-test-value'); keyReads += 1;
      changes?.(f); return { getAddress: async () => owner }; } };
  return { ...f, options, file, counts: () => ({ sends, simulations, keyReads }) };
}

test('Wave B CLI: explicit confirmation creates the new lifecycle or only reprices the reused pool; receipts and final chain state are verified', async (t) => {
  for (const registered of [true, false]) {
    const f = await confirmFixture(t, { registered }); const result = await run(f.options);
    assert.equal(result.status, 'COMPLETED'); assert.equal(result.final.no_op, true); assert.equal(result.live_transactions, true);
    assert.equal(result.transactions.length, registered ? 1 : 4);
    assert.ok(result.transactions.every((entry) => entry.status === 'CONFIRMED'));
    assert.doesNotMatch(JSON.stringify(result) + f.logs.join('\n'), /fake-private-test-value/u);
    const saved = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(saved.status, 'COMPLETED');
    assert.equal(saved.final.ebl_id, registered ? 2 : 3);
  }
});

test('Wave B CLI: static failures, bad receipts and uncertain broadcasts retain evidence and never send a second transaction', async (t) => {
  for (const failure of ['static', 'broadcast', 'timeout', 'mismatch', 'revert']) {
    const f = await confirmFixture(t, { failure, registered: false });
    await assert.rejects(run(f.options));
    const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
    assert.equal(saved.status, failure === 'static' ? 'FAILED_BEFORE_SEND' : 'RECONCILIATION_REQUIRED', failure);
    assert.equal(f.counts().sends, failure === 'static' ? 0 : 1);
    if (failure === 'broadcast') assert.equal(saved.live_transactions, 'unknown');
    if (['timeout', 'mismatch', 'revert'].includes(failure)) assert.match(saved.transactions[0].txHash, /^0x[0-9a-f]{64}$/u);
  }
});

test('Wave B CLI: updater authorization and a changed preflight plan block before broadcast', async (t) => {
  const unauthorized = await confirmFixture(t, { changes: (f) => { f.input.oracle.isUpdater = async () => false; } });
  await assert.rejects(run(unauthorized.options), { code: 'not_updater' }); assert.equal(unauthorized.counts().sends, 0);
  const changed = await confirmFixture(t, { changes: (f) => { f.offering.issuePrice = 790000n; } });
  await assert.rejects(run(changed.options), { code: 'plan_changed' }); assert.equal(changed.counts().sends, 0);
  const missingKey = await confirmFixture(t); missingKey.options.env = {};
  await assert.rejects(run(missingKey.options), { code: 'owner_key_unavailable' }); assert.equal(missingKey.counts().sends, 0);
});
