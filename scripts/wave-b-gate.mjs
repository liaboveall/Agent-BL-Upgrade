/** Gate B replay-safe operator CLI. Default: read-only, no key or .env access.
 * --confirm is required to sign. Historical wave-b-gate.json is never overwritten.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import chainConfigLib from './lib/chain-config.cjs';
import { planWaveBGate, verifyWaveBPayment, contractEvents, WaveBGateError } from '../src/chain/waveBGate.js';
import { writeJsonAtomic } from '../src/lib/jsonStore.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const safeJson = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
export const USAGE = `Usage:
  npm run verify:wave-b -- --dry-run          read-only plan; no .env or owner key read
  npm run verify:wave-b -- --confirm          explicitly sign planned transactions
  npm run verify:wave-b -- --dry-run --report <new-file.json>

Default is --dry-run. --confirm and --dry-run are mutually exclusive.
Reuses the registered cargo and its active pool. Paused/terminal pools fail before signing.
An already processed/current report is a read-only no-op; replay protection is never bypassed.
OPEN pricing may restore protected pool #2 to the report price. No new x402 payment is made.
Evidence goes to a new wave-b-attempt file; historical evidence is preserved.
Only --confirm loads local configuration and uses DEPLOYER_PRIVATE_KEY on the operator's machine.
`;

export function optionsFor(argv) {
  const { values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' }, confirm: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, report: { type: 'string' } } });
  if (values.confirm && values['dry-run']) throw new WaveBGateError('invalid_options', 'Choose --dry-run or --confirm');
  return { confirm: values.confirm === true, help: values.help === true, report: values.report };
}

function verifyStep(step, receipt, plan, chain, operator) {
  const events = contractEvents(receipt, step.address, chain.abis[step.contract]);
  const event = events.find((entry) => {
    const a = entry.args;
    if (step.method === 'mintEBLV2') return entry.name === 'EBLMintedV2' && Number(a.eblId) === plan.ebl_id && same(a.cargoHash, plan.cargo_hash) && same(a.metadataHash, step.args[1]) && same(a.holder, operator);
    if (step.method === 'pledge') return entry.name === 'EBLPledged' && Number(a.eblId) === plan.ebl_id && same(a.pool, step.args[1]) && same(a.holder, operator);
    if (step.method === 'createOffering') return entry.name === 'OfferingCreated' && Number(a.poolId) === plan.pool_id && Number(a.eblId) === plan.ebl_id
      && a.tokenSupply === BigInt(step.args[1]) && a.issuePrice === BigInt(step.args[2]) && a.targetRedemptionValue === BigInt(step.args[3]);
    return entry.name === 'PricingUpdated' && Number(a.poolId) === plan.pool_id && Number(a.issuePrice) === plan.pricing.issue_price_e6
      && Number(a.riskLevel) === plan.pricing.risk_level && Number(a.action) === plan.pricing.pricing_action
      && same(a.evidenceHash, plan.pricing.evidence_hash) && same(a.quoteHash, plan.pricing.quote_hash) && same(a.updater, operator);
  });
  if (!event || Number(receipt.status) !== 1) throw new WaveBGateError('receipt_mismatch', `Receipt for ${step.method} does not match the plan; reconcile before any further transaction`);
  return safeJson(events);
}

/** Injectable boundary for offline CLI tests. No network or key reads at import time. */
export async function run({ argv = process.argv.slice(2), env = process.env, log = console.log,
  readJson = async (file) => JSON.parse(await fs.readFile(path.join(root, file), 'utf8')),
  providerFactory = (rpc) => { const request = new ethers.FetchRequest(rpc); request.timeout = 10_000; return new ethers.JsonRpcProvider(request); },
  contractFactory = (address, abi, provider) => new ethers.Contract(address, abi, provider),
  loadEnv = async () => import('../src/env.js'), walletFactory = (key, provider) => new ethers.NonceManager(new ethers.Wallet(key, provider)) } = {}) {
  const options = optionsFor(argv);
  if (options.help) { log(USAGE); return { help: true }; }
  if (options.confirm) await loadEnv();
  const chain = chainConfigLib.resolveNetworkConfig(await readJson('public/chain-config.json'), 'injective-testnet');
  const report = await readJson('docs/evidence/x402-live-smoke.json');
  const caseData = await readJson('data/cases/copper-sg-shanghai.case.json');
  const provider = providerFactory(env.INJECTIVE_RPC_URL?.trim() || chain.rpcUrls[0]);
  let attempt = null, output = null;
  const persist = async () => { if (output) await writeJsonAtomic(output, safeJson(attempt)); };
  try {
    if (Number((await provider.getNetwork()).chainId) !== 1439) throw new WaveBGateError('wrong_network', 'RPC must be Injective testnet 1439');
    const contracts = Object.fromEntries(['EBLRegistry', 'RWAOfferingPool', 'RiskPricingOracle'].map((name) =>
      [name, contractFactory(chain.contracts[name], chain.abis[name], provider)]));
    const { EBLRegistry: registry, RWAOfferingPool: pool, RiskPricingOracle: oracle } = contracts;
    if (!same(await oracle.pool(), chain.contracts.RWAOfferingPool) || !same(await pool.eblRegistry(), chain.contracts.EBLRegistry)) {
      throw new WaveBGateError('deployment_mismatch', 'Oracle, pool and eBL registry do not refer to the configured deployment');
    }
    const proof = verifyWaveBPayment({ report, chain, paymentReceipt: await provider.getTransactionReceipt(report.payment_tx),
      attestationReceipt: await provider.getTransactionReceipt(report.attestation_tx) });
    const buildPlan = () => planWaveBGate({ caseData, report, chain, registry, pool, oracle });
    const plan = await buildPlan();
    attempt = { schema: 'agentbl-wave-b-attempt-v2', checked_at: new Date().toISOString(),
      mode: options.confirm ? 'confirm' : 'dry-run', status: plan.no_op ? 'ALREADY_CURRENT' : 'PLANNED',
      network: plan.network, payment_evidence: 'docs/evidence/x402-live-smoke.json', payment: proof, plan, transactions: [],
      historical_gate: 'docs/evidence/wave-b-gate.json', live_transactions: false };
    if (options.report || options.confirm) {
      const target = path.resolve(root, options.report ?? `docs/evidence/wave-b-attempt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Reserve a new file exclusively; neither custom paths nor retries overwrite old evidence.
      const handle = await fs.open(target, 'wx'); await handle.close(); output = target; await persist();
    }
    log(JSON.stringify(safeJson({ mode: attempt.mode, status: attempt.status, plan }), null, 2));
    if (!options.confirm || plan.no_op) {
      log(plan.no_op ? 'Gate B already matches the processed report and current on-chain quote; no transactions sent.' : 'Dry run only: no .env, signer key or transaction was used.');
      return attempt;
    }
    let signer;
    try {
      if (!env.DEPLOYER_PRIVATE_KEY?.trim()) throw new Error('missing');
      signer = walletFactory(env.DEPLOYER_PRIVATE_KEY.trim(), provider);
    } catch { throw new WaveBGateError('owner_key_unavailable', 'A valid operator DEPLOYER_PRIVATE_KEY is required for --confirm; its value is never printed'); }
    const operator = await signer.getAddress();
    if (!await oracle.isUpdater(operator)) throw new WaveBGateError('not_updater', 'Operator is not an authorized pricing updater');
    if (!plan.reused && (!same(await registry.owner(), operator) || !same(await pool.owner(), operator))) throw new WaveBGateError('not_owner', 'New mint and offering require the operator to own both contracts');
    if (JSON.stringify(safeJson(await buildPlan())) !== JSON.stringify(safeJson(plan))) throw new WaveBGateError('plan_changed', 'Pool or registry changed since the plan; review a fresh dry run');
    attempt.status = 'EXECUTING'; await persist();
    for (const step of plan.steps) {
      const contract = contracts[step.contract].connect(signer);
      // Static simulation before each send includes the current pledge/state/replay checks.
      await contract[step.method].staticCall(...step.args);
      attempt.broadcast_attempted = true; attempt.live_transactions = 'unknown'; await persist();
      const transaction = await contract[step.method](...step.args, { gasLimit: 1_000_000n, gasPrice: 500_000_000n });
      const entry = { method: step.method, contract: step.address, txHash: transaction.hash,
        explorer: `${chain.explorerBase}/tx/${transaction.hash}`, status: 'SUBMITTED' };
      attempt.transactions.push(entry); attempt.live_transactions = true; await persist();
      log(`${step.method}: ${transaction.hash}`);
      const receipt = await transaction.wait(1, 120_000);
      if (!receipt) throw new WaveBGateError('receipt_pending', 'Submitted transaction is unconfirmed; reconcile before retrying');
      entry.events = verifyStep(step, receipt, plan, chain, operator); entry.blockNumber = receipt.blockNumber; entry.status = 'CONFIRMED';
      await persist();
    }
    const final = await buildPlan();
    if (!final.no_op) throw new WaveBGateError('final_state_mismatch', 'Final chain quote does not match this report; reconcile the recorded transactions');
    attempt.status = 'COMPLETED'; attempt.final = final; await persist();
    log(`Gate B PASS; new evidence: ${output}. Historical evidence preserved.`);
    return attempt;
  } catch (error) {
    if (attempt) {
      attempt.status = attempt.broadcast_attempted ? 'RECONCILIATION_REQUIRED' : 'FAILED_BEFORE_SEND';
      attempt.error = { code: error instanceof WaveBGateError ? error.code : 'operation_failed',
        message: error instanceof WaveBGateError ? error.message : 'Operation failed; inspect the recorded transaction hashes before retrying' };
      await persist().catch(() => {});
    }
    throw error;
  } finally { provider.destroy?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error instanceof WaveBGateError ? `${error.code}: ${error.message}`
      : `Wave B failed (${error.code ?? 'operation_failed'}); no further transactions sent. Check recorded hashes before retrying.`);
    process.exitCode = 1;
  });
}
