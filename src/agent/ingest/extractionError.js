export class DocumentParseError extends Error {
  constructor(message, code = 'DOCUMENT_PARSE_ERROR', details = {}) {
    super(message);
    this.name = 'DocumentParseError';
    this.code = code;
    this.details = details;
  }
}
