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
// A manifest (`ingest-manifest.json`) records that the directory keeps access records, so losing the access file is
// never read as a fresh start, whatever else the directory still holds; and a case with private state (saved
// preferences) but no access record has an unknown owner, which only an operator reads -- never everybody.
//
// A commit writes the bytes, then the document records, then the job records: the job file is the commit point.
// Nothing of a request whose commit failed stays visible, so its retry commits it again instead of answering from
// memory, and document records no committed job references are removed when the intake starts.
//
// Raw bytes: the whole batch is validated before anything is written. Each content hash is stored once,
// sealed with AES-256-GCM (AGENTBL_INTAKE_KEY, or a local key file created with owner-only permissions), and
// removed when no retained job references it. Per-workspace and total quotas bound what the store can hold,
// and the in-memory copy of the bytes is a bounded cache.
//
// Job retention never depends on other workspaces' volume: a job leaves only when it is finished, needs no review
// and is older than the retention period. Queued, running and held jobs stay with their bytes; when the job table
// or a workspace's share of it is full of those, a new upload is refused instead. Expired jobs are removed before
// any quota is checked, when the intake starts and on the agent's tick, so space comes back without a new upload.
//
// A held job and the reviews that correct it are versions of one logical job and hold one slot of the job quota:
// a full table never blocks the correction its own advice asks for. Every version is kept (none is discarded to
// make room); the table may hold at most twice the quota, so repeated reviews stay bounded too. Bytes work the same
// way: the first correction of a held job may use a reserve of one batch above the byte quota, so held material
// filling the quota never blocks its own correction, and the store stays below quota + reserve.
//
// The owner may also withdraw a held (or failed) job: the job and every version of it stop waiting, their raw bytes
// are released at once rather than after retention, the records stay (status WITHDRAWN) until retention, and every
// decision keeps its own evidence. Withdrawn records count towards the table's ceiling, not the logical quota.
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
const FINISHED = new Set(['DONE', 'FAILED', 'INTERRUPTED', 'WITHDRAWN']);
const RETRYABLE = new Set(['FAILED', 'INTERRUPTED', 'WITHDRAWN']);
const ACCESS_SCHEMA = 'agentbl-case-access-v1';
const MANIFEST_SCHEMA = 'agentbl-intake-manifest-v1';
const PRIVATE_FILE = { mode: 0o600 };
const SEALED = Buffer.from('AGBLUP01');
const STORED_FILE = /^[0-9a-f]{64}\.(?:md|txt|pdf|png|jpg)(?:\.sealed)?$/u;
const UPLOAD_EVENT = /^(?:ingest|review):(job_[a-f0-9]{20})/u;

export class IngestError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
    this.status = status;
    this.expose = true;
    if (details !== undefined) this.details = details;
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
   * @param {number} [options.reviewReserveBytes]  bytes the first correction of a held job may use above the byte quota
   * @param {(caseId: string) => boolean} [options.hasPrivateState]  whether another store holds private state for a case
   * @param {() => Date} [options.now]
   */
  constructor({ dir = null, maxBytes = 8_388_608, maxBatchBytes = DEFAULT_BATCH_MAX_BYTES, maxOwnerBytes = 50_331_648,
    maxStoredBytes = 134_217_728, blobCacheBytes = 67_108_864, publicCaseIds = curatedCaseIds(), env = process.env,
    maxJobs = DEFAULT_MAX_JOBS, maxOwnerJobs = Math.max(1, Math.floor(maxJobs / 5)), jobRetentionMs = DEFAULT_JOB_RETENTION_MS,
    reviewReserveBytes, hasPrivateState = () => false, now = () => new Date(), getMode = () => 'demo' } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.maxBatchBytes = Math.max(maxBatchBytes, maxBytes);
    this.maxOwnerBytes = maxOwnerBytes;
    this.maxStoredBytes = maxStoredBytes;
    this.reviewReserveBytes = Math.max(0, reviewReserveBytes ?? this.maxBatchBytes);
    this.hasPrivateState = hasPrivateState;
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
    // 'unloaded' | 'loading' | 'ready' | 'failed'. Until the access records are loaded, nobody's case is known to be
    // public except a curated sample: an unknown visibility is never read as public.
    this.accessState = dir ? 'unloaded' : 'ready';
    this.casesLoaded = false;
    this.queue = createWriteQueue();
    this.commits = createWriteQueue(); // ownership, blobs, documents and jobs change together
    this.loading = null;
    // The last write of the document and job records that failed, until one succeeds: what memory holds is then
    // ahead of the disk, so an idempotent retry writes it before confirming anything.
    this.unsavedRecords = null;
  }

  get documentsFile() { return this.dir ? path.join(this.dir, 'ingest-documents.json') : null; }
  get jobsFile() { return this.dir ? path.join(this.dir, 'ingest-jobs.json') : null; }
  get accessFile() { return this.dir ? path.join(this.dir, 'ingest-case-access.json') : null; }
  get manifestFile() { return this.dir ? path.join(this.dir, 'ingest-manifest.json') : null; }

  /** Another store (the saved preferences) tells the intake which cases hold private state of its own. */
  trackPrivateState(probe) {
    if (typeof probe === 'function') this.hasPrivateState = probe;
  }

  init() {
    if (!this.loading) {
      if (this.accessState === 'unloaded') this.accessState = 'loading';
      this.loading = this.#load().then(() => { this.accessState = 'ready'; return this; },
        (error) => { this.accessState = 'failed'; throw error; });
    }
    return this.loading;
  }

  /** Whether the access records are loaded: only then can a case that is not a curated sample be shown to anyone. */
  get accessReady() { return this.accessState === 'ready'; }

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
    const manifest = await readJson(this.manifestFile, null);
    if (manifest && manifest.schema !== MANIFEST_SCHEMA) throw new Error('Unsupported intake manifest');
    // The manifest says access records were kept here; jobs written by this version (they record their mode) say the same
    // for a directory older than the manifest. Either way their loss is not a fresh start, even when no job is left
    // (retention removed them, or only preferences were ever saved).
    if (!access && (manifest?.access_records_since || [...this.jobs.values()].some((job) => job.mode))) {
      throw new Error('Case access records are missing; restore ingest-case-access.json');
    }
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
    // From the first start on the access file exists, and the manifest says so.
    if (migrated || !access) await this.#persistAccess();
    if (!manifest) {
      await writeJsonAtomic(this.manifestFile, { schema: MANIFEST_SCHEMA, access_records_since: this.now().toISOString() }, { durable: true, ...PRIVATE_FILE });
    }
    // Document records no job references: a commit that failed after its documents were written but before its job was.
    await this.#collect();
    await this.#reclaim();
    await this.#sweepUploads();
  }

  #persist() {
    if (!this.dir) return Promise.resolve();
    return this.queue(async () => {
      try {
        await writeJsonAtomic(this.documentsFile, Object.fromEntries(this.documents), PRIVATE_FILE);
        await writeJsonAtomic(this.jobsFile, Object.fromEntries(this.jobs), PRIVATE_FILE);
        this.unsavedRecords = null;
      } catch (error) {
        this.unsavedRecords = { at: this.now().toISOString(), message: String(error?.message ?? error).slice(0, 200) };
        throw error;
      }
    });
  }

  /** Write the document and job records again after a failed write (the agent's tick). True when nothing is left unsaved. */
  async saveUnsaved() {
    if (!this.unsavedRecords || this.accessState !== 'ready') return !this.unsavedRecords;
    await this.commits(() => this.#persist());
    return true;
  }

  #persistAccess() {
    if (!this.dir) return Promise.resolve();
    return this.queue(() => writeJsonAtomic(this.accessFile, { schema: ACCESS_SCHEMA, cases: Object.fromEntries(this.access) }, { durable: true, ...PRIVATE_FILE }));
  }

  // ---------------------------------------------------------------- who may read a case

  /** A curated sample, or a case a Demo scenario published. Anyone may read it; nobody's upload changes it. */
  isPublicCase(caseId) {
    return this.publicCaseIds.has(caseId) || this.accessReady && this.access.get(caseId)?.visibility === 'public-demo';
  }

  isPrivateCase(caseId) {
    if (this.publicCaseIds.has(caseId)) return false;
    if (!this.accessReady) return true;
    const record = this.access.get(caseId);
    if (record) return record.visibility !== 'public-demo';
    // A working-copy ID is private before anything is stored for it: its owner is the workspace it derives from.
    if (WORKSPACE_COPY.test(String(caseId ?? ''))) return true;
    // Private state another store holds (saved preferences) without an access record: the owner is unknown, which makes
    // the case readable by an operator only -- an unknown owner is never everybody.
    return Boolean(this.hasPrivateState(caseId));
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
    // Without the access records nobody can be shown to own a case: refuse rather than guess.
    if (!ownerId || !this.accessReady) return false;
    const owner = this.caseOwner(caseId);
    return owner ? owner === ownerId : this.workspaceSource(caseId, ownerId) !== null;
  }

  canReadJob(job, { ownerId = null, admin = false } = {}) {
    if (admin) return true;
    if (!this.accessReady) return false;
    if (job?.visibility === 'public-demo') return true;
    return Boolean(ownerId) && job?.owner_id === ownerId;
  }

  /**
   * A record produced from an upload (a decision of DOCUMENTS_INGESTED / REVIEW_RESOLVED) follows its job while the
   * job is retained and its case's access record afterwards. With neither, nobody but an operator can read it.
   */
  canReadUploadRecord(caseId, eventId, { ownerId = null, admin = false } = {}) {
    if (admin) return true;
    if (!this.accessReady) return false;
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
      if (existing && !RETRYABLE.has(existing.status) && unique.every((item) => this.documents.has(item.document_id))) {
        // Memory may be ahead of the disk after a failed write: the job is confirmed only once it is on disk.
        if (this.unsavedRecords) await this.#persist();
        return { job: structuredClone(existing), documents: unique.map((item) => structuredClone(this.documents.get(item.document_id))), created: false };
      }
      // Only finished jobs past their retention make room; a held or running job of anybody never does. They go first,
      // so neither the job nor the byte quota counts what retention already released. (A retry keeps its own job.)
      await this.#reclaim(jobId);
      const takeover = this.#takesOver(reviewOf);
      if (!existing) this.#assertJobRoom(ownerId, takeover);
      const fresh = unique.filter((item) => !this.documents.has(item.document_id));
      const freshBytes = fresh.reduce((sum, item) => sum + item.buffer.length, 0);
      const stored = [...this.documents.values()];
      const ownerBytes = stored.filter((record) => record.owner_id === ownerId).reduce((sum, record) => sum + record.size, 0);
      const totalBytes = stored.reduce((sum, record) => sum + record.size, 0);
      // The first correction of a held job may use the reserve: the held material may fill the quota, its correction never waits for it.
      const reserve = takeover ? this.reviewReserveBytes : 0;
      if (ownerBytes + freshBytes > this.maxOwnerBytes + reserve) {
        throw this.#capacityError('upload_quota_exceeded', 413, ownerId, { used: ownerBytes, limit: this.maxOwnerBytes + reserve, incoming: freshBytes, scope: 'workspace' });
      }
      if (totalBytes + freshBytes > this.maxStoredBytes + reserve) {
        throw this.#capacityError('intake_storage_full', 507, ownerId, { used: totalBytes, limit: this.maxStoredBytes + reserve, incoming: freshBytes, scope: 'intake' });
      }

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
      // A retry of a failed, interrupted or withdrawn job is a new event: reusing the first event id would be
      // dropped by the bus as a duplicate and the retry would never run.
      const attempt = existing ? (existing.attempt ?? 1) + 1 : 1;
      // A review is written with the job it reviews and its own event identity, so a retry can deliver it again.
      const eventBase = reviewOf ? `review:${jobId}` : `ingest:${jobId}`;
      const job = {
        job_id: jobId,
        owner_id: ownerId,
        visibility: (access ?? this.access.get(caseId))?.visibility ?? visibility,
        mode: this.getMode(),
        case_id: caseId,
        ...(target.source_case_id ? { source_case_id: target.source_case_id } : {}),
        ...(reviewOf ? { reviewed_job_id: reviewOf } : {}),
        status: 'QUEUED',
        document_ids: unique.map((item) => item.document_id),
        steps: [],
        decision_ids: [],
        ...(attempt > 1 ? { attempt, previous_decision_ids: [...(existing.previous_decision_ids ?? []), ...(existing.decision_ids ?? [])] } : {}),
        event_id: attempt > 1 ? `${eventBase}:attempt-${attempt}` : eventBase,
        created_at: at,
        updated_at: at
      };
      this.jobs.set(jobId, job);
      try {
        await this.#persist();
      } catch (error) {
        // Not committed: nothing of this request stays visible, so a retry commits it again. (The access record stays: it
        // is this workspace's either way.) Document records the failed write did leave on disk reference no job and
        // are removed the next time the intake starts or writes.
        if (existing) this.jobs.set(jobId, existing); else this.jobs.delete(jobId);
        for (const [record] of records) { this.documents.delete(record.document_id); this.#uncache(record.document_id); }
        for (const file of written) await fs.rm(path.join(this.dir, file), { force: true }).catch(() => {});
        throw error;
      }
      return { job: structuredClone(job), documents: unique.map((item) => structuredClone(this.documents.get(item.document_id))), created: true };
    });
  }

  /** Whether a review of `reviewOf` is the first correction of a held job (it then takes over that job's slot). */
  #takesOver(reviewOf) {
    return Boolean(reviewOf) && this.jobs.has(reviewOf) && !this.#reviewChains().superseded.has(reviewOf);
  }

  /** A capacity refusal that says what is used, what the limit is, which held jobs of this workspace hold it, and what to do. */
  #capacityError(code, status, ownerId, { used, limit, incoming, scope }) {
    const held = this.#openJobs().filter((job) => job.owner_id === ownerId);
    const reclaimable = this.usage().reclaimable_bytes;
    const message = scope === 'workspace'
      ? 'This workspace has reached its upload storage quota; correct or withdraw its held jobs, or wait until finished ones expire'
      : 'The intake store is full; correct or withdraw held jobs, or try again once finished jobs expire';
    return new IngestError(code, message, status, {
      scope, used_bytes: used, limit_bytes: limit, incoming_bytes: incoming, reclaimable_bytes: reclaimable,
      held_jobs: held.length,
      // This workspace's own held jobs only: another workspace's are not its business.
      held_job_ids: held.slice(0, 20).map((job) => job.job_id),
      next_step: held.length ? 'correct_or_withdraw_held_jobs' : 'wait_for_retention'
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
    if (await fs.stat(file).then((stat) => stat.isFile(), () => false)) return false;
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
   * Held jobs a later review has taken over, and every earlier version under them: a review that needs none resolves
   * the whole chain it corrects, not only the job it named.
   */
  #reviewChains() {
    const superseded = new Set(), resolved = new Set();
    for (const job of this.jobs.values()) {
      // A withdrawn correction takes nothing over: the job it corrected holds its own slot again.
      if (job.status === 'WITHDRAWN') continue;
      const done = job.status === 'DONE' && !job.review_required;
      for (let id = job.reviewed_job_id, seen = 0; id && this.jobs.has(id) && seen < this.jobs.size; id = this.jobs.get(id).reviewed_job_id, seen++) {
        superseded.add(id);
        if (done) resolved.add(id);
      }
    }
    return { superseded, resolved };
  }

  /**
   * Where each job stands for whoever must act on it: a held job is 'open' (it waits for a correction), 'superseded'
   * (a correction of it is queued, running or held itself) or 'resolved' (a correction needs no review); a withdrawn one
   * is 'withdrawn'. `latest` is the newest correction of each job. Only 'open' jobs are anybody's to-do.
   */
  #reviewStates() {
    const { resolved } = this.#reviewChains();
    const live = new Set(), latest = new Map();
    for (const job of this.jobs.values()) {
      if (!job.reviewed_job_id) continue;
      if (!RETRYABLE.has(job.status)) live.add(job.reviewed_job_id);
      const seen = latest.get(job.reviewed_job_id);
      if (!seen || Date.parse(job.created_at) >= Date.parse(seen.created_at)) latest.set(job.reviewed_job_id, job);
    }
    const states = new Map();
    for (const job of this.jobs.values()) {
      if (job.status === 'WITHDRAWN') states.set(job.job_id, 'withdrawn');
      else if (job.status === 'DONE' && job.review_required) states.set(job.job_id, resolved.has(job.job_id) ? 'resolved' : live.has(job.job_id) ? 'superseded' : 'open');
    }
    return { states, latest };
  }

  /** Jobs that wait for a correction (the to-dos), in no particular order. */
  #openJobs() {
    const { states } = this.#reviewStates();
    return [...this.jobs.values()].filter((job) => states.get(job.job_id) === 'open');
  }

  /**
   * Jobs whose retention has ended: finished, needing no review (or resolved by a later review that needs none, or
   * withdrawn), and unchanged for the retention period. Their decisions keep their own evidence; only the raw bytes go.
   */
  #expiredJobs() {
    const cutoff = this.now().getTime() - this.jobRetentionMs;
    const { resolved } = this.#reviewChains();
    return [...this.jobs.values()].filter((job) => FINISHED.has(job.status) && (job.status === 'WITHDRAWN' || !job.review_required || resolved.has(job.job_id))
      && Date.parse(job.updated_at ?? job.created_at) <= cutoff).map((job) => job.job_id);
  }

  /** Remove the jobs retention released (except `keep`, a job being retried) and the bytes only they referenced. */
  async #reclaim(keep = null) {
    const expired = this.#expiredJobs().filter((id) => id !== keep);
    if (!expired.length) return 0;
    for (const id of expired) this.jobs.delete(id);
    if (!await this.#collect()) await this.#persist();
    return expired.length;
  }

  /** Release what retention allows now, without waiting for the next upload (startup, the agent's tick). */
  async reclaimExpired() {
    await this.init();
    return this.commits(() => this.#reclaim());
  }

  /**
   * Room for one more job. Every record counts towards the table's ceiling of twice the quota (earlier versions and
   * withdrawn jobs stay until retention). A new upload also needs a free slot of the workspace's and the intake's job
   * quota, counted in logical jobs. The first review of a held job takes over that job's slot, so it only needs the
   * ceiling; a second, parallel correction of the same job counts as a new logical job.
   */
  #assertJobRoom(ownerId, takeover) {
    const { superseded } = this.#reviewChains();
    const jobs = [...this.jobs.values()], own = jobs.filter((job) => job.owner_id === ownerId);
    if (own.length >= this.maxOwnerJobs * 2 || jobs.length >= this.maxJobs * 2) {
      if (takeover) throw new IngestError('review_capacity_exhausted', 'Earlier review versions fill the intake; they are released when their corrections finish and expire', 507);
      throw new IngestError(own.length >= this.maxOwnerJobs * 2 ? 'upload_job_quota_exceeded' : 'intake_jobs_full',
        'Earlier versions and withdrawn jobs fill the job table until they reach their retention period', own.length >= this.maxOwnerJobs * 2 ? 413 : 507);
    }
    if (takeover) return;
    const logical = (job) => !superseded.has(job.job_id) && job.status !== 'WITHDRAWN';
    if (own.filter(logical).length >= this.maxOwnerJobs) {
      throw new IngestError('upload_job_quota_exceeded', 'This workspace keeps the most jobs it may; correct or withdraw held jobs, or wait until finished ones expire', 413,
        { held_jobs: this.#openJobs().filter((job) => job.owner_id === ownerId).length, next_step: 'correct_or_withdraw_held_jobs' });
    }
    if (jobs.filter(logical).length >= this.maxJobs) {
      throw new IngestError('intake_jobs_full', 'The intake keeps no more jobs until finished ones reach their retention period; try again later', 507);
    }
  }

  /**
   * Drop documents no retained job references (a withdrawn job references none), and their files when no other
   * document shares the content. The records are written first: a crash before the files are removed leaves only
   * orphans, which the next start sweeps. A failed write puts the records back, so memory never runs ahead of the disk.
   */
  async #collect() {
    const referenced = new Set([...this.jobs.values()].filter((job) => job.status !== 'WITHDRAWN').flatMap((job) => job.document_ids));
    const removed = [...this.documents].filter(([id]) => !referenced.has(id));
    if (!removed.length) return 0;
    for (const [id] of removed) this.documents.delete(id);
    try {
      await this.#persist();
    } catch (error) {
      for (const [id, record] of removed) this.documents.set(id, record);
      throw error;
    }
    for (const [id] of removed) this.#uncache(id);
    const kept = new Set([...this.documents.values()].map((record) => record.stored_as));
    for (const [, record] of removed) {
      if (this.dir && record.stored_as && !kept.has(record.stored_as)) await fs.rm(path.join(this.dir, record.stored_as), { force: true });
    }
    return removed.length;
  }

  /**
   * The owner gives up a job: a held job waiting for a correction (with every version it corrects and their failed
   * corrections), or a failed or interrupted one. They become WITHDRAWN, wait for nothing, and their raw bytes are
   * released now instead of after retention; the records stay until retention and each decision keeps its evidence.
   * A version that another correction still builds on (queued, running or held) is not withdrawn from under it.
   */
  async withdraw(jobId) {
    await this.init();
    return this.commits(async () => {
      const job = this.jobs.get(jobId);
      if (!job) throw new IngestError('job_not_found', 'Unknown ingest job', 404);
      const { states } = this.#reviewStates();
      const members = new Set([job]);
      if (states.get(jobId) === 'open') {
        for (let id = job.reviewed_job_id, seen = 0; id && this.jobs.has(id) && seen < this.jobs.size; id = this.jobs.get(id).reviewed_job_id, seen++) members.add(this.jobs.get(id));
        const ids = new Set([...members].map((member) => member.job_id));
        for (const other of this.jobs.values()) {
          if (!ids.has(other.reviewed_job_id) || ids.has(other.job_id) || other.status === 'WITHDRAWN') continue;
          if (!RETRYABLE.has(other.status)) throw new IngestError('review_in_progress', 'Another correction still builds on this job; withdraw or finish that one first', 409);
          members.add(other);
        }
      } else if (!['FAILED', 'INTERRUPTED'].includes(job.status)) {
        throw new IngestError('job_not_withdrawable', 'Only a held job waiting for a correction, or a failed one, can be withdrawn', 409);
      }
      const at = this.now().toISOString();
      const before = [...members].map((member) => [member.job_id, structuredClone(member)]);
      for (const member of members) Object.assign(member, { status: 'WITHDRAWN', withdrawn_from: member.status, withdrawn_at: at, updated_at: at });
      try {
        if (!await this.#collect()) await this.#persist();
      } catch (error) {
        for (const [id, copy] of before) this.jobs.set(id, copy);
        throw error;
      }
      return { job: structuredClone(job), withdrawn: [...members].map((member) => member.job_id) };
    });
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

  /**
   * One page of jobs and the totals a page alone cannot show: how many jobs match, and how many of them wait for a
   * correction. Those come first (newest first), then every other job (newest first), so the to-dos are always on the
   * first page. Each job says where it stands in its review chain (`review_state`) and names its newest correction.
   */
  pageJobs({ case_id: caseId, limit = 50, offset = 0, filter } = {}) {
    const { states, latest } = this.#reviewStates();
    const open = (job) => states.get(job.job_id) === 'open';
    const matching = [...this.jobs.values()].filter((job) => (!caseId || job.case_id === caseId) && (!filter || filter(job)))
      .sort((a, b) => Number(open(b)) - Number(open(a)) || Date.parse(b.created_at) - Date.parse(a.created_at) || a.job_id.localeCompare(b.job_id));
    const page = matching.slice(offset, offset + limit).map((job) => ({ ...structuredClone(job), review_state: states.get(job.job_id) ?? null,
      ...(latest.has(job.job_id) ? { reviewed_by: latest.get(job.job_id).job_id } : {}) }));
    const end = offset + page.length;
    return { jobs: page, total: matching.length, held_total: matching.filter(open).length, next_offset: end < matching.length ? end : null };
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
    const { superseded } = this.#reviewChains();
    const expired = new Set(this.#expiredJobs());
    const keptIds = new Set([...this.jobs.values()].filter((job) => !expired.has(job.job_id) && job.status !== 'WITHDRAWN').flatMap((job) => job.document_ids));
    const jobs = [...this.jobs.values()], withdrawn = jobs.filter((job) => job.status === 'WITHDRAWN').length;
    return { documents: records.length, jobs: this.jobs.size, max_jobs: this.maxJobs, stored_bytes: records.reduce((sum, record) => sum + record.size, 0),
      max_stored_bytes: this.maxStoredBytes, review_reserve_bytes: this.reviewReserveBytes, cached_bytes: this.cachedBytes, cases_with_access_records: this.access.size,
      access_state: this.accessState,
      // Jobs waiting for a correction (the same count the job list reports), the logical jobs the quota counts, and what
      // the table can still take for reviews.
      held_jobs: this.#openJobs().length, withdrawn_jobs: withdrawn,
      logical_jobs: jobs.filter((job) => !superseded.has(job.job_id) && job.status !== 'WITHDRAWN').length,
      review_headroom_jobs: Math.max(0, this.maxJobs * 2 - this.jobs.size),
      // Bytes retention already released but not yet removed (the next reclaim removes them).
      reclaimable_bytes: records.filter((record) => !keptIds.has(record.document_id)).reduce((sum, record) => sum + record.size, 0),
      // Whether the last write of the document and job records failed (the tick writes them again).
      unsaved_records: Boolean(this.unsavedRecords) };
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
    if (this.dir) await writeJsonAtomic(path.join(this.dir, 'cases', `${caseData.case_id}.case.json`), privateCase, PRIVATE_FILE);
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
