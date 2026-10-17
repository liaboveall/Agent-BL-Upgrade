import { Interface, isAddress, sha256, toUtf8Bytes, ZeroAddress } from 'ethers';
import { cargoIdentityHash } from './cargoIdentity.js';
import { quoteFromCase } from '../core/pricingEngine.js';
import { toChainPricingArgs } from '../core/oracle.js';
import { oracleDecisionId } from '../agent/runtime/executors/chainExecutor.js';
import { ACTIVE_STATES, chainStateName } from '../agent/runtime/poolRules.js';

export class WaveBGateError extends Error {
  constructor(code, message) { super(message); this.name = 'WaveBGateError'; this.code = code; }
}
const requireThat = (condition, code, message) => { if (!condition) throw new WaveBGateError(code, message); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash32 = (value) => /^0x[0-9a-f]{64}$/iu.test(value ?? '') && !/^0x0{64}$/u.test(value);
const idNumber = (value) => {
  const id = Number(value);
  requireThat(Number.isSafeInteger(id) && id > 0, 'invalid_chain_id', 'Contract ID exceeds the supported positive integer range');
  return id;
};

export function contractEvents(receipt, address, abi) {
  const contractInterface = new Interface(abi);
  return (receipt.logs ?? []).filter((log) => same(log.address, address)).flatMap((log) => {
    try { const event = contractInterface.parseLog(log); return event ? [{ name: event.name, args: event.args }] : []; }
    catch { return []; }
  });
}

/** Recheck the historical payment and attestation against actual matching contract logs. */
export function verifyWaveBPayment({ report, chain, paymentReceipt, attestationReceipt }) {
  requireThat(report.mode === 'live' && report.network === 'eip155:1439' && Number(chain.chainIdDecimal) === 1439,
    'wrong_network', 'Wave B only accepts Live payment evidence on Injective testnet 1439');
  requireThat(hash32(report.payment_tx) && hash32(report.attestation_tx) && hash32(report.report_hash), 'invalid_evidence', 'Missing payment, attestation or report commitment');
  requireThat(isAddress(report.asset) && isAddress(report.payer) && isAddress(report.payee)
    && same(report.payment_oracle, chain.contracts.PaymentOracle) && /^[1-9][0-9]*$/u.test(report.amount_atomic), 'invalid_evidence', 'Invalid payment asset, parties, oracle or amount');
  for (const [receipt, expected] of [[paymentReceipt, report.payment_tx], [attestationReceipt, report.attestation_tx]]) {
    requireThat(receipt && Number(receipt.status) === 1 && same(receipt.hash ?? receipt.transactionHash, expected), 'invalid_receipt', 'Payment or attestation is missing, reverted or belongs to another transaction');
  }
  const transfer = contractEvents(paymentReceipt, report.asset, ['event Transfer(address indexed from,address indexed to,uint256 value)'])
    .find((event) => event.name === 'Transfer' && same(event.args.from, report.payer) && same(event.args.to, report.payee)
      && event.args.value === BigInt(report.amount_atomic));
  requireThat(transfer, 'payment_transfer_mismatch', 'Payment receipt has no matching asset, payer, payee and amount');
  const caseHash = sha256(toUtf8Bytes(report.case_id));
  const attested = contractEvents(attestationReceipt, chain.contracts.PaymentOracle, chain.abis.PaymentOracle)
    .find((event) => event.name === 'PaymentAttested' && same(event.args.reportHash, report.report_hash)
      && same(event.args.paymentTxHash, report.payment_tx) && same(event.args.caseIdHash, caseHash)
      && same(event.args.payer, report.payer) && same(event.args.asset, report.asset) && event.args.amount === BigInt(report.amount_atomic));
  requireThat(attested, 'attestation_mismatch', 'PaymentAttested does not match the report, case, transaction, payer, asset and amount');
  return { payment_block: paymentReceipt.blockNumber, attestation_block: attestationReceipt.blockNumber,
    report_hash: attested.args.reportHash, payment_tx: attested.args.paymentTxHash, case_id_hash: caseHash };
}

export function gateMetadata(caseData, report) {
  const bill = caseData.bill_of_lading;
  return {
    metadataHash: sha256(toUtf8Bytes(JSON.stringify({ case_id: report.case_id, payment_tx: report.payment_tx, report_hash: report.report_hash }))),
    metadata: { vessel: bill.vessel ?? '', voyage: bill.voyage ?? bill.voyage_number ?? '',
      portOfLoading: bill.port_of_loading ?? '', portOfDischarge: bill.port_of_discharge ?? '', cargo: bill.cargo,
      quantity: String(Math.round(bill.quantity_mt)), quantityUnit: 'MT',
      hsCode: caseData.commercial_invoice?.hs_code ?? caseData.cargo?.hs_code ?? '740311',
      declaredValueUsdE6: String(Math.round(bill.declared_value_usd * 1_000_000)),
      incoterms: bill.incoterms ?? caseData.commercial_invoice?.incoterms ?? 'CIF', mletr: true, eucp: true, dcsa: true }
  };
}

/** Read-only transaction planning. No signing methods or keys are accepted here. */
export async function planWaveBGate({ caseData, report, chain, registry, pool, oracle }) {
  requireThat(Number(chain.chainIdDecimal) === 1439, 'wrong_network', 'Wave B is pinned to Injective testnet 1439');
  requireThat(report.case_id === caseData.case_id && hash32(report.report_hash), 'case_mismatch', 'Case and report commitment must agree');
  for (const name of ['PaymentOracle', 'EBLRegistry', 'RWAOfferingPool', 'RiskPricingOracle']) requireThat(isAddress(chain.contracts[name]), 'contract_missing', `${name} deployment is missing`);
  requireThat(!await pool.emergencyStopped(), 'emergency_stopped', 'Offering protocol is stopped; no transactions planned');
  const cargoHash = cargoIdentityHash(caseData);
  const existing = BigInt(await registry.eblIdForCargo(cargoHash));
  const quote = quoteFromCase(caseData);
  requireThat(['OPEN_OFFERING', 'OPEN_WITH_WARNING'].includes(quote.pricing_action), 'quote_not_open', 'Gate B requires an openable case; it must not override risk blocking');
  let eblId, poolId, state = 'new', oldPrice = null;
  const steps = [];
  const add = (contract, method, args, description) => steps.push({ index: steps.length, contract, address: chain.contracts[contract], method, args, description });
  if (existing > 0n) {
    eblId = idNumber(existing);
    requireThat(same(await registry.cargoHashOf(eblId), cargoHash), 'cargo_mismatch', 'Registry cargo lookup is inconsistent');
    const linked = BigInt(await pool.poolOfEbl(eblId));
    requireThat(linked > 0n, 'registered_without_active_pool', 'Cargo is already registered but has no active offering. Reconcile the old lifecycle; do not mint this cargo again.');
    poolId = idNumber(linked);
    const offering = await pool.offerings(poolId);
    requireThat(offering.exists && BigInt(offering.eblId) === existing, 'pool_mapping_mismatch', 'Offering does not back the registered eBL');
    state = chainStateName(offering.state);
    requireThat(ACTIVE_STATES.includes(state), 'pool_not_active', `Registered pool #${poolId} is ${state}. Restore a paused pool only after review; terminal pools cannot be replayed or reminted.`);
    requireThat(same(await registry.pledgedTo(eblId), chain.contracts.RWAOfferingPool), 'pledge_mismatch', 'Registered collateral is not pledged to this offering contract');
    oldPrice = Number(offering.issuePrice);
  } else {
    eblId = idNumber(await registry.nextEblId());
    poolId = idNumber(await pool.nextPoolId());
    const holder = await registry.owner(), owner = await pool.owner();
    requireThat(same(holder, owner) && !same(holder, ZeroAddress), 'owner_mismatch', 'New mint and offering require the same operator owner');
    const { metadataHash, metadata } = gateMetadata(caseData, report);
    add('EBLRegistry', 'mintEBLV2', [cargoHash, metadataHash, holder, metadata], 'Register unregistered cargo; IDs are conditional on unchanged counters');
    add('EBLRegistry', 'pledge', [String(eblId), chain.contracts.RWAOfferingPool], 'Pledge the newly registered eBL');
    add('RWAOfferingPool', 'createOffering', [String(eblId), String(Math.round(quote.recommended_token_supply)),
      String(Math.round(quote.final_issue_price_usd * 1_000_000)), '1000000'], 'Create the new offering');
  }
  // A07: bind the plan to the current version and next sequence, with a bounded validity.
  const expectedVersion = pool.quoteVersion ? await pool.quoteVersion(poolId).catch(() => 1n) : 1n;
  const lastSeq = oracle.lastDecisionSeq ? await oracle.lastDecisionSeq(poolId).catch(() => 0n) : 0n;
  const pricing = toChainPricingArgs({ ...quote, evidence_hash: report.report_hash }, {
    pool_id: poolId, expected_quote_version: expectedVersion,
    valid_until: BigInt(Math.floor(Date.now() / 1000) + 3600), decision_seq: BigInt(lastSeq) + 1n
  });
  pricing.chain_id = Number(chain.chainIdDecimal);
  pricing.oracle_address = chain.contracts.RiskPricingOracle;
  const decisionId = await oracleDecisionId(pricing);
  let noOp = false;
  if (existing > 0n && await oracle.isDecisionProcessed(decisionId)) {
    requireThat(same(await oracle.latestEvidenceHash(poolId), pricing.evidence_hash)
      && same(await oracle.latestQuoteHash(poolId), pricing.quote_hash) && oldPrice === pricing.issue_price_e6,
    'pricing_commitment_already_processed', 'This report/quote was already processed and is no longer the current pricing. Supply a fresh genuine report/quote; never alter a commitment to evade replay protection.');
    noOp = true;
  } else {
    add('RiskPricingOracle', 'updatePricing', [String(poolId), String(pricing.issue_price_e6), pricing.risk_level,
      pricing.pricing_action, pricing.evidence_hash, pricing.quote_hash,
      String(pricing.expected_quote_version), String(pricing.valid_until), String(pricing.decision_seq)],
    'Bind the existing paid report to pricing; this may restore the report price on protected pool #2');
  }
  return { schema: 'agentbl-wave-b-plan-v1', network: 'eip155:1439', case_id: caseData.case_id, cargo_hash: cargoHash,
    cargo_identity_version: 'wave-b-v1', ebl_id: eblId, pool_id: poolId, reused: existing > 0n, state, no_op: noOp,
    current_issue_price_e6: oldPrice, pricing, decision_id: decisionId, quote, steps };
}
