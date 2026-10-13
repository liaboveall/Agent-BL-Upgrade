// Only the PDF text layer is read. No rendering, image decoding, embedded scripts or remote fonts.
import { parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';

/** Reconstruct rows and separated table cells without treating every word as a column. */
export function textRows(items) {
  const rows = [];
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const y = item.transform[5];
    const last = rows.at(-1);
    if (last && Math.abs(last.y - y) <= 2) last.items.push(item);
    else rows.push({ y, items: [item] });
  }
  return rows.map(({ items: row }) => {
    const cells = [];
    let right = -Infinity;
    for (const item of row.sort((a, b) => a.transform[4] - b.transform[4])) {
      const gap = item.transform[4] - right;
      if (cells.length && gap < Math.max(12, Math.abs(item.height) * 1.5)) cells[cells.length - 1] += ` ${item.str}`;
      else cells.push(item.str);
      right = item.transform[4] + item.width;
    }
    return cells.length > 1 ? `| ${cells.join(' | ')} |` : cells[0];
  });
}

export async function readPdf({ bytes, maxPages, maxTextChars }) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), {
    isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
    useWorkerFetch: false, disableAutoFetch: true, disableStream: true,
    standardFontDataUrl: null, cMapUrl: null, maxImageSize: 16_777_216, verbosity: 0,
    stopAtErrors: true
  });
  try {
    if (pdf.numPages > maxPages) throw Object.assign(new Error('PDF exceeds the page limit'), { code: 'PDF_PAGE_LIMIT' });
    const pages = [], linePages = [], blankPages = [];
    let length = 0;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const { items } = await page.getTextContent();
      const lines = textRows(items);
      const text = lines.join('\n');
      if (text.trim().length < 20) blankPages.push(number);
      length += text.length + 1;
      if (length > maxTextChars) throw Object.assign(new Error('PDF exceeds the extracted text limit'), { code: 'PDF_TEXT_LIMIT' });
      pages.push(text);
      linePages.push(...Array(Math.max(1, lines.length)).fill(number));
      page.cleanup();
    }
    return { text: pages.join('\n'), linePages, totalPages: pdf.numPages, blankPages, extractor: 'pdf-text' };
  } finally {
    await pdf.destroy();
  }
}

if (parentPort) {
  try {
    parentPort.postMessage({ result: await readPdf(workerData) });
  } catch (error) {
    const code = error.name === 'PasswordException' ? 'PDF_PASSWORD_REQUIRED'
      : ['PDF_PAGE_LIMIT', 'PDF_TEXT_LIMIT'].includes(error.code) ? error.code : 'PDF_INVALID';
    // Parser errors can contain document bytes. Return a fixed message instead.
    parentPort.postMessage({ error: { code, message: {
      PDF_PASSWORD_REQUIRED: 'The PDF is password protected; provide an unlocked document for review.',
      PDF_PAGE_LIMIT: 'The PDF exceeds the configured page limit.',
      PDF_TEXT_LIMIT: 'The PDF exceeds the extracted text limit.',
      PDF_INVALID: 'The PDF could not be read; provide a valid document for review.'
    }[code] } });
  }
}
