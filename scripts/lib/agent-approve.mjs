// The operator-side half of the approval flow (docs/agent-implementation-plan.md WP1.3, D2/D3).
//
// The web server never holds the contract-owner key. When an approved action needs the owner to
// sign, the server publishes the exact transactions (contract, method, arguments). This tool runs on
// the operator's own machine:
//   1. fetch the plan from the server and print it;
//   2. dry-run it (staticCall with the owner key) -- the default;
//   3. with --confirm, sign and send each step, wait for it, and report the hash back so the server
//      can check it against the chain before marking anything done.
//
// It reads DEPLOYER_PRIVATE_KEY only from the environment, never prints or sends it, and refuses to
// touch a protected pool with a terminal action even when asked.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chainConfigLib from './chain-config.cjs';
import { OPENING_SCHEMA, resolveOwnerStep, validateOpeningStep } from '../../src/agent/runtime/openingPlan.js';
import { runtimeDir } from '../../src/runtimePaths.js';
import { createOwnerJournal } from './owner-journal.mjs';
import { SETTLEMENT_SCHEMA, validateSettlementStep } from '../../src/agent/pipelines/settlementPipeline.js';
import { loadAgentConfig } from '../../src/agent/runtime/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Owner-signed methods that end an offering; refused for protected pools. */
const TERMINAL_METHODS = new Set(['settle', 'cancelOffering']);

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv) {
  const args = { list: false, confirm: false, help: false, id: null, server: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') args.list = true;
    else if (arg === '--confirm') args.confirm = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--id') args.id = argv[++i] ?? null;
    else if (arg.startsWith('--id=')) args.id = arg.slice(5);
    else if (arg === '--server') args.server = argv[++i] ?? null;
    else if (arg.startsWith('--server=')) args.server = arg.slice(9);
    else if (arg === '--step') args.step = Number(argv[++i]);
    else if (arg.startsWith('--step=')) args.step = Number(arg.slice(7));
    else if (arg === '--attach-tx') {
      args.txHash = argv[++i];
      if (!args.txHash) throw new CliError('--attach-tx requires a transaction hash', 2);
    }
    else if (arg.startsWith('--attach-tx=')) args.txHash = arg.slice(12);
    else throw new CliError(`Unknown argument: ${arg}`, 2);
  }
  if (args.step !== undefined && (!Number.isSafeInteger(args.step) || args.step < 0)) throw new CliError('--step must be a non-negative integer', 2);
  if (args.txHash !== undefined && (!/^0x[0-9a-fA-F]{64}$/u.test(args.txHash) || args.step === undefined || !args.id)) throw new CliError('--attach-tx requires a 32-byte transaction hash, --id and --step', 2);
  return args;
}

export const USAGE = `Usage:
  npm run agent:approve -- --list
  npm run agent:approve -- --id <approval_id>              dry run: show the plan and preflight it
  npm run agent:approve -- --id <approval_id> --confirm    sign with the owner key, send, report back
  npm run agent:approve -- --id <approval_id> --step 0 --confirm  authorize ONE opening transaction
  npm run agent:approve -- --id <approval_id> --step 0 --attach-tx <tx_hash>  reconcile a broadcast; sends nothing

Environment:
  AGENTBL_URL            server base URL (default http://127.0.0.1:3000)
  AGENTBL_ADMIN_TOKEN    admin token of the server
  DEPLOYER_PRIVATE_KEY   the contract OWNER key, read here only, never printed or sent
  INJECTIVE_RPC_URL      optional RPC override
  AGENT_PROTECTED_CHAIN_POOLS  pools that refuse terminal actions (default 2)
`;

function protectedPools(env) {
  if (env.AGENT_PROTECTED_CHAIN_POOLS === undefined) return [2];
  return String(env.AGENT_PROTECTED_CHAIN_POOLS).split(',').map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
}

async function call(fetchFn, base, token, method, pathname, body) {
  const response = await fetchFn(`${base}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!response.ok) {
    throw new CliError(`${method} ${pathname} -> ${response.status} ${data?.code ?? ''} ${data?.error ?? text}`.trim());
  }
  return data;
}

/** The signer + contracts for a plan, built from the owner key in the environment. */
export async function createDefaultSigner({ env, plan }) {
  const key = String(env.DEPLOYER_PRIVATE_KEY ?? '').trim();
  if (!key) return null;
  const { ethers } = await import('ethers');
  const raw = JSON.parse(readFileSync(path.join(here, '../../public/chain-config.json'), 'utf8'));
  const network = chainConfigLib.resolveNetworkConfig(raw, 'injective-testnet');
  if (Number(plan.chain_id) !== Number(network.chainIdDecimal)) {
    throw new CliError(`The plan is for chain ${plan.chain_id}, this tool only signs for ${network.network} (${network.chainIdDecimal})`);
  }
  const provider = new ethers.JsonRpcProvider(env.INJECTIVE_RPC_URL ?? network.rpcUrls[0], Number(network.chainIdDecimal), { staticNetwork: true });
  if (Number(await provider.send('eth_chainId', [])) !== Number(plan.chain_id)) throw new CliError('RPC is connected to the wrong chain');
  const allowed = {
    EBLRegistry: new Set(['mintEBLV2', 'pledge']),
    RWAOfferingPool: new Set(['createOffering', 'markInTransit', 'recordImporterPayment', 'recordCargoArrival', 'settle', 'cancelOffering'])
  };
  for (const step of plan.steps) {
    if (!allowed[step.contract]?.has(step.method) || String(step.address).toLowerCase() !== String(network.contracts[step.contract]).toLowerCase()) {
      throw new CliError('The plan contains an unsupported method or a contract address outside the local deployment registry');
    }
    if (['recordImporterPayment', 'recordCargoArrival', 'settle'].includes(step.method) && plan.schema !== SETTLEMENT_SCHEMA) {
      throw new CliError('Settlement requires a verified USDC settlement plan; recreate legacy proposals after receipt verification');
    }
  }
  const wallet = new ethers.Wallet(key, provider);
  const registry = new ethers.Contract(network.contracts.EBLRegistry, network.abis.EBLRegistry, provider);
  const pool = new ethers.Contract(network.contracts.RWAOfferingPool, network.abis.RWAOfferingPool, provider);
  return {
    address: wallet.address,
    validateStep: (step, activePlan) => activePlan.schema === SETTLEMENT_SCHEMA
      ? validateSettlementStep({ plan: activePlan, context: { provider, pool }, chainConfig: network,
        recipient: loadAgentConfig(env).settlementRecipient, confirmations: loadAgentConfig(env).chainConfirmations })
      : validateOpeningStep({ plan: activePlan, step, registry, pool, poolAddress: network.contracts.RWAOfferingPool }),
    contractFor(step) {
      const abi = network.abis?.[step.contract];
      if (!abi) throw new CliError(`No ABI for ${step.contract} in chain-config.json`);
      return new ethers.Contract(step.address, abi, wallet);
    }
  };
}

function describeStep(step) {
  return `  step ${step.index}: ${step.contract}.${step.method}(${step.args.map((arg) => arg?.ref ? `<verified ${arg.ref}>` : typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(', ')})\n    at ${step.address}\n    ${step.description}`;
}

/**
 * @param {object} options
 * @param {string[]} options.argv
 * @param {NodeJS.ProcessEnv} options.env
 * @param {typeof fetch} [options.fetchFn]
 * @param {(input:{env:object, plan:object}) => Promise<object|null>} [options.createSigner]
 * @param {(line:string) => void} [options.log]
 * @returns {Promise<number>} exit code
 */
export async function run({ argv, env, fetchFn = fetch, createSigner = createDefaultSigner, journal, log = console.log }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    log(error.message);
    log(USAGE);
    return error.exitCode ?? 2;
  }
  if (args.help || (!args.list && !args.id)) {
    log(USAGE);
    return args.help ? 0 : 2;
  }
  const base = String(args.server ?? env.AGENTBL_URL ?? 'http://127.0.0.1:3000').replace(/\/$/u, '');
  const token = env.AGENTBL_ADMIN_TOKEN;

  try {
    if (args.list) {
      const { approvals } = await call(fetchFn, base, token, 'GET', '/api/agent/approvals?status=AWAITING_OWNER_SIGNATURE');
      if (!approvals.length) {
        log('No approvals are waiting for an owner signature.');
        return 0;
      }
      for (const approval of approvals) {
        log(`${approval.approval_id}  ${approval.action}  pool ${approval.pool_id}  expires ${approval.expires_at}`);
        log(`  ${approval.summary ?? ''}`);
      }
      return 0;
    }

    const { approval, decision } = await call(fetchFn, base, token, 'GET', `/api/agent/approvals/${encodeURIComponent(args.id)}`);
    if (args.txHash) {
      const result = await call(fetchFn, base, token, 'POST', `/api/agent/approvals/${encodeURIComponent(args.id)}/attach-tx`, { tx_hash: args.txHash, step_index: args.step });
      log(`Server verified step ${args.step}: ${result.complete ? 'approval complete' : 'more steps to go'}. No transaction sent.`);
      return 0;
    }
    if (approval.status !== 'AWAITING_OWNER_SIGNATURE') {
      throw new CliError(`Approval ${approval.approval_id} is ${approval.status}; only AWAITING_OWNER_SIGNATURE can be signed.`);
    }
    const plan = approval.plan;
    if (!plan?.steps?.length) throw new CliError('The approval has no transactions to sign.');
    log(`Approval ${approval.approval_id}: ${approval.action} for ${approval.case_id} (decision ${decision?.decision_id ?? approval.decision_id})`);
    log(`Network: ${plan.network} (chain ${plan.chain_id}), ${plan.steps.length} transaction(s)`);
    for (const step of plan.steps) log(describeStep(step));
    const opening = plan.schema === OPENING_SCHEMA;
    const contextual = opening || plan.schema === SETTLEMENT_SCHEMA;
    if (opening && args.confirm && args.step === undefined) throw new CliError('Opening requires separate authorization for each transaction: choose --step 0, 1 or 2 with --confirm');
    if (contextual && Date.parse(approval.expires_at) <= Date.now()) throw new CliError('This approval expired; no transaction will be sent');

    // A protected pool never receives a terminal action, whatever the server says.
    const guarded = protectedPools(env);
    for (const step of plan.steps) {
      if (TERMINAL_METHODS.has(step.method) && guarded.includes(Number(step.args[0]))) {
        throw new CliError(`Refusing ${step.method} on protected pool #${step.args[0]} (AGENT_PROTECTED_CHAIN_POOLS).`);
      }
    }

    const done = new Set((approval.steps_done ?? []).map((step) => step.index));
    let pending = plan.steps.filter((step) => !done.has(step.index));
    if (args.step !== undefined) {
      if (!pending.some((step) => step.index === args.step)) throw new CliError('The selected step is missing or already verified');
      if (pending[0].index !== args.step) throw new CliError(`Step ${pending[0].index} must complete before step ${args.step}`);
      pending = pending.filter((step) => step.index === args.step);
    } else if (opening) pending = pending.slice(0, 1);
    const activeJournal = journal ?? (createSigner === createDefaultSigner ? createOwnerJournal(runtimeDir(env)) : null);
    const perform = async () => {
      // A previous send can be reconciled without accessing an owner key or sending again.
      for (const step of pending) {
        const checkpoint = await activeJournal?.read(approval.approval_id, step.index);
        if (!checkpoint) continue;
        if (!checkpoint.tx_hash) throw new CliError(`Step ${step.index} has an uncertain broadcast. Reconcile it on-chain before any retry.`);
        if (!args.confirm) { log(`Step ${step.index} has broadcast ${checkpoint.tx_hash}; reconcile with --attach-tx. No transaction sent.`); return 0; }
        const result = await call(fetchFn, base, token, 'POST', `/api/agent/approvals/${encodeURIComponent(args.id)}/attach-tx`, { tx_hash: checkpoint.tx_hash, step_index: step.index });
        await activeJournal.write(approval.approval_id, step.index, { ...checkpoint, status: 'ATTACHED' });
        log(`Recovered broadcast step ${step.index}: ${result.complete ? 'approval complete' : 'more steps to go'}. No transaction sent.`);
        return 0;
      }
      const signer = await createSigner({ env, plan });
      if (!signer) {
        log('\nDEPLOYER_PRIVATE_KEY is not set, so nothing can be preflighted or signed here.');
        log('Set it in this shell only (never on the server) and run again.');
        return args.confirm ? 1 : 0;
      }
      log(`\nSigner: ${signer.address}`);
      for (const template of pending) {
        const step = resolveOwnerStep(plan, template);
        const contract = signer.contractFor(step);
        const owner = await contract.owner?.();
        if (owner && String(owner).toLowerCase() !== signer.address.toLowerCase()) {
          throw new CliError(`This key (${signer.address}) is not the contract owner (${owner}); it cannot sign step ${step.index}.`);
        }
        try {
          await signer.validateStep?.(step, plan);
          await contract[step.method].staticCall(...step.args);
        } catch (error) {
          throw new CliError(`Preflight failed for step ${step.index}: the contract would reject it (${error?.reason ?? error?.shortMessage ?? error?.message}).`);
        }
        log(`  step ${step.index}: preflight OK`);
        if (!args.confirm) continue;
        const fresh = await call(fetchFn, base, token, 'GET', `/api/agent/approvals/${encodeURIComponent(args.id)}`);
        if (fresh.approval.status !== 'AWAITING_OWNER_SIGNATURE'
          || JSON.stringify(fresh.approval.plan) !== JSON.stringify(plan)
          || contextual && Date.parse(fresh.approval.expires_at) <= Date.now()) throw new CliError('Approval changed or expired after preflight; nothing was sent');
        if (contextual) {
          const status = await call(fetchFn, base, token, 'GET', '/api/agent/status');
          if (status.mode !== 'live' || status.generation !== fresh.decision?.generation || status.emergency_stop) throw new CliError('Runtime mode, generation or emergency stop changed; nothing was sent');
          await signer.validateStep?.(step, plan);
        }
        await activeJournal?.write(approval.approval_id, step.index, { status: 'SENDING', method: step.method, address: step.address });
        log(`\nSending step ${step.index} (${step.method})...`);
        const tx = await contract[step.method](...step.args);
        await activeJournal?.write(approval.approval_id, step.index, { status: 'SUBMITTED', tx_hash: tx.hash });
        log(`  tx ${tx.hash}`);
        const receipt = await tx.wait(plan.schema === SETTLEMENT_SCHEMA ? loadAgentConfig(env).chainConfirmations : 1);
        if (!receipt || receipt.status !== 1) throw new CliError(`Step ${step.index} was mined but reverted (${tx.hash}).`);
        const reply = await call(fetchFn, base, token, 'POST', `/api/agent/approvals/${encodeURIComponent(approval.approval_id)}/attach-tx`, { tx_hash: tx.hash, step_index: step.index });
        await activeJournal?.write(approval.approval_id, step.index, { status: 'ATTACHED', tx_hash: tx.hash });
        log(`  server verified step ${step.index}: ${reply.complete ? 'approval complete' : 'more steps to go'}`);
      }
      log(args.confirm ? '\nDone.' : '\nDry run only. Add --confirm to sign and send.');
      if (opening && pending.at(-1)?.index < 2) log(`Next step ${pending.at(-1).index + 1} requires a new dry run and separate --confirm authorization.`);
      return 0;
    };
    return args.confirm && activeJournal?.withLock ? await activeJournal.withLock(approval.approval_id, perform) : await perform();
  } catch (error) {
    log(error instanceof CliError ? error.message : `Unexpected error: ${error?.message ?? error}`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}
