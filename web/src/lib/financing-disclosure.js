import { loadEthers } from './web3.js';
import { FINANCE_POLICY } from '../../../src/rights/financePolicy.js';

const canonical = (value) => JSON.stringify(sort(value));
const sort = (value) => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
const types = { OfferingTerms: [
  ['eblId', 'uint256'], ['assetKey', 'bytes32'], ['documentHash', 'bytes32'], ['settlementAsset', 'address'],
  ['exporter', 'address'], ['feeRecipient', 'address'], ['supply', 'uint256'], ['issuePrice', 'uint256'], ['target', 'uint256'],
  ['minRaise', 'uint256'], ['maturity', 'uint64'], ['subscribeUntil', 'uint64'], ['disburseUntil', 'uint64'],
  ['maxFee', 'uint256'], ['policyHash', 'bytes32'], ['disclosureHash', 'bytes32'], ['nonce', 'uint256']
].map(([name, type]) => ({ name, type })) };
export async function verifyReadableTerms(pack, offer, status) {
  const { keccak256, toUtf8Bytes, TypedDataEncoder } = await loadEthers();
  const digest = (domain, value) => keccak256(toUtf8Bytes(canonical({ domain, value })));
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const doc = pack?.document, instance = doc?.instance;
  if (doc?.schema !== 'agentbl-financing-disclosure-v1' || canonical(doc.policy) !== canonical(FINANCE_POLICY)
    || Number(instance.chain_id) !== status.config.chainIdDecimal || !same(instance.controller, status.controller)
    || !same(instance.pool, status.config.contracts.RWAOfferingPool)
    || Number(pack.pool_id) !== Number(offer.pool_id) || !same(pack.quote_version, offer.quote_version)
    || !same(pack.disclosure_hash, digest(doc.schema, doc)) || !same(pack.policy_hash, digest('agentbl-finance-policy-v1', doc.policy))
    || canonical(pack.terms) !== canonical({ ...doc.terms, policyHash: pack.policy_hash, disclosureHash: pack.disclosure_hash })
    || !same(pack.terms_hash, TypedDataEncoder.hash({ name: 'AgentBL Rights', version: '2', chainId: instance.chain_id, verifyingContract: instance.controller }, types, pack.terms))
    || !same(pack.terms_hash, offer.terms_hash) || !same(pack.disclosure_hash, offer.disclosure_hash) || !same(pack.policy_hash, offer.policy_hash)
    || !same(pack.terms.issuePrice, offer.issue_price_atomic) || !same(pack.terms.target, offer.redemption_per_share_atomic)
    || !same(pack.terms.supply, offer.shares) || !same(pack.terms.settlementAsset, offer.settlement_asset)
    || !same(pack.terms.subscribeUntil, offer.subscription_deadline) || !same(pack.terms.disburseUntil, offer.disbursement_deadline)
    || !same(pack.terms.maturity, offer.maturity)) throw new Error('Readable terms are missing, changed or inconsistent. Refresh and review again.');
  return pack;
}
