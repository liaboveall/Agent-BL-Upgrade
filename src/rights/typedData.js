import { randomBytes } from 'node:crypto';
import { TypedDataEncoder, keccak256, toUtf8Bytes } from 'ethers';
import { z } from 'zod';
import { canonicalJson } from '../mystery/fairness.js';

const fields = (values) => values.map(([name, type]) => ({ name, type }));
export const ISSUANCE_TYPES = Object.freeze({ Issuance: fields([
  ['assetKey', 'bytes32'], ['documentHash', 'bytes32'], ['issuerOrg', 'bytes32'], ['holder', 'address'],
  ['revision', 'uint64'], ['previousHash', 'bytes32'], ['validUntil', 'uint64'], ['nonce', 'uint256']
]) });
export const PLEDGE_TYPES = Object.freeze({ Pledge: fields([
  ['eblId', 'uint256'], ['pool', 'address'], ['termsHash', 'bytes32'], ['nonce', 'uint256'], ['validUntil', 'uint64']
]) });
export const TERMS_TYPES = Object.freeze({ OfferingTerms: fields([
  ['eblId', 'uint256'], ['assetKey', 'bytes32'], ['documentHash', 'bytes32'], ['settlementAsset', 'address'],
  ['exporter', 'address'], ['feeRecipient', 'address'], ['supply', 'uint256'], ['issuePrice', 'uint256'],
  ['target', 'uint256'], ['minRaise', 'uint256'], ['maturity', 'uint64'], ['subscribeUntil', 'uint64'],
  ['disburseUntil', 'uint64'],
  ['maxFee', 'uint256'], ['policyHash', 'bytes32'], ['disclosureHash', 'bytes32'], ['nonce', 'uint256']
]) });
export const VALUATION_TYPES = Object.freeze({ Valuation: fields([
  ['termsHash', 'bytes32'], ['assetKey', 'bytes32'], ['settlementAsset', 'address'], ['netValue', 'uint256'],
  ['coverageBps', 'uint32'], ['valuedAt', 'uint64'], ['validUntil', 'uint64'], ['nonce', 'uint256']
]) });
export const SESSION_TYPES = Object.freeze({ BusinessSession: fields([
  ['subject', 'bytes32'], ['organization', 'bytes32'], ['wallet', 'address'], ['nonce', 'bytes32'], ['validUntil', 'uint64']
]) });
/** Control version of newly deployed instances. Older instances keep their own signing domain. */
export const CONTROL_VERSION = 3;
export function rightsDomain(chainId, verifyingContract, version = CONTROL_VERSION) { return { name: 'AgentBL Rights', version: String(version), chainId, verifyingContract }; }
export function titleDomain(chainId, verifyingContract) { return { name: 'AgentBL Title', version: '1', chainId, verifyingContract }; }
export function hashOfferingTerms(chainId, controller, terms, version = CONTROL_VERSION) { return TypedDataEncoder.hash(rightsDomain(chainId, controller, version), TERMS_TYPES, terms); }

/** Only normalized, issuer-stable identifiers belong in this reservation domain.
 * The issuer must assign the same original identity to amendments and replacements.
 * Alias inventories for historical deployments must be imported before issuance. */
export function assetIdentity(issuerOrganization, originalIdentity) {
  const normalize = (value) => String(value).normalize('NFKC').trim().toUpperCase().replace(/\s+/gu, ' ');
  const organization = normalize(issuerOrganization), original = normalize(originalIdentity);
  if (!organization || !original || organization.length > 256 || original.length > 256) throw new Error('Stable issuer and original title identity are required');
  return keccak256(toUtf8Bytes(canonicalJson({ domain: 'agentbl-title-identity-v1', issuer: organization, original })));
}
/** Random salt stays in the authorized encrypted material package, never on chain. */
export function privateCommitment(material, salt = randomBytes(32).toString('hex')) {
  if (!/^[a-f0-9]{64}$/u.test(salt)) throw new Error('A 32-byte private commitment salt is required');
  return { hash: keccak256(toUtf8Bytes(canonicalJson({ domain: 'agentbl-private-material-v1', salt, material }))), salt };
}
const bytes32 = z.string().regex(/^0x[a-fA-F0-9]{64}$/u);
export const publicSummarySchema = z.object({
  asset_class: z.enum(['copper', 'oil', 'rubber', 'iron_ore', 'aluminium', 'soy', 'other']),
  settlement: z.literal('TEST_USDC'), tenor_days: z.number().int().min(1).max(366), terms_hash: bytes32,
  risk_flags: z.array(z.enum(['simulated_title', 'test_asset', 'capital_at_risk', 'unverified_external_rights'])).min(1).max(4)
}).strict();
export function publicSummary(input) { return publicSummarySchema.parse(input); }
