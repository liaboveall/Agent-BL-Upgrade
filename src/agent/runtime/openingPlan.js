// Read-only Live opening plans. Dependent IDs are filled exclusively from verified contract logs,
// never from nextEblId/nextPoolId counters or values supplied by a client.
import { isAddress, ZeroAddress } from 'ethers';
import fs from 'node:fs/promises';
import { cargoIdentityHash } from '../../chain/cargoIdentity.js';
import { hashSnapshot } from '../decisionLogger.js';
import { ACTIVE_STATES, chainStateName } from './poolRules.js';
import { knownLivePool } from './poolRegistry.js';

export const OPENING_ACTIONS = Object.freeze(['OPEN', 'OPEN_WITH_WARNING']);
export const OPENING_SCHEMA = 'agentbl-owner-opening-v1';
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export class OpeningPlanError extends Error {
  constructor(code, message) {
    super(message); this.name = 'OpeningPlanError'; this.code = code; this.status = 409; this.expose = true;
  }
}
const requireThat = (condition, code, message) => { if (!condition) throw new OpeningPlanError(code, message); };

const tokens = (value) => String(value ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const contains = (source, identity) => tokens(identity).every((token) => tokens(source).includes(token));

/**
 * A case with a known Live pool keeps the cargo identity it was registered with: documents that
 * describe the same cargo with other labels resolve to that identity (and so to a link), never to a
 * second mint. Pool #2 was committed with short catalog labels; pool #3 with the parsed documents.
 */
async function identityFor(caseData) {
  const pool = knownLivePool(caseData.case_id);
  if (!pool) return caseData;
  const canonical = JSON.parse(await fs.readFile(new URL(`../../../${pool.identity_file}`, import.meta.url), 'utf8'));
  requireThat(canonical.case_id === pool.case_id && same(cargoIdentityHash(canonical), pool.cargo_hash),
    'known_identity_corrupt', 'The recorded identity of the registered eBL no longer reproduces its cargo hash');
  const bill = caseData.bill_of_lading, known = canonical.bill_of_lading;
  requireThat([known.bl_id, known.ebl_title_ref].includes(bill?.bl_id) && Number(bill.quantity_mt) === known.quantity_mt
    && same(bill.vessel, known.vessel) && contains(bill.carrier, known.carrier) && contains(bill.cargo, known.cargo)
    && bill.voyage_no === known.voyage_no && contains(bill.port_of_loading, known.port_of_loading)
    && contains(bill.port_of_discharge, known.port_of_discharge)
    && String(caseData.cargo?.hs_code) === String(canonical.cargo.hs_code),
  'known_cargo_identity_mismatch', 'The documents do not match the standing registered eBL; review them instead of minting another cargo identity');
  // Documents that already carry the registered identity (pool #3's own) are used as they are.
  return same(cargoIdentityHash(caseData), pool.cargo_hash) ? caseData : canonical;
}

export function positiveChainId(value) {
  const id = Number(value);
  requireThat(Number.isSafeInteger(id) && id > 0, 'invalid_chain_id', 'A contract ID must be a supported positive integer');
  return id;
}

function uint(value, label, scale = 1) {
  const amount = Math.round(Number(value) * scale);
  requireThat(Number.isSafeInteger(amount) && amount > 0, 'invalid_opening_amount', `${label} must be positive and fit the supported integer range`);
  return String(amount);
}

/** Metadata assertions reflect only explicit declarations in the documents, not legal certification. */
export function openingMetadata(caseData) {
  const bill = caseData?.bill_of_lading ?? {};
  requireThat(!caseData?.warehouse_receipt && bill.bl_id && bill.cargo && bill.vessel
    && bill.port_of_loading && bill.port_of_discharge, 'ebl_required', 'Live opening requires a complete marine eBL');
  requireThat((caseData.commercial_invoice?.currency ?? 'USD') === 'USD', 'unsupported_currency', 'Live eBL metadata requires USD document values');
  const hs = String(caseData.commercial_invoice?.hs_code ?? caseData.cargo?.hs_code ?? '');
  requireThat(/^\d{6,10}$/u.test(hs), 'hs_required', 'An explicit valid HS code is required');
  const quantity = Number(bill.quantity_mt);
  const integral = Number.isInteger(quantity);
  const declarations = JSON.stringify([bill.ebl_platform ?? '', caseData.metadata ?? {}]);
  return {
    vessel: String(bill.vessel), voyage: String(bill.voyage_no ?? bill.voyage ?? bill.voyage_number ?? ''),
    portOfLoading: String(bill.port_of_loading), portOfDischarge: String(bill.port_of_discharge), cargo: String(bill.cargo),
    quantity: uint(quantity, 'Document quantity', integral ? 1 : 1_000_000), quantityUnit: integral ? 'MT' : 'MT_E6', hsCode: hs,
    declaredValueUsdE6: uint(bill.declared_value_usd, 'Declared USD value', 1_000_000),
    incoterms: String(bill.incoterms ?? caseData.commercial_invoice?.incoterms ?? ''),
    mletr: /\bMLETR\b/iu.test(declarations), eucp: /\beUCP\b/iu.test(declarations), dcsa: /\bDCSA\b/iu.test(declarations)
  };
}

/** Revalidate an existing-cargo association without writing to the chain. */
export async function readRegisteredOpening({ cargoHash, context, chainConfig }) {
  const { registry, pool } = context;
  const eblId = positiveChainId(await registry.eblIdForCargo(cargoHash));
  requireThat(same(await registry.cargoHashOf(eblId), cargoHash), 'cargo_mismatch', 'The cargo lookup and registered eBL disagree');
  const poolValue = await pool.poolOfEbl(eblId);
  requireThat(BigInt(poolValue) > 0n, 'registered_without_pool', 'This cargo is registered without an active offering; reconcile its existing lifecycle instead of minting it again');
  const poolId = positiveChainId(poolValue);
  const offering = await pool.offerings(poolId);
  requireThat(offering?.exists && Number(offering.eblId) === eblId, 'pool_mapping_mismatch', 'The offering does not back the registered cargo');
  requireThat(same(await registry.pledgedTo(eblId), chainConfig.contracts.RWAOfferingPool), 'pledge_mismatch', 'The eBL is not pledged to this offering contract');
  const state = chainStateName(await pool.stateOf(poolId));
  requireThat(ACTIVE_STATES.includes(state) || state === 'Paused', 'pool_not_active', `The registered offering is ${state}; it cannot be reminted`);
  return { ebl_id: eblId, pool_id: poolId, state };
}

export async function buildOpeningPlan({ params, chainConfig, context }) {
  requireThat(context?.registry && context?.pool, 'chain_unavailable', 'The chain is unavailable; no Live opening can be planned');
  requireThat(Number(chainConfig?.chainIdDecimal) === 1439, 'wrong_network', 'Live opening is restricted to Injective testnet 1439');
  if (context.provider?.send) requireThat(Number(await context.provider.send('eth_chainId', [])) === 1439, 'wrong_network', 'RPC is connected to another chain');
  for (const name of ['EBLRegistry', 'RWAOfferingPool']) {
    requireThat(isAddress(chainConfig.contracts?.[name]) && !same(chainConfig.contracts[name], ZeroAddress), 'contract_missing', `${name} deployment is missing`);
  }
  const caseData = params.case_data;
  const quote = params.quote;
  requireThat(caseData?.case_id && quote?.case_id === caseData.case_id
    && ['OPEN_OFFERING', 'OPEN_WITH_WARNING'].includes(quote.pricing_action), 'quote_not_open', 'Only a matching, openable document quote can create an offering');
  requireThat(params.compliance?.status === 'CLEAR', 'compliance_not_clear', 'Live opening requires a CLEAR compliance report');
  const identityCase = await identityFor(caseData);
  const cargoHash = cargoIdentityHash(identityCase);
  const base = { schema: OPENING_SCHEMA, network: chainConfig.network, chain_id: 1439,
    case_id: caseData.case_id, cargo_hash: cargoHash, cargo_identity_version: 'wave-b-v1', quote_hash: quote.quote_hash,
    ...(identityCase !== caseData ? { source_cargo_hash: cargoIdentityHash(caseData), identity_source: 'standing-pool-catalog' } : {}),
    bindings: {}, steps: [] };
  const unique = await context.registry.isUnique(cargoHash);
  requireThat(typeof unique === 'boolean', 'invalid_uniqueness_result', 'The registry did not return a valid uniqueness result');
  if (!unique) {
    const existing = await readRegisteredOpening({ cargoHash, context, chainConfig });
    return { ...base, kind: 'link', existing, bindings: { ebl_id: String(existing.ebl_id), pool_id: String(existing.pool_id) } };
  }
  requireThat(!knownLivePool(caseData.case_id), 'known_cargo_not_registered', 'The standing eBL could not be found under its original cargo identity; reconcile the registry instead of reminting it');
  requireThat(!await context.pool.emergencyStopped(), 'emergency_stopped', 'The offering protocol is stopped; no opening is planned');
  const holder = await context.registry.owner();
  requireThat(isAddress(holder) && !same(holder, ZeroAddress) && same(holder, await context.pool.owner()), 'owner_mismatch', 'Mint and offering require the same contract owner');
  const metadata = openingMetadata(caseData);
  const supply = uint(quote.recommended_token_supply, 'Token supply');
  const price = uint(quote.final_issue_price_usd, 'Issue price', 1_000_000);
  const target = uint(quote.target_redemption_value_usd, 'Target redemption', 1_000_000);
  requireThat(BigInt(price) <= BigInt(target), 'price_above_target', 'The proposed issue price exceeds the redemption target');
  const metadataHash = hashSnapshot({ case_data: caseData, documents: params.documents, compliance: params.compliance, quote_hash: quote.quote_hash });
  const registryAddress = chainConfig.contracts.EBLRegistry, poolAddress = chainConfig.contracts.RWAOfferingPool;
  return { ...base, kind: 'create', holder, metadata_hash: metadataHash, steps: [
    { index: 0, contract: 'EBLRegistry', address: registryAddress, method: 'mintEBLV2', args: [cargoHash, metadataHash, holder, metadata],
      description: 'Register the unregistered cargo and read its eBL ID from the verified mint receipt', expected_events: ['EBLMintedV2'],
      event_checks: [{ name: 'EBLMintedV2', args: { cargoHash, metadataHash, holder }, bind: { ebl_id: 'eblId' } }] },
    { index: 1, contract: 'EBLRegistry', address: registryAddress, method: 'pledge', args: [{ ref: 'ebl_id' }, poolAddress],
      description: 'Pledge the eBL identified by the verified mint receipt', expected_events: ['EBLPledged'],
      event_checks: [{ name: 'EBLPledged', args: { eblId: { ref: 'ebl_id' }, pool: poolAddress, holder } }] },
    { index: 2, contract: 'RWAOfferingPool', address: poolAddress, method: 'createOffering', args: [{ ref: 'ebl_id' }, supply, price, target],
      description: 'Create the offering and read its pool ID from the verified creation receipt', expected_events: ['OfferingCreated'],
      event_checks: [{ name: 'OfferingCreated', args: { eblId: { ref: 'ebl_id' }, tokenSupply: supply, issuePrice: price, targetRedemptionValue: target }, bind: { pool_id: 'poolId' } }] }
  ] };
}

export function resolveOwnerStep(plan, step) {
  const resolve = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value.ref) {
      const bound = plan.bindings?.[value.ref];
      requireThat(bound !== undefined, 'step_dependency_pending', `Step ${step.index} awaits the verified ${value.ref} from an earlier receipt`);
      return String(positiveChainId(bound));
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
    return value;
  };
  return resolve(step);
}

/** Check the current chain immediately before the operator preflights/sends one step. */
export async function validateOpeningStep({ plan, step, registry, pool, poolAddress }) {
  if (plan.schema !== OPENING_SCHEMA) return;
  requireThat(!await pool.emergencyStopped(), 'emergency_stopped', 'The offering protocol is stopped');
  if (step.index === 0) {
    requireThat(await registry.isUnique(plan.cargo_hash) === true, 'cargo_already_registered', 'Cargo was registered after this proposal; do not mint it again');
    return;
  }
  const eblId = positiveChainId(plan.bindings?.ebl_id);
  requireThat(same(await registry.cargoHashOf(eblId), plan.cargo_hash)
    && same(await registry.metadataHashOf(eblId), plan.metadata_hash)
    && same(await registry.holderOf(eblId), plan.holder), 'mint_state_mismatch', 'The registered collateral no longer matches the approved mint');
  if (step.index === 1) {
    requireThat(same(await registry.pledgedTo(eblId), ZeroAddress), 'already_pledged', 'The collateral is already pledged; reconcile the transaction before continuing');
  } else {
    requireThat(same(await registry.pledgedTo(eblId), poolAddress), 'pledge_mismatch', 'The collateral is not pledged to the approved offering contract');
    requireThat(BigInt(await pool.poolOfEbl(eblId)) === 0n, 'already_offered', 'The collateral already backs an offering; reconcile before continuing');
  }
}
