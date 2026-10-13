import { Worker } from 'node:worker_threads';
import { DocumentParseError } from './extractionError.js';

export const PDF_LIMITS = Object.freeze({ maxPages: 30, maxTextChars: 200_000, timeoutMs: 10_000 });

/** A terminable worker keeps malformed / expensive PDFs off the HTTP event loop. */
export async function extractPdfText(buffer, options = {}) {
  if (Buffer.from(buffer).subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new DocumentParseError('The document is not a PDF.', 'PDF_INVALID');
  }
  const limits = { ...PDF_LIMITS, ...options };
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdfWorker.js', import.meta.url), {
      workerData: { bytes: Uint8Array.from(buffer), maxPages: limits.maxPages, maxTextChars: limits.maxTextChars },
      // Host/test V8 and CLI flags are not valid worker flags. The parser also needs no credentials.
      execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 },
      stdout: true, stderr: true
    });
    worker.stdout.resume(); worker.stderr.resume();
    let finished = false;
    const finish = async (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      await worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new DocumentParseError('PDF extraction timed out; split or replace the document.', 'PDF_TIMEOUT')), limits.timeoutMs);
    worker.once('message', ({ result, error }) => {
      if (error) return finish(new DocumentParseError(error.message, error.code));
      if (!result.text.trim() || result.text.trim().length < 20) {
        return finish(new DocumentParseError('The PDF has no usable text layer; OCR or corrected text is required.', 'OCR_REQUIRED'));
      }
      finish(null, result);
    });
    worker.once('error', () => finish(new DocumentParseError('The PDF exceeded parser resources or could not be read.', 'PDF_INVALID')));
    worker.once('exit', () => {
      if (!finished) finish(new DocumentParseError('The PDF parser stopped before extraction completed.', 'PDF_INVALID'));
    });
  });
}
