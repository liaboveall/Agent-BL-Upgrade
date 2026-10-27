import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { id, verifyTypedData } from 'ethers';
import { z } from 'zod';
import { HttpError } from '../app/http.js';
import { LedgerWriter } from '../ledger/writer.js';
import { readJson, writeJsonAtomic } from '../lib/jsonStore.js';
import { runtimePath } from '../runtimePaths.js';
import { canonicalJson } from '../mystery/fairness.js';
import { privateCommitment, publicSummary, SESSION_TYPES, ISSUANCE_TYPES, VALUATION_TYPES, rightsDomain, titleDomain } from './typedData.js';
import { rightsKey, seal, unseal } from './vault.js';
import { createEvidence, evidenceHash, evidenceProjection, verifyEvidencePackage } from '../evidence/schema.js';
import { createAgentVersion } from '../agent/runtime/agentVersion.js';
import { loadAgentConfig } from '../agent/runtime/config.js';
import { createDisclosure, verifyDisclosure } from './disclosure.js';
import { financingReview } from './financingReview.js';
import { materialWorkflow } from './workflow.js';
import { RpcReadPool } from './reads.js';

const VAULT_AAD = 'agentbl-rights-vault-v1';
const ROLES = ['issuer', 'holder', 'investor', 'reviewer', 'custodian', 'compliance', 'governance', 'valuer', 'operator', 'attestor', 'disposer'];
const subjectSchema = z.object({ organization: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u),
  wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/u), roles: z.array(z.enum(ROLES)).min(1).max(ROLES.length) }).strict();
const digest = (value) => createHash('sha256').update(value).digest('hex');
const checked = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'rights_invalid_input', 'Invalid rights input');
  return result.data;
};
function emptyState() { return { schema: VAULT_AAD, revision: 0, subjects: {}, challenges: {}, sessions: {}, materials: {}, publications: {}, plans: {} }; }
// Expired challenges and sessions grant nothing, but every write re-encrypts the whole vault. A day of
// grace keeps recent ones revocable and inspectable; older ones are dropped on the next write.
export const EXPIRED_ACCESS_RETENTION_MS = 24 * 60 * 60 * 1000;
export function pruneExpiredAccess(state, now) {
  const cutoff = now - EXPIRED_ACCESS_RETENTION_MS;
  for (const [key, challenge] of Object.entries(state.challenges)) if (challenge?.message?.validUntil * 1000 <= cutoff) delete state.challenges[key];
  for (const [key, session] of Object.entries(state.sessions)) if (session?.expires_at <= cutoff) delete state.sessions[key];
}

/** Durable, encrypted research identity and disclosure service. Every operation re-resolves
 * the current subject/session; no caller-supplied organization or role is trusted. */
export class RightsService {
  constructor({ env = process.env, directory = runtimePath('rights', env), clock = () => Date.now(), chain = null, getVersion = null, getMode = null, getGeneration = () => 0, readPool = chain?.readPool ?? new RpcReadPool() } = {}) {
    this.directory = directory; this.env = env; this.clock = clock; this.chain = chain;
    this.getVersion = getVersion; this.getMode = getMode; this.getGeneration = getGeneration; this.readPool = readPool;
    this.writer = new LedgerWriter(directory);
  }
  async status() {
    let configured = false;
    try { configured = Boolean(rightsKey(this.env)); } catch {}
    let active = false, unavailable = false;
    if (this.chain) { try { await this.chain.verify(); active = true; } catch { unavailable = true; } }
    return { scope: 'research_test_assets_only', business_enabled: false, candidate: active ? 'deployed_research_instance' : 'local_source',
      active_control_plane: active, unavailable, identity_configured: configured,
      external_rights_verified: false, trusted_provider_verified: false };
  }
  async #transaction(callback) {
    const key = rightsKey(this.env);
    if (!key) throw new HttpError(503, 'rights_not_configured', 'Research identity vault is not configured');
    return this.writer.exclusive(async () => {
      const file = path.join(this.directory, 'vault.json'), stored = await readJson(file);
      const marker = path.join(this.directory, 'vault-initialized.json'), initialized = await readJson(marker);
      if (!stored && initialized) throw new HttpError(503, 'rights_vault_missing', 'The initialized rights vault is missing; restore its history before continuing');
      const state = stored ? unseal(key, stored, VAULT_AAD) : emptyState();
      if (state.schema !== VAULT_AAD) throw new HttpError(503, 'rights_schema_mismatch', 'Rights vault schema is unsupported');
      const context = { key, now: this.clock(), dirty: false };
      const result = await callback(state, context);
      if (context.dirty) {
        pruneExpiredAccess(state, context.now);
        state.revision++;
        await writeJsonAtomic(file, seal(key, state, VAULT_AAD), { durable: true });
        if (!initialized) await writeJsonAtomic(marker, { schema: VAULT_AAD, initialized: true }, { durable: true });
      }
      return result;
    });
  }
  #principal(state, token, now, { allowExitOnly = false } = {}) {
    const session = /^[a-f0-9]{64}$/u.test(token ?? '') ? state.sessions[digest(token)] : null;
    const subject = session && state.subjects[session.subject_id];
    if (!session || session.revoked || session.expires_at <= now || !subject || (subject.revoked || session.exit_only) && !allowExitOnly) throw new HttpError(401, 'rights_session_required', 'A valid business session is required');
    return { ...subject, roles: subject.revoked || session.exit_only ? [] : subject.roles, exit_only: Boolean(subject.revoked || session.exit_only), session_id: session.session_id, expires_at: session.expires_at };
  }
  #material(state, principal, materialId, now) {
    const record = state.materials[materialId];
    if (!record || record.organization !== principal.organization || !principal.roles.some((role) => ['issuer', 'holder', 'reviewer', 'custodian', 'compliance', 'valuer', 'operator', 'attestor', 'disposer'].includes(role))) {
      throw new HttpError(404, 'rights_material_not_found', 'Material not found');
    }
    if (record.retention_until <= now) throw new HttpError(410, 'rights_material_expired', 'Material retention period has ended');
    return record;
  }
  createSubject(input) {
    const subject = checked(subjectSchema, input);
    if (/^0x0{40}$/iu.test(subject.wallet)) throw new HttpError(400, 'rights_invalid_input', 'A nonzero wallet is required');
    return this.#transaction((state, ctx) => {
      if (Object.values(state.subjects).some((item) => item.organization === subject.organization && item.wallet === subject.wallet.toLowerCase())) {
        throw new HttpError(409, 'rights_wallet_bound', 'Wallet is already bound in this organization');
      }
      const subject_id = randomUUID();
      state.subjects[subject_id] = { ...subject, subject_id, wallet: subject.wallet.toLowerCase(), revoked: false };
      ctx.dirty = true; return state.subjects[subject_id];
    });
  }
  revokeSubject(subjectId) {
    return this.#transaction((state, ctx) => {
      if (!state.subjects[subjectId]) throw new HttpError(404, 'rights_subject_not_found', 'Subject not found');
      state.subjects[subjectId].revoked = true; ctx.dirty = true; return { revoked: true };
    });
  }
  createChallenge(subjectId, { selfService = false, exitOnly = false } = {}) {
    return this.#transaction((state, ctx) => {
      const subject = state.subjects[subjectId];
      if (!subject || subject.revoked && !exitOnly) throw new HttpError(404, 'rights_subject_not_found', 'Subject not found');
      if (selfService && exitOnly) {
        const existing = Object.values(state.challenges).find((c) => c.subject_id === subjectId && c.exit_only && !c.used && c.message.validUntil * 1000 > ctx.now);
        if (existing) return { challenge_id: existing.challenge_id, domain: existing.domain, types: SESSION_TYPES, message: existing.message, exit_only: true };
      }
      if (selfService && Object.values(state.challenges).filter((c) => c.subject_id === subjectId && Boolean(c.exit_only) === exitOnly && !c.used && c.message.validUntil * 1000 > ctx.now).length >= 3) throw new HttpError(429, 'rights_challenge_rate_limited', 'Use an existing challenge or retry after five minutes');
      const challenge_id = randomUUID(), nonce = `0x${randomBytes(32).toString('hex')}`;
      const domain = { name: 'AgentBL Business Session', version: '1', salt: `0x${createHmac('sha256', ctx.key).update('business-session-domain-v1').digest('hex')}` };
      const message = { subject: id(subjectId), organization: id(subject.organization), wallet: subject.wallet, nonce, validUntil: Math.floor(ctx.now / 1000) + 300 };
      const challenge = { challenge_id, subject_id: subjectId, domain, types: SESSION_TYPES, message, used: false, exit_only: exitOnly };
      state.challenges[challenge_id] = challenge; ctx.dirty = true;
      return { challenge_id, domain, types: SESSION_TYPES, message, exit_only: exitOnly };
    });
  }
  openSession(input) {
    const { challenge_id, signature } = checked(z.object({ challenge_id: z.string().uuid(), signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/u) }).strict(), input);
    return this.#transaction((state, ctx) => {
      const challenge = state.challenges[challenge_id], subject = challenge && state.subjects[challenge.subject_id];
      if (!challenge || challenge.used || challenge.message.validUntil * 1000 <= ctx.now || !subject || subject.revoked && !challenge.exit_only) throw new HttpError(401, 'rights_challenge_invalid', 'Session challenge is unavailable');
      let signer;
      try { signer = verifyTypedData(challenge.domain, challenge.types, challenge.message, signature); } catch {}
      if (signer?.toLowerCase() !== subject.wallet) throw new HttpError(401, 'rights_signature_invalid', 'Wallet signature does not match the business subject');
      const token = randomBytes(32).toString('hex'), session_id = randomUUID(), expires_at = ctx.now + 60 * 60 * 1000;
      state.sessions[digest(token)] = { session_id, subject_id: subject.subject_id, expires_at, revoked: false, exit_only: Boolean(challenge.exit_only) };
      challenge.used = true; ctx.dirty = true;
      return { token, session_id, expires_at, subject_id: subject.subject_id, organization: subject.organization, exit_only: Boolean(challenge.exit_only), scope: 'research_test_assets_only' };
    });
  }
  revokeSession(sessionId) {
    return this.#transaction((state, ctx) => {
      const session = Object.values(state.sessions).find((item) => item.session_id === sessionId);
      if (!session) throw new HttpError(404, 'rights_session_not_found', 'Session not found');
      session.revoked = true; ctx.dirty = true; return { revoked: true };
    });
  }
  principal(token, options) { return this.#transaction((state, ctx) => this.#principal(state, token, ctx.now, options)); }
  createFinancingDisclosure(token, materialId, input, { save = true } = {}) {
    let pack;
    try { pack = createDisclosure(input); } catch { throw new HttpError(400, 'financing_disclosure_invalid', 'Complete valid research financing terms are required'); }
    return this.#transaction((state, ctx) => {
      const subject = this.#principal(state, token, ctx.now), material = this.#material(state, subject, materialId, ctx.now);
      if (material.owner_id !== subject.subject_id || !subject.roles.includes('issuer')
        || material.public_summary.asset_class !== pack.document.scenario.asset_class
        || pack.document.parties.issuer.toLowerCase() !== subject.wallet
        || pack.terms.documentHash !== material.document_hash) throw new HttpError(403, 'rights_publisher_required', 'Issuer and title material must match the disclosure');
      if (!save) return pack;
      state.financing_disclosures ??= {};
      const prior = Object.values(state.financing_disclosures).filter((entry) => entry.material_id === materialId);
      if (prior.some((entry) => entry.pack.document.revision === pack.document.revision && entry.pack.disclosure_hash !== pack.disclosure_hash)) {
        throw new HttpError(409, 'disclosure_revision_used', 'Use a new revision; published terms are immutable');
      }
      state.financing_disclosures[pack.disclosure_hash] = { material_id: materialId, pack };
      ctx.dirty = true; return pack;
    });
  }
  financingDisclosure(disclosureHash) {
    return this.#transaction((state) => {
      const entry = state.financing_disclosures?.[disclosureHash];
      if (!entry) throw new HttpError(409, 'financing_disclosure_missing', 'Readable financing terms are unavailable; do not sign');
      const approved = [...Object.values(state.publications), ...(state.publication_history ?? [])].some((publication) =>
        publication.publication_id === entry.material_id && publication.summary.terms_hash === entry.pack.terms_hash
        && publication.document_hash === entry.pack.terms.documentHash);
      if (!approved || !verifyDisclosure(entry.pack)) throw new HttpError(409, 'financing_disclosure_unverified', 'Terms must match an approved publication and intact commitments');
      return entry.pack;
    });
  }
  createEvidence(token, input) {
    const body = checked(z.object({ material_id: z.string().uuid(), kind: z.string(), source: z.unknown(),
      data: z.record(z.string(), z.unknown()).optional(), references: z.array(z.string().uuid()).max(99).default([]) }).strict(), input);
    return this.#transaction((state, ctx) => {
      const principal = this.#principal(state, token, ctx.now), material = this.#material(state, principal, body.material_id, ctx.now);
      if (!principal.roles.some((role) => ['issuer', 'holder', 'reviewer', 'custodian', 'compliance', 'valuer', 'operator', 'attestor', 'disposer'].includes(role))) throw new HttpError(403, 'rights_role_required', 'Evidence permission required');
      state.evidence ??= {};
      const references = body.references.map((id) => {
        const entry = state.evidence[id];
        if (!entry || entry.organization !== principal.organization || entry.material_id !== body.material_id
          || Date.parse(entry.bundle.expires_at) <= ctx.now) throw new HttpError(409, 'evidence_reference_unavailable', 'Referenced evidence is unavailable');
        return { evidence_id: id, commitment: entry.commitment };
      });
      const raw = body.kind === 'raw_material' ? unseal(ctx.key, material.encrypted_material, `${material.organization}:${material.material_id}:${material.revision}`) : null;
      let entry;
      try { entry = createEvidence({ kind: body.kind, source: body.source, references,
        data: raw ? { material_json: JSON.stringify(raw.material), document_hash: material.document_hash, document_salt: raw.salt } : body.data },
      { now: ctx.now, expiresAt: material.retention_until }); }
      catch { throw new HttpError(400, 'evidence_invalid', 'Evidence schema or canonical values are invalid'); }
      state.evidence[entry.bundle.evidence_id] = { ...entry, material_id: body.material_id, organization: principal.organization };
      ctx.dirty = true;
      return { evidence_id: entry.bundle.evidence_id, ...evidenceProjection(entry) };
    });
  }
  exportEvidence(token, evidenceId) {
    return this.#transaction((state, ctx) => {
      const principal = this.#principal(state, token, ctx.now), entries = new Map();
      const visit = (id) => {
        if (entries.has(id)) return;
        const entry = state.evidence?.[id];
        if (!entry || entry.organization !== principal.organization) throw new HttpError(404, 'evidence_not_found', 'Evidence not found');
        this.#material(state, principal, entry.material_id, ctx.now);
        if (entries.size >= 100) throw new HttpError(409, 'evidence_package_limit', 'Evidence dependency limit exceeded');
        entries.set(id, { bundle: entry.bundle, commitment: entry.commitment });
        for (const ref of entry.bundle.references) visit(ref.evidence_id);
      };
      visit(evidenceId);
      const pack = { schema: 'agentbl-evidence-package-v1', root_id: evidenceId, entries: [...entries.values()] };
      const verification = verifyEvidencePackage(pack, { now: ctx.now });
      if (!verification.passed) throw new HttpError(409, 'evidence_integrity_failed', 'Evidence is missing, expired or corrupt');
      return { ...pack, package_hash: evidenceHash('agentbl-evidence-package-v1', pack), verification };
    });
  }
  requestEvidenceReview(token, evidenceId, input) {
    const body = checked(z.object({ reason: z.string().min(1).max(1000) }).strict(), input);
    return this.#transaction((state, ctx) => {
      const principal = this.#principal(state, token, ctx.now), entry = state.evidence?.[evidenceId];
      if (!entry || entry.organization !== principal.organization) throw new HttpError(404, 'evidence_not_found', 'Evidence not found');
      const material = this.#material(state, principal, entry.material_id, ctx.now);
      const version = this.getVersion?.() ?? createAgentVersion(loadAgentConfig(this.env), this.env).version_id;
      const context_hash = evidenceHash('agentbl-human-review-context-v1', { commitment: entry.commitment, revision: material.revision, version });
      state.evidence_reviews ??= {};
      const review = { review_id: randomUUID(), evidence_id: evidenceId, organization: principal.organization,
        material_id: entry.material_id, requested_by: principal.subject_id, requested_wallet: principal.wallet,
        reason: body.reason, context_hash, status: 'PENDING', created_at: ctx.now, history: [] };
      state.evidence_reviews[review.review_id] = review; ctx.dirty = true;
      return { review_id: review.review_id, context_hash, status: review.status, business_enabled: false };
    });
  }
  resolveEvidenceReview(token, reviewId, input) {
    const body = checked(z.object({ context_hash: z.string().regex(/^0x[a-f0-9]{64}$/u), verdict: z.enum(['APPROVE', 'REJECT']),
      reason: z.string().min(1).max(1000) }).strict(), input);
    return this.#transaction((state, ctx) => {
      const principal = this.#principal(state, token, ctx.now), review = state.evidence_reviews?.[reviewId];
      if (!review || review.organization !== principal.organization) throw new HttpError(404, 'evidence_review_not_found', 'Review not found');
      if (!principal.roles.includes('reviewer') || review.requested_by === principal.subject_id || review.requested_wallet === principal.wallet) throw new HttpError(403, 'rights_independent_review_required', 'An independent reviewer is required');
      const entry = state.evidence?.[review.evidence_id], material = this.#material(state, principal, review.material_id, ctx.now);
      const version = this.getVersion?.() ?? createAgentVersion(loadAgentConfig(this.env), this.env).version_id;
      const current = entry && evidenceHash('agentbl-human-review-context-v1', { commitment: entry.commitment, revision: material.revision, version });
      if (review.status !== 'PENDING' || review.context_hash !== body.context_hash || review.context_hash !== current
        || Date.parse(entry.bundle.expires_at) <= ctx.now) throw new HttpError(409, 'evidence_review_stale', 'Evidence, version or review state changed; create a new review');
      review.status = body.verdict === 'APPROVE' ? 'APPROVED_RESEARCH_ONLY' : 'REJECTED';
      review.history.push({ verdict: body.verdict, reviewer: principal.subject_id, wallet: principal.wallet, reason: body.reason, at: ctx.now, context_hash: current });
      ctx.dirty = true; return { review_id: reviewId, status: review.status, context_hash: current, business_enabled: false };
    });
  }
  createMaterial(token, input) {
    const body = checked(z.object({ material: z.record(z.string(), z.unknown()), public_summary: z.unknown() }).strict(), input);
    let summary;
    try { summary = publicSummary(body.public_summary); } catch { throw new HttpError(400, 'rights_public_projection_invalid', 'Public summary must use only approved non-identifying fields'); }
    return this.#transaction((state, ctx) => {
      const subject = this.#principal(state, token, ctx.now);
      if (!subject.roles.some((role) => ['issuer', 'holder'].includes(role))) throw new HttpError(403, 'rights_role_required', 'Issuer or holder permission required');
      const material_id = randomUUID(), commitment = privateCommitment(body.material);
      const record = { material_id, organization: subject.organization, owner_id: subject.subject_id, owner_wallet: subject.wallet,
        revision: 1, document_hash: commitment.hash, public_summary: summary, reviews: [], created_at: ctx.now, retention_until: ctx.now + 90 * 86400000 };
      record.encrypted_material = seal(ctx.key, { material: body.material, salt: commitment.salt }, `${record.organization}:${material_id}:1`);
      state.materials[material_id] = record; ctx.dirty = true;
      return { material_id, document_hash: record.document_hash, revision: 1, retention_until: record.retention_until };
    });
  }
  readMaterial(token, materialId) {
    return this.#transaction((state, ctx) => {
      const subject = this.#principal(state, token, ctx.now), record = this.#material(state, subject, materialId, ctx.now);
      return { material_id: materialId, organization: record.organization, revision: record.revision, document_hash: record.document_hash,
        ...unseal(ctx.key, record.encrypted_material, `${record.organization}:${materialId}:${record.revision}`), public_summary: record.public_summary,
        reviews: record.reviews.map(({ subject_id, revision }) => ({ subject_id, revision })), retention_until: record.retention_until };
    });
  }
  reviewMaterial(token, materialId, { document_hash, terms_hash } = {}) {
    return this.#transaction((state, ctx) => {
      const subject = this.#principal(state, token, ctx.now), record = this.#material(state, subject, materialId, ctx.now);
      if (!subject.roles.includes('reviewer') || subject.subject_id === record.owner_id || subject.wallet === record.owner_wallet) throw new HttpError(403, 'rights_independent_review_required', 'Independent reviewer permission required');
      if (document_hash !== record.document_hash || terms_hash !== record.public_summary.terms_hash) throw new HttpError(409, 'rights_review_changed', 'Review must bind the current document and terms');
      if (record.reviews.some((item) => item.wallet === subject.wallet)) throw new HttpError(409, 'rights_already_reviewed', 'This reviewer already approved the record');
      record.reviews.push({ subject_id: subject.subject_id, wallet: subject.wallet, revision: record.revision, document_hash, terms_hash, reviewed_at: ctx.now });
      ctx.dirty = true; return { material_id: materialId, approvals: record.reviews.length };
    });
  }
  bindTerms(token, materialId, termsHash) {
    if (!/^0x[a-fA-F0-9]{64}$/u.test(termsHash ?? '')) throw new HttpError(400, 'rights_invalid_input', 'A full terms commitment is required');
    return this.#transaction((state, ctx) => {
      const subject = this.#principal(state, token, ctx.now), record = this.#material(state, subject, materialId, ctx.now);
      if (record.owner_id !== subject.subject_id || !subject.roles.includes('issuer')) throw new HttpError(403, 'rights_publisher_required', 'Only the issuing subject can revise proposed terms');
      const material = unseal(ctx.key, record.encrypted_material, `${record.organization}:${materialId}:${record.revision}`);
      record.history ??= [];
      record.history.push({ revision: record.revision, public_summary: record.public_summary, reviews: record.reviews, changed_at: ctx.now });
      record.revision++; record.public_summary = { ...record.public_summary, terms_hash: termsHash }; record.reviews = [];
      record.encrypted_material = seal(ctx.key, material, `${record.organization}:${materialId}:${record.revision}`);
      ctx.dirty = true; return { material_id: materialId, revision: record.revision, document_hash: record.document_hash, terms_hash: termsHash };
    });
  }
  publishMaterial(token, materialId) {
    return this.#transaction((state, ctx) => {
      const subject = this.#principal(state, token, ctx.now), record = this.#material(state, subject, materialId, ctx.now);
      if (subject.subject_id !== record.owner_id || !subject.roles.includes('issuer')) throw new HttpError(403, 'rights_publisher_required', 'The issuing subject must publish this record');
      const reviews = record.reviews.filter((review) => !state.subjects[review.subject_id]?.revoked && state.subjects[review.subject_id]?.roles.includes('reviewer')
        && review.revision === record.revision && review.document_hash === record.document_hash && review.terms_hash === record.public_summary.terms_hash);
      if (reviews.length < 2) throw new HttpError(409, 'rights_two_reviews_required', 'Two independent current approvals are required');
      const publication = { publication_id: materialId, scope: 'research_test_assets_only', revision: record.revision,
        document_hash: record.document_hash, summary: publicSummary(record.public_summary), published_at: ctx.now };
      // Copy the approved projection. Never return the encrypted record or raw private material.
      if (state.publications[materialId]?.revision !== publication.revision && state.publications[materialId]) {
        state.publication_history ??= [];
        state.publication_history.push(structuredClone(state.publications[materialId]));
      }
      state.publications[materialId] = structuredClone(publication); ctx.dirty = true; return publication;
    });
  }
  publication(materialId) {
    return this.#transaction((state) => {
      const publication = state.publications[materialId];
      if (!publication) throw new HttpError(404, 'rights_publication_not_found', 'Publication not found');
      return publication;
    });
  }
  async invoke(token, operation, materialId, transport) {
    if (!['http', 'download', 'sse', 'mcp', 'a2a'].includes(transport)) throw new HttpError(400, 'rights_transport_invalid', 'Unsupported rights transport');
    if (operation === 'read_material') return this.readMaterial(token, materialId);
    if (operation === 'read_evidence') return this.exportEvidence(token, materialId);
    if (operation === 'read_publication') return this.publication(materialId);
    throw new HttpError(404, 'rights_operation_unknown', 'Unknown rights operation');
  }
  async signingRequest(token, materialId, input) {
    const principal = await this.principal(token);
    if (!this.chain) throw new HttpError(503, 'rights_chain_not_configured', 'Verified chain unavailable');
    const binding = await this.chain.verify({ read: this.readPool.budget(100).read });
    if (binding.exit_only || this.getMode && this.getMode() !== 'live') throw new HttpError(409, 'live_mode_required', 'An active v2 Live instance is required');
    const material = await this.readMaterial(token, materialId), registryAddress = await this.chain.registry.getAddress();
    const kind = input?.kind, value = input?.value;
    const fields = kind === 'issuance' ? ISSUANCE_TYPES.Issuance : kind === 'valuation' ? VALUATION_TYPES.Valuation : [];
    if (!value || !fields.length || Object.keys(value).some((key) => !fields.some((field) => field.name === key))) throw new HttpError(400, 'rights_signing_input_invalid', 'Only the defined typed signature fields are allowed');
    const result = await this.#transaction((state, ctx) => {
      const current = this.#principal(state, token, ctx.now), record = this.#material(state, current, materialId, ctx.now);
      const pack = Object.values(state.financing_disclosures ?? {}).find((entry) => entry.material_id === materialId && entry.pack.terms_hash === record.public_summary.terms_hash)?.pack;
      if (kind === 'valuation' && current.roles.includes('valuer') && pack && value?.termsHash === pack.terms_hash && value?.assetKey === pack.terms.assetKey
        && value?.settlementAsset?.toLowerCase() === pack.terms.settlementAsset.toLowerCase()) {
        return { domain: rightsDomain(Number(this.chain.chainId), binding.controller), types: VALUATION_TYPES, value, kind, terms: pack };
      }
      if (kind === 'issuance' && current.roles.includes('issuer') && record.owner_id === current.subject_id && value?.documentHash === material.document_hash) {
        return { domain: titleDomain(Number(this.chain.chainId), registryAddress), types: ISSUANCE_TYPES, value, kind };
      }
      throw new HttpError(403, 'rights_signing_scope_invalid', 'Role, material and exact terms must match the signature request');
    });
    const { TypedDataEncoder } = await import('ethers');
    try { TypedDataEncoder.hash(result.domain, result.types, result.value); } catch { throw new HttpError(400, 'rights_signing_input_invalid', 'Signature fields are invalid'); }
    if (kind === 'valuation' && !await this.chain.controller.roles(id('VALUER'), principal.wallet)
      || kind === 'issuance' && (await this.chain.registry.issuerForOrg(value.issuerOrg)).toLowerCase() !== principal.wallet) throw new HttpError(403, 'rights_onchain_role_required', 'Current on-chain signer permission is required');
    return result;
  }
  listMaterials(token) {
    return this.#transaction((state, ctx) => {
      const principal = this.#principal(state, token, ctx.now);
      return { materials: Object.values(state.materials).filter((record) => record.organization === principal.organization && record.retention_until > ctx.now
        && principal.roles.some((role) => ['issuer', 'holder', 'reviewer', 'custodian', 'compliance', 'valuer', 'operator', 'attestor', 'disposer'].includes(role)))
        .map((record) => ({ material_id: record.material_id, revision: record.revision, document_hash: record.document_hash, public_summary: record.public_summary })) };
    });
  }
  async workflow(token, materialId) {
    const principal = await this.principal(token);
    const input = await this.#transaction((state, ctx) => {
      const current = this.#principal(state, token, ctx.now), record = this.#material(state, current, materialId, ctx.now);
      const pack = Object.values(state.financing_disclosures ?? {}).find((entry) => entry.material_id === materialId && entry.pack.terms_hash === record.public_summary.terms_hash)?.pack;
      const approvals = record.reviews.filter((review) => !state.subjects[review.subject_id]?.revoked && review.revision === record.revision && review.terms_hash === record.public_summary.terms_hash).length;
      return { record: structuredClone(record), pack, approvals, published: state.publications[materialId]?.revision === record.revision };
    });
    return materialWorkflow(this.chain, principal, input.record, input.pack, input.published, input.approvals, this.readPool);
  }
  async checkpointPlan(token, planId) {
    const draft = await this.#transaction((state, ctx) => {
      const principal = this.#principal(state, token, ctx.now), plan = state.plans[planId];
      if (!plan || plan.subject_id !== principal.subject_id) throw new HttpError(404, 'rights_plan_not_found', 'Transaction plan not found');
      return structuredClone(plan);
    });
    if (draft.operation === 'acknowledge_terms') {
      const reviewed = await financingReview(this.chain, this, draft.plan_input.pool_id);
      if (draft.plan_input.reviewed_disclosure_hash !== reviewed.disclosure_hash || String(draft.plan_input.quote_version) !== reviewed.quote_version) throw new HttpError(409, 'financing_review_required', 'Review current complete terms before wallet submission');
    }
    return this.#transaction(async (state, ctx) => {
      const principal = this.#principal(state, token, ctx.now), plan = state.plans[planId];
      if (!plan || plan.subject_id !== principal.subject_id) throw new HttpError(404, 'rights_plan_not_found', 'Transaction plan not found');
      if (plan.status !== 'draft') throw new HttpError(409, 'rights_plan_reconcile_required', 'Reconcile the original operation before another wallet send');
      if (this.getMode && this.getMode() !== 'live' || plan.execution_generation !== this.getGeneration() || plan.session_id !== principal.session_id
        || plan.material_id && plan.material_revision !== state.materials[plan.material_id]?.revision) throw new HttpError(409, 'execution_context_changed', 'Session, mode or material changed; prepare a new review');
      if (!this.chain) throw new HttpError(503, 'rights_chain_not_configured', 'Verified chain unavailable');
      const fresh = await this.chain.prepare(principal, plan.plan_input);
      if (plan.execution_generation !== this.getGeneration() || this.getMode && this.getMode() !== 'live') throw new HttpError(409, 'execution_context_changed', 'Execution context changed before broadcast');
      if (fresh.chain_id !== plan.chain_id || fresh.pool !== plan.pool || fresh.controller !== plan.controller || fresh.calldata !== plan.calldata
        || fresh.nonce !== plan.nonce) throw new HttpError(409, 'rights_plan_changed', 'Chain, nonce or transaction changed; prepare a new review');
      if (plan.material_id) {
        const material = this.#material(state, principal, plan.material_id, ctx.now);
        if (plan.operation === 'create_offering') {
          const valid = material.reviews.filter((review) => !state.subjects[review.subject_id]?.revoked && review.revision === material.revision);
          if (valid.length < 2 || state.publications[plan.material_id]?.revision !== material.revision) throw new HttpError(409, 'rights_approved_disclosure_required', 'Current independent reviews are required');
        }
      }
      if (Object.values(state.plans).some((other) => other.plan_id !== planId && other.from === plan.from && other.chain_id === plan.chain_id
        && !['draft', 'confirmed', 'reverted'].includes(other.status))) throw new HttpError(409, 'rights_plan_reconcile_required', 'Reconcile the saved wallet operation before another send');
      plan.status = 'broadcast_prepared'; plan.checkpoint_at = ctx.now; ctx.dirty = true; return plan;
    });
  }
  async prepareTransaction(token, input) {
    const principal = await this.principal(token);
    if (this.getMode && this.getMode() !== 'live') throw new HttpError(409, 'live_mode_required', 'Switch to Live before preparing a wallet action');
    const generation = this.getGeneration();
    if (!this.chain) throw new HttpError(409, 'rights_chain_not_configured', 'No verified W3 protocol instance is configured');
    const plan = await this.chain.prepare(principal, input);
    if (input.operation === 'acknowledge_terms') {
      const reviewed = await financingReview(this.chain, this, input.pool_id);
      if (input.reviewed_disclosure_hash !== reviewed.disclosure_hash || String(input.quote_version) !== reviewed.quote_version) throw new HttpError(409, 'financing_review_required', 'Review current complete terms before accepting');
    }
    return this.#transaction((state, ctx) => {
      const current = this.#principal(state, token, ctx.now);
      if (current.subject_id !== principal.subject_id) throw new HttpError(401, 'rights_session_required', 'Business session changed');
      if (input.material_id) {
        const material = this.#material(state, current, input.material_id, ctx.now);
        if (input.operation === 'register_title' && input.payload?.issuance?.documentHash !== material.document_hash
          || input.operation === 'pledge' && input.terms_hash !== material.public_summary.terms_hash) throw new HttpError(409, 'rights_material_changed', 'Material commitment and operation must match');
      }
      if (generation !== this.getGeneration() || this.getMode && this.getMode() !== 'live') throw new HttpError(409, 'execution_context_changed', 'Mode changed while preparing the action');
      if (input.operation === 'create_offering') {
        const record = this.#material(state, current, input.material_id, ctx.now), published = state.publications[input.material_id];
        const reviews = record.reviews.filter((review) => !state.subjects[review.subject_id]?.revoked && state.subjects[review.subject_id]?.roles.includes('reviewer')
          && review.revision === record.revision && review.document_hash === record.document_hash && review.terms_hash === record.public_summary.terms_hash);
        if (record.owner_id !== current.subject_id || !published || reviews.length < 2 || published.revision !== record.revision
          || published.document_hash !== plan.document_hash || published.summary.terms_hash !== plan.terms_hash || record.public_summary.terms_hash !== plan.terms_hash) {
          throw new HttpError(409, 'rights_approved_disclosure_required', 'Issuance requires this subject\'s reviewed document and exact published terms');
        }
        const pack = state.financing_disclosures?.[input.payload?.terms?.disclosureHash]?.pack;
        if (!pack || !verifyDisclosure(pack) || pack.terms_hash !== plan.terms_hash
          || String(pack.document.instance.chain_id) !== plan.chain_id
          || pack.document.instance.controller.toLowerCase() !== plan.controller.toLowerCase()
          || pack.document.instance.pool.toLowerCase() !== plan.pool.toLowerCase()) throw new HttpError(409, 'financing_disclosure_missing', 'Issuance requires complete immutable readable terms for this instance');
      }
      const plan_id = randomUUID();
      const saved = { ...plan, plan_id, subject_id: principal.subject_id, organization: principal.organization, prepared_at: ctx.now,
        plan_hash: digest(canonicalJson(plan)), execution: 'unsigned_dry_run', status: 'draft', execution_generation: generation, session_id: current.session_id, plan_input: structuredClone(input),
        ...(input.material_id ? { material_revision: state.materials[input.material_id]?.revision } : {}) };
      state.plans[plan_id] = saved; ctx.dirty = true; return saved;
    });
  }
  getPlan(token, planId) {
    return this.#transaction(async (state, ctx) => {
      const principal = this.#principal(state, token, ctx.now), plan = state.plans[planId];
      if (!plan || plan.subject_id !== principal.subject_id) throw new HttpError(404, 'rights_plan_not_found', 'Transaction plan not found');
      if (this.chain) {
        const observed = plan.tx_hash ? await this.chain.verifyTransaction(plan, plan.tx_hash) : await this.chain.recoverTransaction(plan);
        if (observed?.tx_hash && Object.values(state.plans).some((other) => other.plan_id !== planId && other.tx_hash?.toLowerCase() === observed.tx_hash.toLowerCase())) {
          throw new HttpError(409, 'rights_transaction_reused', 'Transaction is already bound to another plan');
        }
        if (observed?.status === 'reconciling' && plan.block_hash) {
          plan.receipt_history ??= [];
          plan.receipt_history.push({ tx_hash: plan.tx_hash, block_number: plan.block_number, block_hash: plan.block_hash, status: plan.status, invalidated_at: ctx.now });
        }
        if (observed) { Object.assign(plan, observed); ctx.dirty = true; }
      }
      return plan;
    });
  }
  async attachTransaction(token, planId, txHash) {
    if (!/^0x[a-fA-F0-9]{64}$/u.test(txHash ?? '')) throw new HttpError(400, 'rights_tx_hash_invalid', 'A transaction hash is required');
    if (!this.chain) throw new HttpError(409, 'rights_chain_not_configured', 'No verified W3 protocol instance is configured');
    return this.#transaction(async (state, ctx) => {
      const principal = this.#principal(state, token, ctx.now), plan = state.plans[planId];
      if (!plan || plan.subject_id !== principal.subject_id) throw new HttpError(404, 'rights_plan_not_found', 'Transaction plan not found');
      if (plan.tx_hash && plan.tx_hash.toLowerCase() !== txHash.toLowerCase()) throw new HttpError(409, 'rights_plan_already_bound', 'Plan already has a different transaction; reconcile it first');
      if (Object.values(state.plans).some((other) => other.plan_id !== planId && other.tx_hash?.toLowerCase() === txHash.toLowerCase())) throw new HttpError(409, 'rights_transaction_reused', 'Transaction is already bound to another plan');
      Object.assign(plan, await this.chain.verifyTransaction(plan, txHash)); ctx.dirty = true; return plan;
    });
  }
}
