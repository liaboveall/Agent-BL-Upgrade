// Document intake: validate an upload, store it by content
// and open a job that the ingest pipeline works through.
//
//   POST /api/agent/ingest ─► validate the whole batch ─► claim the case ─► seal + store by SHA-256 ─► job
//                                                                                        │
//                                         DOCUMENTS_INGESTED event ◄─────────────────────┘  (the AgentService submits it)
//
// Who may read a case is a business record of its own (`ingest-case-access.json`). It is written before the
// job (or the first preference) and survives job retention, failed runs, restarts and a Demo reset; a job is
// only a run record. Curated sample IDs are a read-only public namespace: a private upload against one works on
// the uploader's own copy (`WS-<hash>-<sample id>`), so nobody's upload changes what anybody else can read.
// Working-copy IDs are private before anything is stored for them: only the workspace they derive from reads them.
//
// Raw bytes: the whole batch is validated before anything is written. Each content hash is stored once,
// sealed with AES-256-GCM (AGENTBL_INTAKE_KEY, or a local key file created with owner-only permissions), and
// removed when no retained job references it. Per-workspace and total quotas bound what the store can hold,
// and the in-memory copy of the bytes is a bounded cache.
//
// Job retention never depends on other workspaces' volume: a job leaves only when it is finished, needs no review
// and is older than the retention period. Queued, running and held jobs stay with their bytes; when the job table
// or a workspace's share of it is full of those, a new upload is refused instead.
//
// What this module does NOT do: it never reads document content as instructions, and it never claims
// an upload was verified. The ENI record is a MOCK acknowledgement and says so (`mode: 'mock'`).

import crypto from 'node:crypto';
import { evidenceMetadata } from '../runtime/freshness.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteQueue, readJson, writeFileAtomic, writeJsonAtomic } from '../../lib/jsonStore.js';
import { cargoIdentityHashV2 } from '../../chain/cargoIdentity.js';
import { curatedCaseIds } from './publicCases.js';

export const ALLOWED_MIME_TYPES = Object.freeze({
  'text/markdown': { ext: 'md', kind: 'text' },
  'text/plain': { ext: 'txt', kind: 'text' },
  'application/pdf': { ext: 'pdf', kind: 'pdf' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/jpeg': { ext: 'jpg', kind: 'image' }
});

export const MAX_DOCUMENTS_PER_UPLOAD = 12;
export const DEFAULT_BATCH_MAX_BYTES = 25_165_824; // 24 MiB of documents in one request
export const DEFAULT_MAX_JOBS = 500;
export const DEFAULT_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 255;
const CASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/u;
const WORKSPACE_COPY = /^WS-[0-9A-F]{10}-(.+)$/u;
const FINISHED = new Set(['DONE', 'FAILED', 'INTERRUPTED']);
const ACCESS_SCHEMA = 'agentbl-case-access-v1';
const SEALED = Buffer.from('AGBLUP01');
const STORED_FILE = /^[0-9a-f]{64}\.(?:md|txt|pdf|png|jpg)(?:\.sealed)?$/u;
const UPLOAD_EVENT = /^(?:ingest|review):(job_[a-f0-9]{20})/u;

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

/** The upload key: a separately managed AGENTBL_INTAKE_KEY, or a key file next to the store (created owner-only). */
async function intakeKey(env, dir) {
  const raw = env.AGENTBL_INTAKE_KEY;
  if (raw) {
    if (!/^[a-fA-F0-9]{64}$/u.test(raw)) throw new IngestError('intake_key_invalid', 'AGENTBL_INTAKE_KEY must be 32 bytes of hex', 503);
    return Buffer.from(raw, 'hex');
  }
  const file = path.join(dir, 'ingest-uploads.key');
  try { return Buffer.from(await fs.readFile(file, 'utf8'), 'base64'); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(dir, { recursive: true });
    try { await fs.writeFile(file, crypto.generateKeySync('aes', { length: 256 }).export().toString('base64'), { flag: 'wx', mode: 0o600 }); }
    catch (race) { if (race.code !== 'EEXIST') throw race; }
    return Buffer.from(await fs.readFile(file, 'utf8'), 'base64');
  }
}

const aad = (digest) => Buffer.from(`agentbl-upload-v1:${digest}`);
function seal(key, digest, buffer) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(digest));
  const data = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([SEALED, iv, cipher.getAuthTag(), data]);
}
function open(key, digest, stored) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, stored.subarray(8, 20));
  decipher.setAAD(aad(digest));
  decipher.setAuthTag(stored.subarray(20, 36));
  return Buffer.concat([decipher.update(stored.subarray(36)), decipher.final()]);
}

export class IngestService {
  /**
   * @param {object} options
   * @param {string|null} options.dir     runtime directory; null keeps everything in memory
   * @param {number} options.maxBytes      one document
   * @param {number} [options.maxBatchBytes]   all documents of one request
   * @param {number} [options.maxOwnerBytes]   stored bytes per workspace
   * @param {number} [options.maxStoredBytes]  stored bytes in total
   * @param {number} [options.blobCacheBytes]  bytes kept in memory when a directory holds the store
   * @param {Iterable<string>} [options.publicCaseIds]  the read-only public sample IDs
   * @param {number} [options.maxJobs]          retained jobs in total
   * @param {number} [options.maxOwnerJobs]     retained jobs of one workspace
   * @param {number} [options.jobRetentionMs]   how long a finished job that needs no review is kept
   * @param {() => Date} [options.now]
   */
  constructor({ dir = null, maxBytes = 8_388_608, maxBatchBytes = DEFAULT_BATCH_MAX_BYTES, maxOwnerBytes = 50_331_648,
    maxStoredBytes = 134_217_728, blobCacheBytes = 67_108_864, publicCaseIds = curatedCaseIds(), env = process.env,
    maxJobs = DEFAULT_MAX_JOBS, maxOwnerJobs = Math.max(1, Math.floor(maxJobs / 5)), jobRetentionMs = DEFAULT_JOB_RETENTION_MS,
    now = () => new Date(), getMode = () => 'demo' } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.maxBatchBytes = Math.max(maxBatchBytes, maxBytes);
    this.maxOwnerBytes = maxOwnerBytes;
    this.maxStoredBytes = maxStoredBytes;
    this.maxJobs = maxJobs;
    this.maxOwnerJobs = Math.min(maxOwnerJobs, maxJobs);
    this.jobRetentionMs = jobRetentionMs;
    this.blobCacheBytes = blobCacheBytes;
    this.publicCaseIds = new Set(publicCaseIds);
    this.env = env;
    this.now = now;
    this.getMode = getMode;
    this.documents = new Map(); // document_id -> record
    this.blobs = new Map();     // document_id -> Buffer (the store in memory mode, a bounded cache otherwise)
    this.cachedBytes = 0;
    this.jobs = new Map();      // job_id -> job (a run record, bounded)
    this.cases = new Map();     // case_id -> case built from uploaded documents
    this.access = new Map();    // case_id -> who may read it (never evicted)
    this.casesLoaded = false;
    this.queue = createWriteQueue();
    this.commits = createWriteQueue(); // ownership, blobs, documents and jobs change together
    this.loading = null;
  }

  get documentsFile() { return this.dir ? path.join(this.dir, 'ingest-documents.json') : null; }
  get jobsFile() { return this.dir ? path.join(this.dir, 'ingest-jobs.json') : null; }
  get accessFile() { return this.dir ? path.join(this.dir, 'ingest-case-access.json') : null; }

  init() {
    this.loading ??= this.#load().then(() => this);
    return this.loading;
  }

  async #load() {
    if (!this.dir) return;
    const documents = await readJson(this.documentsFile, {});
    for (const record of Object.values(documents ?? {})) this.documents.set(record.document_id, { ...record,
      ...evidenceMetadata({ ...record, observed_at: record.observed_at ?? record.created_at ?? null }, { mode: record.source_status ?? 'fixture' }) });
    const jobs = await readJson(this.jobsFile, {});
    for (const job of Object.values(jobs ?? {})) {
      // A job that was running when the process stopped never finished: say so instead of leaving it "running".
      if (job.status === 'RUNNING' || job.status === 'QUEUED') {
        job.status = 'INTERRUPTED';
        job.error = { code: 'interrupted', message: 'The server restarted before this job finished; upload again to retry.' };
        // Its retention period starts now, so the uploader has the whole of it to retry.
        job.updated_at = this.now().toISOString();
      }
      this.jobs.set(job.job_id, job);
    }
    // A corrupt access file stops the intake from starting: guessing ownership would make private cases public.
    const access = await readJson(this.accessFile, null);
    if (access && access.schema !== ACCESS_SCHEMA) throw new Error('Unsupported case access file');
    // Jobs written by this version (they record their mode) prove an access file existed: its loss is not a fresh start.
    if (!access && [...this.jobs.values()].some((job) => job.mode)) throw new Error('Case access records are missing; restore ingest-case-access.json');
    for (const record of Object.values(access?.cases ?? {})) this.access.set(record.case_id, record);
    // Runtimes written before the access file existed: their jobs and saved cases are the only ownership records left.
    await this.#loadCases();
    let migrated = false;
    const adopt = (caseId, ownerId, visibility, at) => {
      if (!caseId || this.access.has(caseId) || this.publicCaseIds.has(caseId)) return;
      this.access.set(caseId, { case_id: caseId, owner_id: ownerId ?? 'local-operator', visibility: visibility === 'public-demo' ? 'public-demo' : 'private', created_at: at ?? null, migrated: true });
      migrated = true;
    };
    for (const job of this.jobs.values()) adopt(job.case_id, job.owner_id, job.visibility, job.created_at);
    for (const data of this.cases.values()) adopt(data.case_id, data.workspace_owner_id, data.visibility, null);
    if (migrated) await this.#persistAccess();
    await this.#sweepUploads();
  }

  #persist() {
    if (!this.dir) return Promise.resolve();
    return this.queue(async () => {
      await writeJsonAtomic(this.documentsFile, Object.fromEntries(this.documents));
      await writeJsonAtomic(this.jobsFile, Object.fromEntries(this.jobs));
    });
  }

  #persistAccess() {
    if (!this.dir) return Promise.resolve();
    return this.queue(() => writeJsonAtomic(this.accessFile, { schema: ACCESS_SCHEMA, cases: Object.fromEntries(this.access) }, { durable: true }));
  }

  // ---------------------------------------------------------------- who may read a case

  /** A curated sample, or a case a Demo scenario published. Anyone may read it; nobody's upload changes it. */
  isPublicCase(caseId) {
    return this.publicCaseIds.has(caseId) || this.access.get(caseId)?.visibility === 'public-demo';
  }

  isPrivateCase(caseId) {
    if (this.publicCaseIds.has(caseId)) return false;
    const record = this.access.get(caseId);
    if (record) return record.visibility !== 'public-demo';
    // A working-copy ID is private before anything is stored for it: its owner is the workspace it derives from.
    return WORKSPACE_COPY.test(String(caseId ?? ''));
  }

  caseOwner(caseId) { return this.access.get(caseId)?.owner_id ?? null; }

  /** The private working copy a workspace uses for a public sample: stable for that workspace, unguessable for others. */
  workspaceCaseId(ownerId, sourceCaseId) {
    return `WS-${sha256(`${ownerId}:${sourceCaseId}`).slice(0, 10).toUpperCase()}-${sourceCaseId}`.slice(0, 128);
  }

  /** The public sample `caseId` is this workspace's own copy of, or null (another workspace's copy, or no copy at all). */
  workspaceSource(caseId, ownerId) {
    const source = WORKSPACE_COPY.exec(String(caseId ?? ''))?.[1];
    return source && ownerId && this.isPublicCase(source) && this.workspaceCaseId(ownerId, source) === caseId ? source : null;
  }

  /** The case an upload (or a preference) of this workspace lands on. Public samples are never written directly. */
  resolveUploadCase(caseId, ownerId, visibility = 'private') {
    if (caseId !== undefined && caseId !== null && !CASE_ID_PATTERN.test(String(caseId))) {
      throw new IngestError('invalid_case_id', 'case_id must be 3-128 characters: letters, digits, dot, dash, underscore');
    }
    if (visibility !== 'public-demo' && caseId && this.isPublicCase(String(caseId))) {
      return { case_id: this.workspaceCaseId(ownerId, String(caseId)), source_case_id: String(caseId) };
    }
    // The browser may name its copy directly: it still keeps the sample it was made from.
    const source = visibility !== 'public-demo' && caseId ? this.workspaceSource(String(caseId), ownerId) : null;
    return { case_id: caseId ? String(caseId) : null, source_case_id: source };
  }

  /** Record who may read a case before anything is stored for it. Ownership is never taken over. */
  async claimCase(caseId, { ownerId = 'local-operator', visibility = 'private', sourceCaseId = null } = {}) {
    await this.init();
    if (!CASE_ID_PATTERN.test(String(caseId))) throw new IngestError('invalid_case_id', 'case_id must be 3-128 characters: letters, digits, dot, dash, underscore');
    if (visibility !== 'public-demo' && this.publicCaseIds.has(caseId)) throw new IngestError('public_case_read_only', 'Public sample cases are read-only; use your own working copy', 409);
    const existing = this.access.get(caseId);
    if (existing) {
      if (existing.owner_id !== ownerId && !(existing.visibility === 'public-demo' && visibility === 'public-demo')) {
        throw new IngestError('case_owner_conflict', 'This case identifier belongs to another workspace', 409);
      }
      if (existing.visibility !== visibility) throw new IngestError('case_visibility_conflict', 'This case is already published with another visibility', 409);
      return structuredClone(existing);
    }
    // Nobody, operator included, takes another workspace's copy of a sample.
    const source = sourceCaseId ?? this.workspaceSource(caseId, ownerId);
    if (WORKSPACE_COPY.test(caseId) && !source) throw new IngestError('case_owner_conflict', 'This working copy belongs to another workspace', 409);
    const record = { case_id: caseId, owner_id: ownerId, visibility: visibility === 'public-demo' ? 'public-demo' : 'private',
      ...(source ? { source_case_id: source } : {}), created_at: this.now().toISOString() };
    this.access.set(caseId, record);
    try { await this.#persistAccess(); }
    catch (error) { this.access.delete(caseId); throw error; }
    return structuredClone(record);
  }

  getAccess(caseId) {
    const record = this.access.get(caseId);
    return record ? structuredClone(record) : null;
  }

  canReadCase(caseId, { ownerId = null, admin = false } = {}) {
    if (admin || !this.isPrivateCase(caseId)) return true;
    if (!ownerId) return false;
    const owner = this.caseOwner(caseId);
    return owner ? owner === ownerId : this.workspaceSource(caseId, ownerId) !== null;
  }

  canReadJob(job, { ownerId = null, admin = false } = {}) {
    if (admin || job?.visibility === 'public-demo') return true;
    return Boolean(ownerId) && job?.owner_id === ownerId;
  }

  /**
   * A record produced from an upload (a decision of DOCUMENTS_INGESTED / REVIEW_RESOLVED) follows its job while the
   * job is retained and its case's access record afterwards. With neither, nobody but an operator can read it.
   */
  canReadUploadRecord(caseId, eventId, { ownerId = null, admin = false } = {}) {
    if (admin) return true;
    const job = this.jobs.get(UPLOAD_EVENT.exec(String(eventId ?? ''))?.[1]);
    if (job) return this.canReadJob(job, { ownerId });
    const record = this.access.get(caseId);
    if (!record) return false;
    return record.visibility === 'public-demo' || Boolean(ownerId) && record.owner_id === ownerId;
  }

  // ---------------------------------------------------------------- uploads

  /**
   * Validate and store an upload, and open (or return) its job. Re-uploading the same content for the
   * same case is idempotent: it returns the same job. Nothing is stored unless the whole batch is valid.
   * @param {{case_id?: string, documents: object[], exporter_preferences?: object}} body
   * @returns {Promise<{job: object, documents: object[], created: boolean}>}
   */
  async accept(body, { reviewOf, ownerId = 'local-operator', visibility = 'private' } = {}) {
    await this.init();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IngestError('invalid_request', 'Body must be an object');
    const inputs = body.documents;
    if (!Array.isArray(inputs) || inputs.length === 0) throw new IngestError('invalid_request', 'documents must be a non-empty array');
    if (inputs.length > MAX_DOCUMENTS_PER_UPLOAD) throw new IngestError('too_many_documents', `At most ${MAX_DOCUMENTS_PER_UPLOAD} documents per upload`);
    const target = reviewOf ? { case_id: String(body.case_id), source_case_id: this.jobs.get(reviewOf)?.source_case_id ?? null }
      : this.resolveUploadCase(body.case_id, ownerId, visibility);

    // 1. every document is checked before any byte is stored
    const items = inputs.map((input) => {
      const { name, mime, allowed, buffer } = validateDocumentInput(input, this.maxBytes);
      const digest = sha256(buffer);
      return { input, name, mime, allowed, buffer, digest, document_id: `doc_${sha256(`${ownerId}:${digest}`).slice(0, 16)}` };
    });
    const batchBytes = items.reduce((sum, item) => sum + item.buffer.length, 0);
    if (batchBytes > this.maxBatchBytes) throw new IngestError('upload_batch_too_large', `One upload may carry at most ${this.maxBatchBytes} bytes of documents`, 413);
    const unique = [...new Map(items.map((item) => [item.document_id, item])).values()];
    const ids = unique.map((item) => `0x${item.digest}`).sort();

    return this.commits(async () => {
      // 2. ownership, duplicates and idempotency, still without writing anything
      const fingerprint = sha256(JSON.stringify({ owner_id: ownerId, case_id: target.case_id, ids, ...(reviewOf ? { review_of: reviewOf } : {}) }));
      const caseId = target.case_id ?? `CASE-UP-${fingerprint.slice(0, 12).toUpperCase()}`;
      const access = this.access.get(caseId);
      if (access && access.owner_id !== ownerId && !(access.visibility === 'public-demo' && (visibility === 'public-demo' || reviewOf))) {
        throw new IngestError('case_owner_conflict', 'This case identifier belongs to another workspace', 409);
      }
      const shaOf = (job) => JSON.stringify(job.document_ids.map((id) => this.documents.get(id)?.sha256).sort());
      const duplicate = [...this.jobs.values()].find((job) => (job.case_id !== caseId || job.owner_id !== ownerId) && shaOf(job) === JSON.stringify(ids));
      if (duplicate && !reviewOf) throw new IngestError('duplicate_asset_documents', 'These documents already belong to an existing case; review that case instead of creating another asset', 409);
      if (reviewOf && shaOf(this.jobs.get(reviewOf) ?? { document_ids: [] }) === JSON.stringify(ids)) {
        throw new IngestError('review_unchanged', 'Correct the documents before submitting a review', 409);
      }
      // A review is a new, narrowly scoped attempt even when its corrected bytes occurred in an
      // older successful upload. Ordinary upload fingerprints remain unchanged.
      const jobId = `job_${fingerprint.slice(0, 20)}`;
      const existing = this.jobs.get(jobId);
      if (existing && !['FAILED', 'INTERRUPTED'].includes(existing.status) && unique.every((item) => this.documents.has(item.document_id))) {
        return { job: structuredClone(existing), documents: unique.map((item) => structuredClone(this.documents.get(item.document_id))), created: false };
      }
      // Only finished jobs past their retention make room; a held or running job of anybody never does.
      const expired = new Set(this.#expiredJobs());
      if (!existing) {
        const kept = [...this.jobs.values()].filter((job) => !expired.has(job.job_id));
        if (kept.filter((job) => job.owner_id === ownerId).length >= this.maxOwnerJobs) {
          throw new IngestError('upload_job_quota_exceeded', 'This workspace keeps the most jobs it may; review held jobs or wait until finished ones expire', 413);
        }
        if (kept.length >= this.maxJobs) throw new IngestError('intake_jobs_full', 'The intake keeps no more jobs until finished ones reach their retention period; try again later', 507);
      }
      const fresh = unique.filter((item) => !this.documents.has(item.document_id));
      const freshBytes = fresh.reduce((sum, item) => sum + item.buffer.length, 0);
      const stored = [...this.documents.values()];
      const ownerBytes = stored.filter((record) => record.owner_id === ownerId).reduce((sum, record) => sum + record.size, 0);
      if (ownerBytes + freshBytes > this.maxOwnerBytes) throw new IngestError('upload_quota_exceeded', 'This workspace has reached its upload storage quota; finished jobs release space as they expire', 413);
      if (stored.reduce((sum, record) => sum + record.size, 0) + freshBytes > this.maxStoredBytes) throw new IngestError('intake_storage_full', 'The intake store is full; try again later', 507);

      // 3. commit: the access record first, then the bytes, then the records that point at them
      if (!access) await this.claimCase(caseId, { ownerId, visibility, sourceCaseId: target.source_case_id });
      const records = [], written = [];
      try {
        for (const item of fresh) {
          const record = this.#record(item, ownerId);
          if (await this.#writeBlob(record, item.buffer)) written.push(record.stored_as);
          records.push([record, item.buffer]);
        }
      } catch (error) {
        // Only bytes this request wrote are removed; content another document shares was not written here.
        for (const file of written) await fs.rm(path.join(this.dir, file), { force: true }).catch(() => {});
        throw error;
      }
      for (const [record, buffer] of records) {
        this.documents.set(record.document_id, record);
        this.#cache(record.document_id, buffer);
      }

      const at = this.now().toISOString();
      // A retry of a failed or interrupted job is a new event: reusing the first event id would be
      // dropped by the bus as a duplicate and the retry would never run.
      const attempt = existing ? (existing.attempt ?? 1) + 1 : 1;
      const job = {
        job_id: jobId,
        owner_id: ownerId,
        visibility: (access ?? this.access.get(caseId))?.visibility ?? visibility,
        mode: this.getMode(),
        case_id: caseId,
        ...(target.source_case_id ? { source_case_id: target.source_case_id } : {}),
        status: 'QUEUED',
        document_ids: unique.map((item) => item.document_id),
        steps: [],
        decision_ids: [],
        ...(attempt > 1 ? { attempt, previous_decision_ids: [...(existing.previous_decision_ids ?? []), ...(existing.decision_ids ?? [])] } : {}),
        event_id: attempt > 1 ? `ingest:${jobId}:attempt-${attempt}` : `ingest:${jobId}`,
        created_at: at,
        updated_at: at
      };
      this.jobs.set(jobId, job);
      for (const id of expired) if (id !== jobId) this.jobs.delete(id);
      await this.#persist();
      await this.#collect();
      return { job: structuredClone(job), documents: unique.map((item) => structuredClone(this.documents.get(item.document_id))), created: true };
    });
  }

  #record({ input, name, mime, allowed, buffer, digest, document_id: documentId }, ownerId) {
    return {
      ...evidenceMetadata({}, { now: this.now().getTime(), mode: this.getMode() }),
      document_id: documentId,
      owner_id: ownerId,
      sha256: `0x${digest}`,
      name,
      mime_type: mime,
      kind: allowed.kind,
      size: buffer.length,
      declared_type: typeof input.declared_type === 'string' ? input.declared_type.slice(0, 40) : null,
      // Stand-in for an ENI/TradeGo acknowledgement: nothing was sent to any registry.
      eni: { mode: 'mock', document_id: `ENI-MOCK-${digest.slice(0, 8).toUpperCase()}`, verified: false },
      stored_as: this.dir ? `uploads/${digest}.${allowed.ext}.sealed` : null,
      created_at: this.now().toISOString()
    };
  }

  #key() {
    this.keyLoading ??= intakeKey(this.env, this.dir).catch((error) => { this.keyLoading = null; throw error; });
    return this.keyLoading;
  }

  /** Seal and write the bytes unless another document already stored the same content. True when this call wrote them. */
  async #writeBlob(record, buffer) {
    if (!this.dir) return false;
    const file = path.join(this.dir, record.stored_as);
    if (await fs.access(file).then(() => true, () => false)) return false;
    await writeFileAtomic(file, seal(await this.#key(), record.sha256.slice(2), buffer), { mode: 0o600 });
    return true;
  }

  async #readBlob(record) {
    const stored = await fs.readFile(path.join(this.dir, record.stored_as)).catch(() => null);
    if (!stored) return null;
    let buffer = stored;
    if (stored.subarray(0, SEALED.length).equals(SEALED)) {
      try { buffer = open(await this.#key(), record.sha256.slice(2), stored); }
      catch { throw new IngestError('document_unreadable', `${record.document_id} cannot be opened with the configured intake key`, 503); }
    }
    // Plain files written before sealing are still read, but only when their bytes are the ones recorded.
    if (`0x${sha256(buffer)}` !== record.sha256) throw new IngestError('document_corrupt', `The stored bytes of ${record.document_id} do not match their hash`, 410);
    return buffer;
  }

  #cache(id, buffer) {
    if (this.blobs.has(id)) { this.cachedBytes -= this.blobs.get(id).length; this.blobs.delete(id); }
    this.blobs.set(id, buffer);
    this.cachedBytes += buffer.length;
    // With a directory the bytes live on disk, so memory only keeps the most recently used ones.
    while (this.dir && this.cachedBytes > this.blobCacheBytes && this.blobs.size > 1) {
      const [oldest, value] = this.blobs.entries().next().value;
      this.blobs.delete(oldest);
      this.cachedBytes -= value.length;
    }
  }

  #uncache(id) {
    const value = this.blobs.get(id);
    if (value) { this.cachedBytes -= value.length; this.blobs.delete(id); }
  }

  /**
   * Jobs whose retention has ended: finished, needing no review (or resolved by a later review that needs none), and
   * unchanged for the retention period. Their decisions keep their own evidence; only the raw bytes go with them.
   */
  #expiredJobs() {
    const cutoff = this.now().getTime() - this.jobRetentionMs;
    const jobs = [...this.jobs.values()];
    const resolved = new Set(jobs.filter((job) => job.reviewed_job_id && job.status === 'DONE' && !job.review_required).map((job) => job.reviewed_job_id));
    return jobs.filter((job) => FINISHED.has(job.status) && (!job.review_required || resolved.has(job.job_id))
      && Date.parse(job.updated_at ?? job.created_at) <= cutoff).map((job) => job.job_id);
  }

  /** Drop documents no retained job references, and their files when no other document shares the content. */
  async #collect() {
    const referenced = new Set([...this.jobs.values()].flatMap((job) => job.document_ids));
    const removed = [];
    for (const [id, record] of this.documents) {
      if (referenced.has(id)) continue;
      this.documents.delete(id);
      this.#uncache(id);
      removed.push(record);
    }
    if (!removed.length) return 0;
    const kept = new Set([...this.documents.values()].map((record) => record.stored_as));
    for (const record of removed) {
      if (this.dir && record.stored_as && !kept.has(record.stored_as)) await fs.rm(path.join(this.dir, record.stored_as), { force: true });
    }
    await this.#persist();
    return removed.length;
  }

  /** Files left by older versions or by a crash between writing bytes and recording them. */
  async #sweepUploads() {
    const folder = path.join(this.dir, 'uploads');
    const kept = new Set([...this.documents.values()].map((record) => record.stored_as));
    for (const name of await fs.readdir(folder).catch(() => [])) {
      if (STORED_FILE.test(name) && !kept.has(`uploads/${name}`)) await fs.rm(path.join(folder, name), { force: true });
    }
  }

  getJob(id) {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }

  listJobs({ case_id: caseId, limit = 50, filter } = {}) {
    return [...this.jobs.values()]
      .filter((job) => (!caseId || job.case_id === caseId) && (!filter || filter(job)))
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
      if (blob) this.#cache(id, blob);
      else if (this.dir && record.stored_as) {
        blob = await this.#readBlob(record);
        if (blob) this.#cache(id, blob);
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

  /** What the store holds, for operations and the retention tests. */
  usage() {
    const records = [...this.documents.values()];
    return { documents: records.length, jobs: this.jobs.size, max_jobs: this.maxJobs, stored_bytes: records.reduce((sum, record) => sum + record.size, 0),
      max_stored_bytes: this.maxStoredBytes, cached_bytes: this.cachedBytes, cases_with_access_records: this.access.size };
  }

  /** Case IDs that hold Live material (a Live job or a case a Live upload produced): a Demo reset leaves them alone. */
  async liveCaseIds() {
    await this.init();
    await this.#loadCases();
    return new Set([...[...this.jobs.values()].filter((job) => job.mode === 'live').map((job) => job.case_id),
      ...[...this.cases.values()].filter((data) => data.mode === 'live').map((data) => data.case_id)]);
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
    const access = this.access.get(caseData.case_id);
    const visibility = access?.visibility === 'public-demo' ? 'public-demo' : 'private';
    const privateCase = { ...caseData, visibility, title_identity_hash: titleHash ?? null, workspace_owner_id: this.caseOwner(caseData.case_id),
      ...(access?.source_case_id ? { source_case_id: access.source_case_id } : {}), mode: this.getMode() };
    this.cases.set(caseData.case_id, structuredClone(privateCase));
    if (this.dir) await writeJsonAtomic(path.join(this.dir, 'cases', `${caseData.case_id}.case.json`), privateCase);
    return caseData.case_id;
  }

  async #loadCases() {
    if (!this.dir || this.casesLoaded) return;
    this.casesLoaded = true;
    const folder = path.join(this.dir, 'cases');
    const names = await fs.readdir(folder).catch(() => []);
    for (const name of names.filter((file) => file.endsWith('.case.json'))) {
      const data = await readJson(path.join(folder, name), null).catch(() => null);
      if (data?.case_id && !this.cases.has(data.case_id)) this.cases.set(data.case_id, data);
    }
  }

  /** Cases produced from uploads: those held in memory plus any saved by an earlier run. */
  async listCases() {
    await this.init();
    await this.#loadCases();
    return [...this.cases.values()].map((data) => structuredClone(data));
  }

  /**
   * The Demo reset: Demo jobs, the cases only they produced, and every stored byte no remaining job needs are
   * deleted from memory and disk. Live records stay, and so do access records: a reset never makes a case public.
   */
  async clear() {
    await this.init();
    return this.commits(async () => {
      await this.#loadCases();
      for (const [id, job] of this.jobs) if ((job.mode ?? 'demo') !== 'live') this.jobs.delete(id);
      for (const [caseId, data] of this.cases) {
        if ((data.mode ?? 'demo') === 'live') continue;
        if (this.dir) await fs.rm(path.join(this.dir, 'cases', `${caseId}.case.json`), { force: true });
        this.cases.delete(caseId);
      }
      await this.#persist();
      await this.#collect();
    });
  }
}
