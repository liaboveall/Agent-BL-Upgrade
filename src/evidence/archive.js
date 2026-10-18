import path from 'node:path';
import { LedgerWriter } from '../ledger/writer.js';
import { readJson, writeJsonAtomic } from '../lib/jsonStore.js';
import { rightsKey, seal, unseal } from '../rights/vault.js';
import { privateCommitment } from '../rights/typedData.js';
import { hashSnapshot, stableStringify } from '../agent/decisionLogger.js';
import { createEvidence, evidenceHash, verifyEvidencePackage } from './schema.js';
import { HttpError } from '../app/http.js';

const AAD = 'agentbl-decision-evidence-archive-v1';
export class DecisionEvidenceArchive {
  constructor({ directory = null, env = {}, ownerFor = () => null, now = () => Date.now() } = {}) {
    Object.assign(this, { directory, env, ownerFor, now });
    this.writer = directory ? new LedgerWriter(directory) : null; this.memory = { schema: AAD, entries: {} };
  }
  configured() { return Boolean(rightsKey(this.env)); }
  async #transaction(task) {
    const key = rightsKey(this.env); if (!key) throw new HttpError(503, 'evidence_archive_not_configured', 'A separately managed evidence key is required');
    const run = async () => {
      const file = this.directory && path.join(this.directory, 'archive.json'), marker = this.directory && path.join(this.directory, 'initialized.json');
      const stored = file && await readJson(file), initialized = marker && await readJson(marker);
      if (!stored && initialized) throw new HttpError(503, 'evidence_archive_missing', 'Restore the initialized evidence archive before proceeding');
      const state = stored ? unseal(key, stored, AAD) : this.directory ? { schema: AAD, entries: {} } : structuredClone(this.memory);
      if (state.schema !== AAD) throw new Error('Unsupported evidence archive');
      const context = { dirty: false }, result = await task(state, context);
      if (context.dirty) {
        if (file) { await writeJsonAtomic(file, seal(key, state, AAD), { durable: true }); await writeJsonAtomic(marker, { schema: AAD }, { durable: true }); }
        else this.memory = state;
      }
      return result;
    };
    return this.writer ? this.writer.exclusive(run) : run();
  }
  capture(decision) {
    if (!this.configured()) return null;
    return this.#transaction((state, context) => {
      const source = JSON.parse(stableStringify(decision)), digest = hashSnapshot(source), existing = state.entries[decision.decision_id];
      if (existing) {
        if (existing.source_hash !== digest) throw new Error('Final evidence source changed; preserve the earlier terminal snapshot');
        return { commitment: existing.entry.commitment, evidence_id: existing.entry.bundle.evidence_id };
      }
      const material = { terminal_decision: source }, document = privateCommitment(material);
      const observed = Date.parse(decision.updated_at ?? decision.created_at);
      const time = this.now();
      const entry = createEvidence({ kind: 'raw_material', source: { provider: 'agentbl-recorded-runtime', version: decision.agent_version?.version_id ?? 'UNRECORDED_LEGACY',
        level: decision.mode === 'demo' ? 'synthetic' : 'provider_observed', source_hash: digest,
        observed_at: new Date(Number.isFinite(observed) ? Math.min(time, observed) : time).toISOString() }, references: [],
      data: { material_json: stableStringify(material), document_hash: document.hash, document_salt: document.salt } }, { now: time });
      state.entries[decision.decision_id] = { entry, source_hash: digest, owner_hash: this.ownerFor(decision.case_id), created_at: time };
      context.dirty = true; return { commitment: entry.commitment, evidence_id: entry.bundle.evidence_id };
    });
  }
  get(decisionId, { owner = null, admin = false } = {}) {
    return this.#transaction((state) => {
      const record = state.entries[decisionId];
      if (!record || record.owner_hash && !admin && record.owner_hash !== owner) throw new HttpError(404, 'evidence_not_found', 'Evidence not found');
      const pack = { schema: 'agentbl-evidence-package-v1', root_id: record.entry.bundle.evidence_id, entries: [record.entry] };
      const verification = verifyEvidencePackage(pack, { now: this.now() });
      if (!verification.passed) throw new HttpError(409, 'evidence_integrity_failed', 'Evidence is missing, expired or corrupt');
      return { ...pack, package_hash: evidenceHash('agentbl-evidence-package-v1', pack), verification };
    });
  }
}
