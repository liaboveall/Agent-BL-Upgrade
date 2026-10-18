// Document intake: validate an upload, store it by content
// and open a job that the ingest pipeline works through.
//
//   POST /api/agent/ingest ─► validate (type, magic bytes, size) ─► store by SHA-256 ─► job
//                                                                      │
//                                         DOCUMENTS_INGESTED event ◄───┘  (the AgentService submits it)
//
// What this module does NOT do: it never reads document content as instructions, and it never claims
// an upload was verified. The ENI record is a MOCK acknowledgement and says so (`mode: 'mock'`).

import crypto from 'node:crypto';
import { evidenceMetadata } from '../runtime/freshness.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteQueue, readJson, writeFileAtomic, writeJsonAtomic } from '../../lib/jsonStore.js';
import { cargoIdentityHashV2 } from '../../chain/cargoIdentity.js';

export const ALLOWED_MIME_TYPES = Object.freeze({
  'text/markdown': { ext: 'md', kind: 'text' },
  'text/plain': { ext: 'txt', kind: 'text' },
  'application/pdf': { ext: 'pdf', kind: 'pdf' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/jpeg': { ext: 'jpg', kind: 'image' }
});

export const MAX_DOCUMENTS_PER_UPLOAD = 12;
const MAX_JOBS = 500;
const MAX_NAME_LENGTH = 255;
const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/u;

export class IngestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

/** Keep only the base name and drop control characters so it is safe to log and echo. */
export function safeFileName(value) {
  const base = String(value ?? '').split(/[\\/]/u).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, MAX_NAME_LENGTH);
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** The real type of the bytes, or null if they are not what the declared MIME type says. */
function magicMatches(mime, buffer) {
  switch (mime) {
    case 'application/pdf':
      return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'image/png':
      return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    default: {
      if (buffer.includes(0)) return false; // NUL bytes: this is binary, not text
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        return true;
      } catch {
        return false;
      }
    }
  }
}

function bytesOf(document, maxBytes) {
  const hasText = typeof document.text === 'string';
  const hasBase64 = typeof document.content_base64 === 'string';
  if (hasText === hasBase64) {
    throw new IngestError('invalid_document', 'Each document needs exactly one of text or content_base64');
  }
  if (hasText) {
    if (Buffer.byteLength(document.text) > maxBytes) throw new IngestError('document_too_large', `A document exceeds ${maxBytes} bytes`, 413);
    return Buffer.from(document.text, 'utf8');
  }
  // base64 inflates by ~4/3: reject on the encoded length first so a huge string is never decoded.
  if (document.content_base64.length > Math.ceil(maxBytes * 4 / 3) + 8) {
    throw new IngestError('document_too_large', `A document exceeds ${maxBytes} bytes`, 413);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(document.content_base64.replace(/\s+/gu, ''))) {
    throw new IngestError('invalid_document', 'content_base64 is not valid base64');
  }
  return Buffer.from(document.content_base64, 'base64');
}

/** Validate bytes without storing an upload or creating a job (also used by the stateless API). */
export function validateDocumentInput(input, maxBytes = 8_388_608) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IngestError('invalid_document', 'Each document must be an object');
  const name = safeFileName(input.name);
  if (!name) throw new IngestError('invalid_document', 'Each document needs a name');
  const mime = String(input.mime_type ?? '').toLowerCase().split(';')[0].trim();
  const allowed = ALLOWED_MIME_TYPES[mime];
  if (!allowed) {
    throw new IngestError('unsupported_media_type', `Unsupported mime_type ${mime || '(missing)'}; allowed: ${Object.keys(ALLOWED_MIME_TYPES).join(', ')}`, 415);
  }
  const buffer = bytesOf(input, maxBytes);
  if (buffer.length === 0) throw new IngestError('empty_document', `${name} is empty`);
  if (buffer.length > maxBytes) throw new IngestError('document_too_large', `${name} exceeds ${maxBytes} bytes`, 413);
  if (!magicMatches(mime, buffer)) throw new IngestError('content_type_mismatch', `${name} does not look like ${mime}`, 415);
  return { name, mime, allowed, buffer };
}

export class IngestService {
  /**
   * @param {object} options
   * @param {string|null} options.dir     runtime directory; null keeps everything in memory
   * @param {number} options.maxBytes
   * @param {() => Date} [options.now]
   */
  constructor({ dir = null, maxBytes = 8_388_608, now = () => new Date(), getMode = () => 'demo' } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.now = now;
    this.getMode = getMode;
    this.documents = new Map(); // document_id -> record
    this.blobs = new Map();     // document_id -> Buffer (memory mode, and a cache)
    this.jobs = new Map();      // job_id -> job
    this.cases = new Map();     // case_id -> case built from uploaded documents
    this.casesLoaded = false;
    this.queue = createWriteQueue();
    this.initialized = false;
  }

  get documentsFile() { return this.dir ? path.join(this.dir, 'ingest-documents.json') : null; }
  get jobsFile() { return this.dir ? path.join(this.dir, 'ingest-jobs.json') : null; }

  async init() {
    if (this.initialized) return this;
    this.initialized = true;
    if (!this.dir) return this;
    const documents = await readJson(this.documentsFile, {});
    for (const record of Object.values(documents ?? {})) this.documents.set(record.document_id, { ...record,
      ...evidenceMetadata({ ...record, observed_at: record.observed_at ?? record.created_at ?? null }, { mode: record.source_status ?? 'fixture' }) });
    const jobs = await readJson(this.jobsFile, {});
    for (const job of Object.values(jobs ?? {})) {
      // A job that was running when the process stopped never finished: say so instead of leaving it "running".
      if (job.status === 'RUNNING' || job.status === 'QUEUED') {
        job.status = 'INTERRUPTED';
        job.error = { code: 'interrupted', message: 'The server restarted before this job finished; upload again to retry.' };
      }
      this.jobs.set(job.job_id, job);
    }
    return this;
  }

  #persist() {
    if (!this.dir) return Promise.resolve();
    return this.queue(async () => {
      await writeJsonAtomic(this.documentsFile, Object.fromEntries(this.documents));
      await writeJsonAtomic(this.jobsFile, Object.fromEntries(this.jobs));
    });
  }

  /**
   * Validate and store an upload, and open (or return) its job. Re-uploading the same content for the
   * same case is idempotent: it returns the same job.
   * @param {{case_id?: string, documents: object[], exporter_preferences?: object}} body
   * @returns {Promise<{job: object, documents: object[], created: boolean}>}
   */
  async accept(body, { reviewOf, ownerId = 'local-operator', visibility = 'private' } = {}) {
    await this.init();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IngestError('invalid_request', 'Body must be an object');
    const inputs = body.documents;
    if (!Array.isArray(inputs) || inputs.length === 0) throw new IngestError('invalid_request', 'documents must be a non-empty array');
    if (inputs.length > MAX_DOCUMENTS_PER_UPLOAD) throw new IngestError('too_many_documents', `At most ${MAX_DOCUMENTS_PER_UPLOAD} documents per upload`);
    if (body.case_id !== undefined && !CASE_ID_PATTERN.test(String(body.case_id))) {
      throw new IngestError('invalid_case_id', 'case_id must be 3-128 characters: letters, digits, dot, dash, underscore');
    }

    const stored = [];
    for (const input of inputs) stored.push(await this.#store(input, ownerId));
    const unique = [...new Map(stored.map((record) => [record.document_id, record])).values()];

    const ids = unique.map((record) => record.sha256).sort();
    if (body.case_id && this.isPrivateCase(body.case_id) && this.caseOwner(body.case_id) !== ownerId) {
      throw new IngestError('case_owner_conflict', 'This case identifier belongs to another workspace', 409);
    }
    const duplicate = [...this.jobs.values()].find((job) => (body.case_id && job.case_id !== body.case_id || job.owner_id !== ownerId)
      && JSON.stringify(job.document_ids.map((id) => this.documents.get(id)?.sha256).sort()) === JSON.stringify(ids));
    if (duplicate && !reviewOf) throw new IngestError('duplicate_asset_documents', 'These documents already belong to an existing case; review that case instead of creating another asset', 409);
    if (reviewOf) {
      const original = this.jobs.get(reviewOf);
      const originalIds = original?.document_ids.map((id) => this.documents.get(id)?.sha256).sort();
      if (JSON.stringify(originalIds) === JSON.stringify(ids)) {
        throw new IngestError('review_unchanged', 'Correct the documents before submitting a review', 409);
      }
    }
    // A review is a new, narrowly scoped attempt even when its corrected bytes occurred in an
    // older successful upload. Ordinary upload fingerprints remain unchanged.
    const fingerprint = sha256(JSON.stringify({ owner_id: ownerId, case_id: body.case_id ?? null, ids, ...(reviewOf ? { review_of: reviewOf } : {}) }));
    const jobId = `job_${fingerprint.slice(0, 20)}`;
    const caseId = body.case_id ? String(body.case_id) : `CASE-UP-${fingerprint.slice(0, 12).toUpperCase()}`;
    const existing = this.jobs.get(jobId);
    if (existing && !['FAILED', 'INTERRUPTED'].includes(existing.status)) {
      return { job: structuredClone(existing), documents: unique.map((record) => structuredClone(record)), created: false };
    }

    const at = this.now().toISOString();
    // A retry of a failed or interrupted job is a new event: reusing the first event id would be
    // dropped by the bus as a duplicate and the retry would never run.
    const attempt = existing ? (existing.attempt ?? 1) + 1 : 1;
    const job = {
      job_id: jobId,
      owner_id: ownerId,
      visibility,
      case_id: caseId,
      status: 'QUEUED',
      document_ids: unique.map((record) => record.document_id),
      steps: [],
      decision_ids: [],
      ...(attempt > 1 ? { attempt, previous_decision_ids: [...(existing.previous_decision_ids ?? []), ...(existing.decision_ids ?? [])] } : {}),
      event_id: attempt > 1 ? `ingest:${jobId}:attempt-${attempt}` : `ingest:${jobId}`,
      created_at: at,
      updated_at: at
    };
    this.jobs.set(jobId, job);
    while (this.jobs.size > MAX_JOBS) this.jobs.delete(this.jobs.keys().next().value);
    await this.#persist();
    return { job: structuredClone(job), documents: unique.map((record) => structuredClone(record)), created: true };
  }

  async #store(input, ownerId) {
    const { name, mime, allowed, buffer } = validateDocumentInput(input, this.maxBytes);

    const digest = sha256(buffer);
    const documentId = `doc_${sha256(`${ownerId}:${digest}`).slice(0, 16)}`;
    const existing = this.documents.get(documentId);
    if (existing) {
      this.blobs.set(documentId, buffer);
      return existing;
    }
    const record = {
      ...evidenceMetadata({}, { now: this.now().getTime(), mode: this.getMode() }),
      document_id: documentId,
      sha256: `0x${digest}`,
      name,
      mime_type: mime,
      kind: allowed.kind,
      size: buffer.length,
      declared_type: typeof input.declared_type === 'string' ? input.declared_type.slice(0, 40) : null,
      // Stand-in for an ENI/TradeGo acknowledgement: nothing was sent to any registry.
      eni: { mode: 'mock', document_id: `ENI-MOCK-${digest.slice(0, 8).toUpperCase()}`, verified: false },
      stored_as: this.dir ? `uploads/${digest}.${allowed.ext}` : null,
      created_at: this.now().toISOString()
    };
    if (this.dir) await writeFileAtomic(path.join(this.dir, record.stored_as), buffer);
    this.documents.set(documentId, record);
    this.blobs.set(documentId, buffer);
    return record;
  }

  getJob(id) {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  isPrivateCase(caseId) {
    const jobs = [...this.jobs.values()].filter((job) => job.case_id === caseId);
    return jobs.some((job) => job.visibility !== 'public-demo') || this.cases.has(caseId) && this.cases.get(caseId).visibility !== 'public-demo';
  }
  caseOwner(caseId) { return [...this.jobs.values()].find((job) => job.case_id === caseId)?.owner_id ?? this.cases.get(caseId)?.workspace_owner_id ?? null; }

  listJobs({ case_id: caseId, limit = 50 } = {}) {
    return [...this.jobs.values()]
      .filter((job) => !caseId || job.case_id === caseId)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }

  async updateJob(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updated_at: this.now().toISOString() });
    await this.#persist();
    return structuredClone(job);
  }

  async recordStep(id, step) {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.steps = [...job.steps.filter((existing) => existing.step !== step.step), step];
    job.updated_at = this.now().toISOString();
    await this.#persist();
    return structuredClone(job);
  }

  /** Document records (with text for text documents) in the order they were uploaded. */
  async loadDocuments(ids) {
    await this.init();
    const out = [];
    for (const id of ids) {
      const record = this.documents.get(id);
      if (!record) throw new IngestError('document_missing', `Document ${id} is not stored`, 404);
      let blob = this.blobs.get(id);
      if (!blob && this.dir && record.stored_as) {
        blob = await fs.readFile(path.join(this.dir, record.stored_as)).catch(() => null);
        if (blob) this.blobs.set(id, blob);
      }
      if (!blob) throw new IngestError('document_missing', `The bytes of ${id} are no longer stored`, 410);
      // Binary bytes stay internal to the pipeline; HTTP job/document records never expose them.
      out.push({ ...record, text: record.kind === 'text' ? blob.toString('utf8') : null,
        ...(record.kind === 'text' ? {} : { buffer: Buffer.from(blob) }) });
    }
    return out;
  }

  getDocument(id) {
    const record = this.documents.get(id);
    return record ? structuredClone(record) : null;
  }

  // ---------------------------------------------------------------- cases built from documents

  /** Persist a case an upload produced, so the market catalog can list it after a restart. */
  async saveCase(caseData) {
    if (!caseData?.case_id || !CASE_ID_PATTERN.test(caseData.case_id)) return null;
    let titleHash;
    try { titleHash = cargoIdentityHashV2(caseData); } catch { /* incomplete/non-marine documents remain subject to intake review */ }
    if (titleHash) {
      for (const other of await this.listCases()) {
        if (other.case_id === caseData.case_id) continue;
        let otherHash;
        try { otherHash = cargoIdentityHashV2(other); } catch { continue; }
        if (otherHash === titleHash) throw new IngestError('duplicate_asset_identity', 'This bill already belongs to another case; amendments must be reviewed under its original asset identity', 409);
      }
    }
    const caseJobs = [...this.jobs.values()].filter((job) => job.case_id === caseData.case_id);
    const visibility = caseJobs.length > 0 && caseJobs.every((job) => job.visibility === 'public-demo') ? 'public-demo' : 'private';
    const privateCase = { ...caseData, visibility, title_identity_hash: titleHash ?? null, workspace_owner_id: this.caseOwner(caseData.case_id) };
    this.cases.set(caseData.case_id, structuredClone(privateCase));
    if (this.dir) await writeJsonAtomic(path.join(this.dir, 'cases', `${caseData.case_id}.case.json`), privateCase);
    return caseData.case_id;
  }

  /** Cases produced from uploads: those held in memory plus any saved by an earlier run. */
  async listCases() {
    await this.init();
    if (this.dir && !this.casesLoaded) {
      this.casesLoaded = true;
      const folder = path.join(this.dir, 'cases');
      const names = await fs.readdir(folder).catch(() => []);
      for (const name of names.filter((file) => file.endsWith('.case.json'))) {
        const data = await readJson(path.join(folder, name), null).catch(() => null);
        if (data?.case_id && !this.cases.has(data.case_id)) this.cases.set(data.case_id, data);
      }
    }
    return [...this.cases.values()].map((data) => structuredClone(data));
  }

  async clear() {
    this.documents.clear();
    this.blobs.clear();
    this.jobs.clear();
    if (this.dir) {
      for (const caseId of this.cases.keys()) await fs.rm(path.join(this.dir, 'cases', `${caseId}.case.json`), { force: true });
    }
    this.cases.clear();
    await this.#persist();
  }
}
