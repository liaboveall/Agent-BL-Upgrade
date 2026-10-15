// Transactions an operator signs with the OWNER key (D2/D3), and the check that a transaction
// someone reports back really is the one that was planned.
//
// The web server never holds the owner key. For an approved action it publishes a plan (contract,
// method, exact arguments); the operator runs `npm run agent:approve` on their own machine, which
// signs and sends; the server then reads the transaction and receipt from the chain and only marks
// the step done if the target, the method, every argument and the expected event all match. A tx
// hash alone is never trusted.

import { proofToBytes32 } from './executors/chainExecutor.js';
import { buildOpeningPlan, OPENING_ACTIONS, positiveChainId } from './openingPlan.js';
import { buildSettlementPlan, SETTLEMENT_ACTIONS } from '../pipelines/settlementPipeline.js';

const POOL = 'RWAOfferingPool';

export const OWNER_PLAN_ACTIONS = Object.freeze([...OPENING_ACTIONS, 'MARK_IN_TRANSIT', 'RECORD_PAYMENT', 'RECORD_ARRIVAL', 'SETTLE', 'CANCEL']);

const METHODS = {
  MARK_IN_TRANSIT: { method: 'markInTransit', events: ['DepartureRecorded'], describe: 'Record the departure proof and move the offering to InTransit' },
  CANCEL: { method: 'cancelOffering', events: ['OfferingCancelled'], describe: 'Cancel an offering nobody subscribed to' }
};

export class OwnerPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OwnerPlanError';
    this.code = code;
    this.status = 422;
    this.expose = true;
  }
}

/**
 * @param {{action:string, chain_pool_id:number, params?:object, chainConfig:object}} input
 * @returns {{ network:string, chain_id:number, steps:Array<{index:number, contract:string, address:string, method:string,
 *            args:string[], description:string, expected_events:string[]}> }}
 */
export async function buildOwnerPlan({ action, chain_pool_id: poolId, params = {}, chainConfig, context, recipient, confirmations }) {
  if (OPENING_ACTIONS.includes(action)) return buildOpeningPlan({ params, chainConfig, context });
  if (SETTLEMENT_ACTIONS.includes(action)) return buildSettlementPlan({ action, chain_pool_id: poolId, params, chainConfig, context, recipient, confirmations });
  const spec = METHODS[action];
  if (!spec) throw new OwnerPlanError('unsupported_action', `${action} has no owner-signed plan`);
  if (!Number.isSafeInteger(Number(poolId)) || Number(poolId) < 1) {
    throw new OwnerPlanError('no_chain_pool', 'An on-chain pool id is required to plan a transaction');
  }
  const address = chainConfig?.contracts?.[POOL];
  if (!address) throw new OwnerPlanError('contract_missing', `${POOL} is not deployed on ${chainConfig?.network ?? 'this network'}`);

  const args = [String(Number(poolId))];
  if (action === 'MARK_IN_TRANSIT') args.push(await proofToBytes32(params.departure_proof));
  if (action === 'CANCEL') args.push(await proofToBytes32(params.reason ?? 'agent-cancel'));

  return {
    network: chainConfig.network,
    chain_id: Number(chainConfig.chainIdDecimal),
    steps: [{
      index: 0,
      contract: POOL,
      address,
      method: spec.method,
      args,
      description: spec.describe,
      expected_events: spec.events
    }]
  };
}

const lower = (value) => String(value).toLowerCase();
const matchesArg = (actual, expected) => {
  if (Array.isArray(expected)) return expected.every((item, index) => matchesArg(actual?.[index], item));
  if (expected && typeof expected === 'object') return Object.entries(expected).every(([key, item]) => matchesArg(actual?.[key], item));
  return actual !== undefined && (typeof expected === 'boolean' ? actual === expected : lower(actual) === lower(expected));
};

/**
 * Check a reported transaction against a planned step, using only data read from the chain.
 * @param {object} input
 * @param {object} input.step            a plan step
 * @param {string} input.txHash
 * @param {{getTransaction:Function, getTransactionReceipt:Function}} input.provider
 * @param {{parseTransaction:Function, parseLog:Function}} input.iface  ethers Interface of the target contract
 * @param {string[]} [input.allowedSenders]  accounts that may have sent it (the owner); omitted = any
 * @returns {Promise<{ok:boolean, errors:string[], block_number?:number, from?:string, confirmed_events:string[]}>}
 */
export async function verifyOwnerTx({ step, txHash, provider, iface, allowedSenders }) {
  const errors = [];
  if (!/^0x[0-9a-fA-F]{64}$/u.test(String(txHash))) {
    return { ok: false, errors: ['tx_hash is not a 32-byte hex hash'], confirmed_events: [] };
  }
  const [tx, receipt] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
  if (!tx) return { ok: false, errors: ['transaction not found on the chain (not mined yet, or a made-up hash)'], confirmed_events: [] };
  if (!receipt) return { ok: false, errors: ['transaction has no receipt yet'], confirmed_events: [] };
  if (receipt.status !== 1) errors.push('transaction reverted');
  if (tx.hash && lower(tx.hash) !== lower(txHash) || (receipt.hash ?? receipt.transactionHash) && lower(receipt.hash ?? receipt.transactionHash) !== lower(txHash)) errors.push('transaction or receipt hash does not match the reported hash');
  if (tx.chainId !== undefined && step.chain_id !== undefined && Number(tx.chainId) !== Number(step.chain_id)) errors.push('transaction belongs to another chain');
  if (BigInt(tx.value ?? 0) !== 0n) errors.push('owner plan does not authorize sending native funds');
  if (lower(tx.to ?? '') !== lower(step.address)) errors.push(`transaction targets ${tx.to}, not ${step.contract} ${step.address}`);
  if (allowedSenders?.length && !allowedSenders.map(lower).includes(lower(tx.from))) {
    errors.push(`transaction was sent by ${tx.from}, who is not an authorised signer`);
  }

  let parsed = null;
  try {
    parsed = iface.parseTransaction({ data: tx.data, value: tx.value });
  } catch {
    errors.push('transaction input does not decode against the contract ABI');
  }
  if (!parsed && !errors.some((e) => /does not decode/u.test(e))) {
    errors.push('transaction input does not decode against the contract ABI');
  }
  if (parsed) {
    if (parsed.name !== step.method) errors.push(`method is ${parsed.name}, expected ${step.method}`);
    step.args.forEach((expected, i) => {
      const actual = parsed.args[i];
      if (!matchesArg(actual, expected)) {
        errors.push(`argument ${i} is ${String(actual)}, expected ${expected}`);
      }
    });
    if (parsed.args.length !== step.args.length) errors.push(`argument count is ${parsed.args.length}, expected ${step.args.length}`);
  }

  const names = [], events = [];
  for (const log of receipt.logs ?? []) {
    if (lower(log.address ?? '') !== lower(step.address)) continue;
    try {
      const event = iface.parseLog(log);
      if (event) { names.push(event.name); events.push(event); }
    } catch {
      // A log from the same address that this ABI does not describe.
    }
  }
  for (const wanted of step.expected_events ?? []) {
    if (!names.includes(wanted)) errors.push(`expected event ${wanted} is missing from the receipt`);
  }
  const bindings = {};
  for (const check of step.event_checks ?? []) {
    const matching = events.filter((event) => event.name === check.name && matchesArg(event.args, check.args));
    if (matching.length !== 1) { errors.push(`expected event ${check.name} has missing, ambiguous or mismatched arguments`); continue; }
    for (const [name, field] of Object.entries(check.bind ?? {})) {
      try { bindings[name] = String(positiveChainId(matching[0].args[field])); }
      catch { errors.push(`expected event ${check.name} has an invalid ${field}`); }
    }
  }
  return { ok: errors.length === 0, errors, block_number: receipt.blockNumber, from: tx.from, confirmed_events: names,
    ...(step.event_checks ? { bindings } : {}) };
}
