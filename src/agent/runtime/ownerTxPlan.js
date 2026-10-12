// Transactions an operator signs with the OWNER key (D2/D3), and the check that a transaction
// someone reports back really is the one that was planned.
//
// The web server never holds the owner key. For an approved action it publishes a plan (contract,
// method, exact arguments); the operator runs `npm run agent:approve` on their own machine, which
// signs and sends; the server then reads the transaction and receipt from the chain and only marks
// the step done if the target, the method, every argument and the expected event all match. A tx
// hash alone is never trusted.

import { proofToBytes32 } from './executors/chainExecutor.js';

const POOL = 'RWAOfferingPool';

/** What an owner-signed plan can contain today. OPEN (mint → pledge → createOffering) arrives with WP2.4. */
export const OWNER_PLAN_ACTIONS = Object.freeze(['MARK_IN_TRANSIT', 'RECORD_PAYMENT', 'RECORD_ARRIVAL', 'SETTLE', 'CANCEL']);

const METHODS = {
  MARK_IN_TRANSIT: { method: 'markInTransit', events: ['DepartureRecorded'], describe: 'Record the departure proof and move the offering to InTransit' },
  RECORD_PAYMENT: { method: 'recordImporterPayment', events: ['SettlementProofRecorded'], describe: 'Record the importer payment proof and amount' },
  RECORD_ARRIVAL: { method: 'recordCargoArrival', events: ['SettlementProofRecorded'], describe: 'Record the cargo arrival proof' },
  SETTLE: { method: 'settle', events: ['OfferingSettled'], describe: 'Settle the offering (records repayment; the contract holds no funds)' },
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
export async function buildOwnerPlan({ action, chain_pool_id: poolId, params = {}, chainConfig }) {
  const spec = METHODS[action];
  if (!spec) throw new OwnerPlanError('unsupported_action', `${action} has no owner-signed plan`);
  if (!Number.isSafeInteger(Number(poolId)) || Number(poolId) < 1) {
    throw new OwnerPlanError('no_chain_pool', 'An on-chain pool id is required to plan a transaction');
  }
  const address = chainConfig?.contracts?.[POOL];
  if (!address) throw new OwnerPlanError('contract_missing', `${POOL} is not deployed on ${chainConfig?.network ?? 'this network'}`);

  const args = [String(Number(poolId))];
  if (action === 'MARK_IN_TRANSIT') args.push(await proofToBytes32(params.departure_proof));
  if (action === 'RECORD_PAYMENT') {
    args.push(await proofToBytes32(params.payment_proof), String(BigInt(params.repayment_amount)));
  }
  if (action === 'RECORD_ARRIVAL') args.push(await proofToBytes32(params.arrival_proof));
  if (action === 'SETTLE') args.push(String(BigInt(params.repayment_amount)));
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
      if (actual === undefined || lower(actual) !== lower(expected)) {
        errors.push(`argument ${i} is ${String(actual)}, expected ${expected}`);
      }
    });
    if (parsed.args.length !== step.args.length) errors.push(`argument count is ${parsed.args.length}, expected ${step.args.length}`);
  }

  const names = [];
  for (const log of receipt.logs ?? []) {
    if (lower(log.address ?? step.address) !== lower(step.address)) continue;
    try {
      const event = iface.parseLog(log);
      if (event) names.push(event.name);
    } catch {
      // A log from the same address that this ABI does not describe.
    }
  }
  for (const wanted of step.expected_events ?? []) {
    if (!names.includes(wanted)) errors.push(`expected event ${wanted} is missing from the receipt`);
  }

  return { ok: errors.length === 0, errors, block_number: receipt.blockNumber, from: tx.from, confirmed_events: names };
}
