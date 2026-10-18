import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { privateCommitment } from '../rights/typedData.js';
import { verifyAnchorRecord } from '../agent/runtime/anchorProof.js';

export const EVIDENCE_SCHEMA = 'agentbl-evidence-v1';
const hash = z.string().regex(/^0x[0-9a-f]{64}$/u);
const atomic = z.string().regex(/^(0|[1-9][0-9]*)$/u).max(78);
const text = z.string().min(1).max(1000);
const time = z.string().datetime({ precision: 3, offset: false });
const object = z.record(z.string(), z.unknown());
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/u);
const network = z.string().regex(/^eip155:[1-9][0-9]*$/u);
export const EVIDENCE_DATA = Object.freeze({
  raw_material: z.object({ material_json: z.string().min(1).max(500000), document_hash: hash, document_salt: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  valuation: z.object({ amount_atomic: atomic, currency: z.enum(['USD', 'CNY', 'EUR', 'SGD', 'TEST_USDC']),
    decimals: z.number().int().min(0).max(18), basis: z.enum(['declared', 'rule_estimate', 'independent_attestation']),
    as_of: time, expires_at: time, assumptions: object }).strict(),
  offering_terms: z.object({ terms_hash: hash, network, terms: object }).strict(),
  approval: z.object({ target_hash: hash, version_hash: hash, verdict: z.enum(['APPROVE', 'REJECT', 'REVIEW']), actor_ref: text, reason: text }).strict(),
  execution: z.object({ plan_hash: hash, network, transaction_hash: hash.nullable(),
    block_hash: hash.nullable(), status: z.enum(['PLANNED', 'UNKNOWN', 'CONFIRMED', 'REVERTED', 'REORGED']) }).strict(),
  payment: z.object({ network, asset: address, payer: address, payee: address, amount_atomic: atomic, nonce: hash,
    transaction_hash: hash, block_hash: hash, confirmations: z.number().int().positive() }).strict()
});
const bundleSchema = z.object({ schema: z.literal(EVIDENCE_SCHEMA), evidence_id: z.string().uuid(),
  kind: z.enum(Object.keys(EVIDENCE_DATA)), created_at: time, expires_at: time,
  source: z.object({ provider: text, version: text, level: z.enum(['synthetic', 'public_specimen', 'provider_observed', 'independent_verified']),
    source_hash: hash, observed_at: time }).strict(),
  references: z.array(z.object({ evidence_id: z.string().uuid(), commitment: hash }).strict()).max(100),
  data: object, salt: hash }).strict();

/** A deliberately small JSON domain: no implicit undefined/null coercion, floating amounts,
 * custom prototypes, nonfinite numbers or Unicode/key normalization that changes a document. */
export function canonicalEvidence(value) {
  const visit = (item, depth = 0) => {
    if (depth > 64) throw new Error('Evidence nesting exceeds the supported depth');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) throw new Error('Evidence numbers must be safe integers; use decimal strings for amounts');
      return String(item);
    }
    if (Array.isArray(item)) return `[${Array.from(item, (child) => visit(child, depth + 1)).join(',')}]`;
    if (!item || Object.getPrototypeOf(item) !== Object.prototype) throw new Error('Evidence must contain only explicit JSON values');
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${visit(item[key], depth + 1)}`).join(',')}}`;
  };
  return visit(value);
}
export function evidenceHash(domain, value) {
  return `0x${createHash('sha256').update(`${domain}\0${canonicalEvidence(value)}`).digest('hex')}`;
}
/** Freeze an existing numerical research snapshot without doing any arithmetic or rounding.
 * Exact chain amounts use the stricter atomic-string schemas above. Missing optional values
 * become explicit null; a verifier need not share JavaScript's object enumeration order. */
export function snapshotForEvidence(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Nonfinite evidence snapshot value');
    return String(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return value.map(snapshotForEvidence);
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, snapshotForEvidence(value[key])]));
  if (typeof value !== 'string' && typeof value !== 'boolean') throw new Error('Unsupported snapshot value');
  return value;
}
export function validateEvidence(bundle) {
  const parsed = bundleSchema.parse(bundle);
  EVIDENCE_DATA[parsed.kind].parse(parsed.data);
  if (parsed.kind === 'valuation' && (Date.parse(parsed.data.as_of) > Date.parse(parsed.created_at) || Date.parse(parsed.data.expires_at) <= Date.parse(parsed.data.as_of))) throw new Error('Invalid valuation validity range');
  if (parsed.kind === 'execution' && parsed.data.status === 'CONFIRMED' && (!parsed.data.transaction_hash || !parsed.data.block_hash)) throw new Error('Confirmed execution needs an exact receipt reference');
  if (parsed.kind === 'offering_terms') for (const [key, value] of Object.entries(parsed.data.terms)) {
    if (/(?:amount|price|supply|target|minraise|maxfee|fee|value)$/iu.test(key) && !atomic.safeParse(value).success) throw new Error('Offering amounts must be exact atomic strings');
  }
  if (parsed.kind === 'raw_material' && privateCommitment(JSON.parse(parsed.data.material_json), parsed.data.document_salt).hash !== parsed.data.document_hash) throw new Error('Source material commitment mismatch');
  canonicalEvidence(parsed);
  if (Date.parse(parsed.expires_at) <= Date.parse(parsed.created_at) || Date.parse(parsed.source.observed_at) > Date.parse(parsed.created_at)) throw new Error('Invalid evidence time range');
  if (new Set(parsed.references.map((ref) => ref.evidence_id)).size !== parsed.references.length
      || parsed.references.some((ref) => ref.evidence_id === parsed.evidence_id)) throw new Error('Invalid evidence references');
  return parsed;
}
export function createEvidence(input, { now = Date.now(), expiresAt = now + 90 * 86400000 } = {}) {
  const bundle = validateEvidence({ ...input, schema: EVIDENCE_SCHEMA, evidence_id: randomUUID(),
    created_at: new Date(now).toISOString(), expires_at: new Date(expiresAt).toISOString(), salt: `0x${randomBytes(32).toString('hex')}` });
  return { bundle, commitment: evidenceHash(EVIDENCE_SCHEMA, bundle) };
}
export function evidenceProjection({ bundle, commitment }) {
  return { schema: EVIDENCE_SCHEMA, kind: bundle.kind, commitment };
}

/** Self-contained authorized export. Availability, integrity, expiry and Merkle inclusion are
 * separate results. A commitment proves bytes, never truth of the provider or source document. */
export function verifyEvidencePackage(pack, { now = Date.now(), expectedCommitment = null, anchor = pack?.anchor ?? null } = {}) {
  const checks = [], add = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  try {
    add('package_schema', pack?.schema === 'agentbl-evidence-package-v1' && Array.isArray(pack.entries) && pack.entries.length > 0 && pack.entries.length <= 100);
    if (!checks[0].passed) throw new Error('Invalid package');
    const entries = new Map();
    for (const entry of pack.entries) {
      const bundle = validateEvidence(entry.bundle);
      add(`commitment:${bundle.evidence_id}`, evidenceHash(EVIDENCE_SCHEMA, bundle) === entry.commitment && !entries.has(bundle.evidence_id));
      add(`available:${bundle.evidence_id}`, Date.parse(bundle.expires_at) > now && Date.parse(bundle.created_at) <= now);
      if (bundle.kind === 'valuation') add(`valuation_current:${bundle.evidence_id}`, Date.parse(bundle.data.expires_at) > now);
      entries.set(bundle.evidence_id, entry);
    }
    add('root_present', entries.has(pack.root_id));
    const root = entries.get(pack.root_id);
    if (expectedCommitment) add('expected_root_commitment', root?.commitment === expectedCommitment);
    if (anchor) {
      add('merkle_inclusion', verifyAnchorRecord(anchor).passed);
      add('anchor_evidence_binding', anchor.payload?.evidence_commitments?.includes(root?.commitment));
    }
    for (const { bundle } of entries.values()) for (const ref of bundle.references) add(`reference:${ref.evidence_id}`, entries.get(ref.evidence_id)?.commitment === ref.commitment);
    const visited = new Set(), active = new Set();
    const visit = (id) => {
      if (active.has(id)) throw new Error('Cyclic evidence');
      if (visited.has(id) || !entries.has(id)) return;
      active.add(id); for (const ref of entries.get(id).bundle.references) visit(ref.evidence_id);
      active.delete(id); visited.add(id);
    };
    visit(pack.root_id); add('complete_connected_package', visited.size === entries.size);
    if (pack.package_hash) add('package_hash', pack.package_hash === evidenceHash('agentbl-evidence-package-v1', { schema: pack.schema, root_id: pack.root_id, entries: pack.entries }));
  } catch { add('supported_schema_and_content', false); }
  return { passed: checks.length > 0 && checks.every((check) => check.passed), checks,
    commitment_bound: Boolean(expectedCommitment || anchor), anchor_chain_verified: false, source_truth_verified: false };
}
