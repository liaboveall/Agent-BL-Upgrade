import { keccak256, toUtf8Bytes } from 'ethers';
import { z } from 'zod';
import { canonicalJson } from '../mystery/fairness.js';
import { hashOfferingTerms, TERMS_TYPES } from './typedData.js';
import { assertPricingQuote } from '../core/pricingSchema.js';

// Public research obligations, separate from the salted private title material.
// Changing any policy text or parameter requires a new disclosure and new signatures.
import { FINANCE_POLICY, financePolicy } from './financePolicy.js';
export { FINANCE_POLICY, financePolicy };
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/u).refine((s) => !/^0x0{40}$/u.test(s));
const uint = z.string().regex(/^(0|[1-9]\d*)$/u).refine((s) => BigInt(s) < 2n ** 256n);
const hash = z.string().regex(/^0x[a-fA-F0-9]{64}$/u);
const rawFields = TERMS_TYPES.OfferingTerms.filter(({ name }) => !['policyHash', 'disclosureHash'].includes(name));
const termsSchema = z.object(Object.fromEntries(rawFields.map(({ name, type }) => [name, type === 'address' ? address : type === 'bytes32' ? hash : uint]))).strict();
const partiesSchema = z.object(Object.fromEntries(['issuer', 'holder', 'operator', 'valuer', 'compliance', 'disposer', 'reviewer', 'governance'].map((role) => [role, address]))).strict();
export const disclosureInputSchema = z.object({ revision: z.number().int().positive(),
  scenario: z.object({ asset_class: z.literal('copper'), origin: z.literal('Singapore'), destination: z.literal('Shanghai'),
    fictional: z.literal(true) }).strict().default({ asset_class: 'copper', origin: 'Singapore', destination: 'Shanghai', fictional: true }),
  // Absent on version 2 disclosures, whose published bytes must keep verifying.
  instance: z.object({ chain_id: z.number().int().refine((n) => [1439, 31337].includes(n)), controller: address, pool: address,
    control_version: z.number().int().min(3).max(3).optional() }).strict(),
  terms: termsSchema, parties: partiesSchema,
  sources: z.array(z.object({ field: z.enum(['invoice', 'cost', 'collateral', 'risk']),
    status: z.enum(['live', 'stale', 'fixture', 'unavailable']), reference: z.string().min(1).max(160) }).strict()).length(4)
}).strict();
export const publicDocumentHash = (domain, value) => keccak256(toUtf8Bytes(canonicalJson({ domain, value })));
export function createDisclosure(input) {
  const parsed = disclosureInputSchema.parse(input), t = parsed.terms;
  if (BigInt(t.subscribeUntil) >= BigInt(t.disburseUntil) || BigInt(t.disburseUntil) >= BigInt(t.maturity)
    || [t.subscribeUntil, t.disburseUntil, t.maturity].some((n) => BigInt(n) >= 2n ** 64n)
    || BigInt(t.maxFee) !== 0n || BigInt(t.supply) < 1n || BigInt(t.supply) > 1000000n
    || BigInt(t.issuePrice) < 1n || BigInt(t.target) < BigInt(t.issuePrice)
    || BigInt(t.minRaise) < 1n || BigInt(t.minRaise) > BigInt(t.supply) * BigInt(t.issuePrice)
    || new Set(parsed.sources.map((s) => s.field)).size !== 4) throw new Error('Invalid research financing terms');
  const version = parsed.instance.control_version ?? 2;
  const document = { schema: 'agentbl-financing-disclosure-v1', ...parsed, policy: financePolicy(version) };
  const policy_hash = publicDocumentHash('agentbl-finance-policy-v1', document.policy);
  const disclosure_hash = publicDocumentHash(document.schema, document);
  const terms = { ...t, policyHash: policy_hash, disclosureHash: disclosure_hash };
  return { document, policy_hash, disclosure_hash, terms,
    terms_hash: hashOfferingTerms(parsed.instance.chain_id, parsed.instance.controller, terms, version) };
}
export function verifyDisclosure(pack) {
  try {
    const { schema: _schema, policy: _policy, ...input } = pack.document;
    const expected = createDisclosure(input);
    return canonicalJson(expected) === canonicalJson(pack);
  } catch { return false; }
}

/** Issuer tooling uses the exact deterministic quote amounts; prose cannot override them. */
export function disclosureFromPricingQuote(input, quote) {
  assertPricingQuote(quote);
  if (!['OPEN_OFFERING', 'OPEN_WITH_WARNING'].includes(quote.pricing_action) || !quote.research_feasibility
    || quote.research_feasibility.status !== 'FEASIBLE_RESEARCH_ONLY') throw new Error('A feasible openable deterministic quote is required');
  const price = String(Math.round(quote.final_issue_price_usd * 1000000));
  if (quote.actual_financing_period && Date.parse(quote.actual_financing_period.maturity_at) !== Number(input.terms.maturity) * 1000) throw new Error('Quote and signed maturity differ');
  return createDisclosure({ ...input, terms: { ...input.terms, supply: String(quote.recommended_token_supply), issuePrice: price,
    target: '1000000', maxFee: '0' }, sources: input.sources });
}
