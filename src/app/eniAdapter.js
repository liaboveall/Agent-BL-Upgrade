// ENI Adapter for eBL document ingestion.
//
// There is no ENI/TradeGo API or sandbox to call, so this adapter is a MOCK and says so on every
// record (`mode: 'mock'`). It only acknowledges receipt of a document: it does not verify the
// document, and nothing is written to any network. "status: received" means exactly that.

import crypto from 'node:crypto';
import { HttpError } from './http.js';

export const ALLOWED_DOCUMENT_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png']);
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_NAME_LENGTH = 255;
const MAX_TRACKED_DOCUMENTS = 1000;

function invalidDocument(message) {
  return new HttpError(400, 'invalid_document', message);
}

/** Keep only the base name and drop control characters so it is safe to log and echo. */
export function sanitizeFileName(value) {
  const base = String(value ?? '').split(/[\\/]/u).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, MAX_NAME_LENGTH);
}

export class ENIAdapter {
  constructor(mode = 'mock') {
    this.mode = mode; // 'live' or 'mock'
    this.documents = new Map(); // documentId -> record (bounded)
  }

  async uploadDocument(file) {
    if (this.mode === 'live') {
      return this._uploadToENI(file);
    }
    return this._mockUpload(file);
  }

  async _uploadToENI(_file) {
    // Real ENI integration would go here
    throw new Error('Live ENI not available - falling back to mock');
  }

  _mockUpload(file) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw invalidDocument('file must be an object with name, type and size');
    }
    const { type, size, content } = file;
    const name = sanitizeFileName(file.name);
    if (!name) throw invalidDocument('file.name is required');

    // Validate file type
    if (!ALLOWED_DOCUMENT_TYPES.includes(type)) {
      throw invalidDocument(`Invalid file type: ${type}. Allowed: ${ALLOWED_DOCUMENT_TYPES.join(', ')}`);
    }

    // Validate file size (10MB limit). The browser only sends metadata, so the
    // declared size is checked; when content is present its real size counts too.
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      throw invalidDocument('file.size must be a non-negative number of bytes');
    }
    if (content !== undefined && typeof content !== 'string') {
      throw invalidDocument('file.content must be a string when provided');
    }
    const effectiveSize = Math.max(size, typeof content === 'string' ? Buffer.byteLength(content) : 0);
    if (effectiveSize > MAX_DOCUMENT_BYTES) {
      throw invalidDocument('File size exceeds 10MB limit');
    }

    // The hash is of the content when the client sent it. A metadata-only upload (the browser
    // currently sends just name/type/size) is hashed over that metadata instead, deterministically
    // and flagged `content_hashed: false` so nobody mistakes it for a hash of the document.
    const contentHashed = typeof content === 'string' && content.length > 0;
    const hash = crypto.createHash('sha256')
      .update(contentHashed ? content : JSON.stringify({ name, type, size }))
      .digest('hex');

    const record = {
      documentId: `ENI-DOC-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`,
      documentHash: hash,
      content_hashed: contentHashed,
      fileName: name,
      fileType: type,
      fileSize: size,
      uploadedAt: new Date().toISOString(),
      status: 'received',
      mode: 'mock',
      eniNetwork: 'mock'
    };
    this._remember(record);
    return record;
  }

  _remember(record) {
    if (this.documents.size >= MAX_TRACKED_DOCUMENTS) {
      this.documents.delete(this.documents.keys().next().value);
    }
    this.documents.set(record.documentId, record);
  }

  async getDocumentStatus(documentId) {
    const record = this.documents.get(String(documentId));
    if (!record) throw new HttpError(404, 'document_not_found', 'Unknown document_id');
    return {
      documentId: record.documentId,
      status: record.status,
      mode: record.mode,
      receivedAt: record.uploadedAt
    };
  }
}

export const eniAdapter = new ENIAdapter('mock');
