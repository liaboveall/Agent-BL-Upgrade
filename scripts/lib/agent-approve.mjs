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
    else throw new CliError(`Unknown argument: ${arg}`, 2);
  }
  return args;
}

export const USAGE = `Usage:
  npm run agent:approve -- --list
  npm run agent:approve -- --id <approval_id>              dry run: show the plan and preflight it
  npm run agent:approve -- --id <approval_id> --confirm    sign with the owner key, send, report back

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
  const wallet = new ethers.Wallet(key, provider);
  return {
    address: wallet.address,
    contractFor(step) {
      const abi = network.abis?.[step.contract];
      if (!abi) throw new CliError(`No ABI for ${step.contract} in chain-config.json`);
      return new ethers.Contract(step.address, abi, wallet);
    }
  };
}

function describeStep(step) {
  return `  step ${step.index}: ${step.contract}.${step.method}(${step.args.join(', ')})\n    at ${step.address}\n    ${step.description}`;
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
export async function run({ argv, env, fetchFn = fetch, createSigner = createDefaultSigner, log = console.log }) {
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
    if (approval.status !== 'AWAITING_OWNER_SIGNATURE') {
      throw new CliError(`Approval ${approval.approval_id} is ${approval.status}; only AWAITING_OWNER_SIGNATURE can be signed.`);
    }
    const plan = approval.plan;
    if (!plan?.steps?.length) throw new CliError('The approval has no transactions to sign.');
    log(`Approval ${approval.approval_id}: ${approval.action} for ${approval.case_id} (decision ${decision?.decision_id ?? approval.decision_id})`);
    log(`Network: ${plan.network} (chain ${plan.chain_id}), ${plan.steps.length} transaction(s)`);
    for (const step of plan.steps) log(describeStep(step));

    // A protected pool never receives a terminal action, whatever the server says.
    const guarded = protectedPools(env);
    for (const step of plan.steps) {
      if (TERMINAL_METHODS.has(step.method) && guarded.includes(Number(step.args[0]))) {
        throw new CliError(`Refusing ${step.method} on protected pool #${step.args[0]} (AGENT_PROTECTED_CHAIN_POOLS).`);
      }
    }

    const signer = await createSigner({ env, plan });
    if (!signer) {
      log('\nDEPLOYER_PRIVATE_KEY is not set, so nothing can be preflighted or signed here.');
      log('Set it in this shell only (never on the server) and run again.');
      return args.confirm ? 1 : 0;
    }
    log(`\nSigner: ${signer.address}`);

    const done = new Set((approval.steps_done ?? []).map((step) => step.index));
    const pending = plan.steps.filter((step) => !done.has(step.index));
    for (const step of pending) {
      const contract = signer.contractFor(step);
      const owner = await contract.owner?.();
      if (owner && String(owner).toLowerCase() !== signer.address.toLowerCase()) {
        throw new CliError(`This key (${signer.address}) is not the contract owner (${owner}); it cannot sign step ${step.index}.`);
      }
      try {
        await contract[step.method].staticCall(...step.args);
      } catch (error) {
        throw new CliError(`Preflight failed for step ${step.index}: the contract would reject it (${error?.reason ?? error?.shortMessage ?? error?.message}).`);
      }
      log(`  step ${step.index}: preflight OK`);
    }
    if (!args.confirm) {
      log('\nDry run only. Add --confirm to sign and send.');
      return 0;
    }

    for (const step of pending) {
      const contract = signer.contractFor(step);
      log(`\nSending step ${step.index} (${step.method})...`);
      const tx = await contract[step.method](...step.args);
      log(`  tx ${tx.hash}`);
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) throw new CliError(`Step ${step.index} was mined but reverted (${tx.hash}).`);
      const reply = await call(fetchFn, base, token, 'POST', `/api/agent/approvals/${encodeURIComponent(approval.approval_id)}/attach-tx`, { tx_hash: tx.hash, step_index: step.index });
      log(`  server verified step ${step.index}: ${reply.complete ? 'approval complete' : 'more steps to go'}`);
    }
    log('\nDone.');
    return 0;
  } catch (error) {
    log(error instanceof CliError ? error.message : `Unexpected error: ${error?.message ?? error}`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}
