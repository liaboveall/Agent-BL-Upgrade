// Small real PDFs made from synthetic text. No PDF generator or native canvas dependency.
export function pdfFixture(pages = [''], { columns = false, imageOnly = false } = {}) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pageIds = [];
  for (const text of pages) {
    const pageId = objects.length + 1, contentId = pageId + 1;
    pageIds.push(pageId);
    const escape = (value) => [...value].map((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126 ? char : ' ')
      .join('').replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    const commands = [];
    for (const [index, line] of text.split('\n').entries()) {
      const cells = columns && line.trim().startsWith('|') ? line.split('|').slice(1, -1).map((cell) => cell.trim()) : [line];
      for (const [column, value] of cells.entries()) {
        if (value) commands.push(`BT /F1 7 Tf 1 0 0 1 ${20 + column * 190} ${1000 - index * 10} Tm (${escape(value)}) Tj ET`);
      }
    }
    const content = imageOnly ? 'q 100 0 0 100 20 900 cm /Im1 Do Q' : commands.join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1600 1100] /Resources << /Font << /F1 3 0 R >>${imageOnly ? ` /XObject << /Im1 ${3 + pages.length * 2 + 1} 0 R >>` : ''} >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  }
  if (imageOnly) objects.push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nffffff>\nendstream');
  objects[1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  let body = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
