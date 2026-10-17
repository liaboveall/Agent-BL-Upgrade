// Live settlement uses confirmed ERC-20 receipts and current pool proofs. No signing or fund movement.
import { Interface, ZeroAddress, formatUnits, isAddress, keccak256, parseUnits, toUtf8Bytes } from 'ethers';
import { X402_NETWORKS } from '../../x402/config.js';
import { chainStateName, planTransition } from '../runtime/poolRules.js';

export const SETTLEMENT_SCHEMA = 'agentbl-settlement-plan-v1';
export const SETTLEMENT_ACTIONS = Object.freeze(['RECORD_PAYMENT', 'RECORD_ARRIVAL', 'SETTLE']);
const transferInterface = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const hash = (value) => /^0x[0-9a-f]{64}$/iu.test(value ?? '') && !/^0x0{64}$/iu.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const uintMax = (1n << 256n) - 1n;

export class SettlementError extends Error {
  constructor(code, message, status = 422) {
    super(message); this.name = 'SettlementError'; this.code = code; this.status = status; this.expose = true;
  }
}
const requireThat = (value, code, message, status) => { if (!value) throw new SettlementError(code, message, status); };

/** Decimal strings are preferred; values are never rounded or interpreted as atomic units. */
export function repaymentAtomic(amount) {
  const text = String(amount ?? '');
  requireThat(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u.test(text), 'invalid_repayment_amount', 'Repayment must be a positive USDC amount with at most six decimal places');
  if (typeof amount === 'number') requireThat(Number.isSafeInteger(Math.round(amount * 1_000_000)), 'unsafe_repayment_number', 'Use a decimal string for this USDC amount');
  const value = parseUnits(text, 6);
  requireThat(value > 0n && value <= uintMax, 'invalid_repayment_amount', 'Repayment is outside the positive uint256 range');
  return value.toString();
}

export function atomicRepayment(value) {
  requireThat(/^[1-9][0-9]*$/u.test(String(value ?? '')), 'invalid_atomic_amount', 'A positive atomic USDC amount is required');
  requireThat(BigInt(value) <= uintMax, 'invalid_atomic_amount', 'Atomic amount exceeds uint256');
  return String(value);
}

export const repaymentDisplay = (atomic) => formatUnits(atomicRepayment(atomic), 6);

export function samePaymentEvidence(a, b) {
  return ['tx_hash', 'asset', 'payer', 'recipient', 'amount_atomic', 'block_hash', 'log_index'].every((key) =>
    a?.[key] !== undefined && b?.[key] !== undefined && String(a[key]).toLowerCase() === String(b[key]).toLowerCase());
}

export async function assertSettlementChain(provider, chainConfig) {
  requireThat(Number(chainConfig?.chainIdDecimal) === 1439, 'wrong_settlement_chain', 'Live settlement is pinned to Injective testnet 1439');
  requireThat(provider?.send, 'chain_unavailable', 'A read-only chain provider is required', 503);
  const actual = await provider.send('eth_chainId', []);
  requireThat(Number(actual) === 1439, 'wrong_settlement_chain', 'RPC is connected to another chain');
}

/** Only receipt logs from the locally pinned USDC asset may prove payment. Payload addresses are ignored. */
export async function verifyUsdcTransfer({ provider, chainConfig, recipient, expectedPayer, txHash, amount, amountAtomic, confirmations = 1 }) {
  requireThat(isAddress(recipient ?? '') && !same(recipient, ZeroAddress), 'settlement_recipient_required', 'Configure AGENT_SETTLEMENT_RECIPIENT before submitting Live payment evidence');
  requireThat(isAddress(expectedPayer ?? '') && !same(expectedPayer, ZeroAddress) && !same(expectedPayer, recipient),
    'settlement_payer_required', 'Configure the independently agreed importer payer before accepting Live recovery evidence');
  requireThat(hash(txHash), 'invalid_payment_hash', 'USDC payment_proof must be a nonzero 32-byte transaction hash');
  const atomic = amountAtomic === undefined ? repaymentAtomic(amount) : atomicRepayment(amountAtomic);
  await assertSettlementChain(provider, chainConfig);
  const [tx, receipt, head] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash), provider.getBlockNumber()]);
  requireThat(tx && receipt, 'payment_not_mined', 'Payment transaction and receipt must both be available');
  requireThat(Number(receipt.status) === 1, 'payment_reverted', 'Payment transaction reverted');
  requireThat(same(tx.hash, txHash) && same(receipt.hash ?? receipt.transactionHash, txHash), 'payment_hash_mismatch', 'Transaction or receipt belongs to another payment');
  requireThat(Number(tx.chainId) === 1439, 'wrong_settlement_chain', 'Payment transaction belongs to another chain');
  requireThat(Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber > 0 && hash(receipt.blockHash), 'invalid_payment_block', 'Payment receipt has no valid mined block');
  const depth = head - receipt.blockNumber + 1;
  requireThat(depth >= Math.max(1, confirmations), 'payment_unconfirmed', 'Payment has not reached AGENT_CHAIN_CONFIRMATIONS');
  const block = await provider.getBlock(receipt.blockNumber);
  requireThat(block && same(block.hash, receipt.blockHash), 'payment_reorged', 'Payment receipt no longer belongs to the canonical block');
  const asset = X402_NETWORKS['eip155:1439'].asset;
  const matches = [];
  for (const log of receipt.logs ?? []) {
    if (!same(log.address, asset) || log.removed) continue;
    let parsed;
    try { parsed = transferInterface.parseLog(log); } catch { continue; }
    if (!parsed || parsed.name !== 'Transfer' || !same(parsed.args.to, recipient) || parsed.args.value !== BigInt(atomic)) continue;
    requireThat(!same(parsed.args.from, ZeroAddress) && !same(parsed.args.from, recipient), 'invalid_payment_sender', 'Minting or self-transfer is not importer payment');
    const index = log.index ?? log.logIndex;
    requireThat(Number.isSafeInteger(index) && index >= 0, 'invalid_payment_log', 'Transfer log needs a canonical log index');
    requireThat(!log.transactionHash || same(log.transactionHash, txHash), 'payment_hash_mismatch', 'Transfer log belongs to another transaction');
    requireThat(!log.blockHash || same(log.blockHash, receipt.blockHash), 'payment_reorged', 'Transfer log belongs to another block');
    matches.push({ from: parsed.args.from, log_index: index });
  }
  requireThat(matches.length === 1, 'payment_transfer_mismatch', 'Receipt must contain exactly one matching USDC transfer to the configured recipient for the exact amount');
  requireThat(same(matches[0].from, expectedPayer), 'payment_payer_mismatch', 'The verified transfer is not from the agreed importer payer');
  return { source: 'confirmed-usdc-transfer', chain_id: 1439, asset, decimals: 6,
    tx_hash: txHash.toLowerCase(), payer: matches[0].from, recipient, amount_atomic: atomic,
    amount_usdc: repaymentDisplay(atomic), block_number: receipt.blockNumber, block_hash: receipt.blockHash,
    log_index: matches[0].log_index, required_confirmations: Math.max(1, confirmations) };
}

/** Read all settlement fields at one block; a stale browser/memory mirror cannot make a pool ready. */
export async function readSettlementState({ context, chainConfig, poolId }) {
  requireThat(Number.isSafeInteger(Number(poolId)) && Number(poolId) > 0, 'no_chain_pool', 'A verified on-chain pool mapping is required');
  await assertSettlementChain(context?.provider, chainConfig);
  const blockTag = await context.provider.getBlockNumber();
  const [offering, proofs, stopped] = await Promise.all([
    context.pool.offerings(poolId, { blockTag }), context.pool.settlementProofs(poolId, { blockTag }), context.pool.emergencyStopped({ blockTag })
  ]);
  requireThat(offering?.exists, 'chain_pool_missing', 'The mapped offering does not exist');
  const paymentProof = String(proofs.paymentProof ?? proofs[0]), arrivalProof = String(proofs.arrivalProof ?? proofs[1]);
  requireThat(/^0x[0-9a-f]{64}$/iu.test(paymentProof) && /^0x[0-9a-f]{64}$/iu.test(arrivalProof), 'invalid_pool_proofs', 'The pool returned invalid settlement proofs');
  return { state: chainStateName(offering.state), emergencyStopped: Boolean(stopped), subscribed: String(offering.subscribed),
    ebl_id: Number(offering.eblId), payment_proof: paymentProof.toLowerCase(), arrival_proof: arrivalProof.toLowerCase(),
    repayment_amount_atomic: String(offering.repaymentAmount ?? 0),
    repaymentAmountAtomic: offering.repaymentAmount === undefined ? undefined : String(offering.repaymentAmount),
    targetRedemptionValueAtomic: offering.targetRedemptionValue === undefined ? undefined : String(offering.targetRedemptionValue),
    paymentProof: hash(paymentProof), arrivalProof: hash(arrivalProof), block_number: blockTag };
}

function proofBytes32(value) {
  const text = String(value ?? '').trim();
  requireThat(text && !/^0x0{64}$/iu.test(text), 'proof_required', 'A nonempty, nonzero proof is required');
  return hash(text) ? text.toLowerCase() : keccak256(toUtf8Bytes(text));
}

/** A contextual plan is checked again by the CLI immediately before signing. */
export async function buildSettlementPlan({ action, chain_pool_id: poolId, params = {}, chainConfig, context, recipient, expectedPayer, confirmations = 1 }) {
  const address = chainConfig?.contracts?.RWAOfferingPool;
  requireThat(isAddress(address ?? ''), 'contract_missing', 'RWAOfferingPool deployment is required');
  const state = await readSettlementState({ context, chainConfig, poolId });
  requireThat(!state.emergencyStopped, 'emergency_stopped', 'Settlement cannot proceed while the protocol is stopped');
  const transition = planTransition(action, state);
  requireThat(transition.ok, transition.code, transition.message);
  const args = [String(poolId)];
  let method, payment, expected, eventArgs;
  if (action === 'RECORD_PAYMENT' || action === 'SETTLE') {
    requireThat(params.payment_verification?.source === 'confirmed-usdc-transfer', 'payment_verification_required', 'Verified USDC evidence is required before recording payment or settling');
    const atomic = atomicRepayment(params.repayment_amount_atomic);
    requireThat(repaymentAtomic(params.repayment_amount) === atomic, 'repayment_amount_mismatch', 'Display and atomic repayment amounts disagree');
    payment = await verifyUsdcTransfer({ provider: context.provider, chainConfig, recipient, expectedPayer, txHash: params.payment_proof, amountAtomic: atomic, confirmations });
    requireThat(samePaymentEvidence(payment, params.payment_verification),
      'payment_evidence_changed', 'Payment evidence changed since it was accepted');
    if (action === 'RECORD_PAYMENT') {
      method = 'recordImporterPayment'; args.push(payment.tx_hash, atomic); expected = 'SettlementProofRecorded';
      eventArgs = { poolId: String(poolId), paymentProof: payment.tx_hash, arrivalProof: state.arrival_proof };
    } else {
      requireThat(same(state.payment_proof, payment.tx_hash) && same(state.arrival_proof, params.arrival_proof)
        && state.repayment_amount_atomic === atomic, 'settlement_proofs_changed', 'The current on-chain proofs or repayment amount differ from this proposal');
      method = 'settle'; args.push(atomic); expected = 'OfferingSettled';
      eventArgs = { poolId: String(poolId), repaymentAmount: atomic, paymentProof: state.payment_proof, arrivalProof: state.arrival_proof };
    }
  } else {
    requireThat(action === 'RECORD_ARRIVAL', 'unsupported_action', 'Unsupported settlement action');
    method = 'recordCargoArrival'; const proof = proofBytes32(params.arrival_proof); args.push(proof); expected = 'SettlementProofRecorded';
    eventArgs = { poolId: String(poolId), paymentProof: state.payment_proof, arrivalProof: proof };
  }
  return { schema: SETTLEMENT_SCHEMA, network: chainConfig.network, chain_id: 1439, action, chain_pool_id: Number(poolId),
    ...(payment ? { payment } : {}), params, checked_block: state.block_number,
    steps: [{ index: 0, contract: 'RWAOfferingPool', address, method, args,
      description: 'Record settlement evidence; the contract does not hold or distribute funds.',
      expected_events: [expected], event_checks: [{ name: expected, args: eventArgs }] }] };
}

export async function validateSettlementStep({ plan, context, chainConfig, recipient, expectedPayer, confirmations = 1 }) {
  requireThat(plan?.schema === SETTLEMENT_SCHEMA, 'settlement_plan_required', 'Settlement requires a current verified settlement plan');
  const fresh = await buildSettlementPlan({ action: plan.action, chain_pool_id: plan.chain_pool_id, params: plan.params,
    context, chainConfig, recipient, expectedPayer, confirmations });
  requireThat(JSON.stringify(fresh.steps) === JSON.stringify(plan.steps), 'settlement_plan_changed', 'Current chain proofs no longer match the approved transaction plan');
  return fresh;
}
