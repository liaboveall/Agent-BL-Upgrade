import { createHash } from 'node:crypto';

/** Strict CSV reader for OFAC's headerless SDN export, including quoted commas/newlines.
 * This is a source/fidelity adapter; absence of an exact primary-name match never clears a party. */
export function parseSdnExport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 12 * 1024 * 1024) throw new Error('Screening source exceeds the supported size');
  const original = text; text = text.replace(/^\uFEFF/u, '');
  // eslint-disable-next-line no-control-regex -- Published OFAC CSV ends with a single DOS EOF marker.
  text = text.replace(/\u001a$/u, '');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const cell = () => { row.push(field); field = ''; closed = false; };
  const line = () => { cell(); if (row.some((value) => value.trim())) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"') {
      if (field || closed) throw new Error('Malformed screening CSV'); quoted = true;
    } else if (char === ',') cell();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i + 1] === '\n') i++; line(); }
    else { if (closed && char.trim()) throw new Error('Malformed screening CSV'); if (!closed) field += char; }
  }
  if (quoted) throw new Error('Truncated screening CSV'); if (field || row.length) line();
  if (!rows.length || rows.length > 50000 || rows.some((item) => item.length !== 12 || !/^\d+$/u.test(item[0].trim()) || !item[1].trim())) throw Object.assign(new Error('Unsupported SDN export schema'), {
    details: { rows: rows.length, field_counts: Object.fromEntries([...new Set(rows.map((item) => item.length))].map((count) => [count, rows.filter((item) => item.length === count).length])),
      invalid_id_rows: rows.filter((item) => !/^\d+$/u.test(item[0].trim())).length }
  });
  const records = rows.map(([entryId, name, type, program]) => ({ entry_id: entryId.trim(), name: name.trim(), type, program }));
  if (new Set(records.map((item) => item.entry_id)).size !== records.length) throw new Error('Duplicate source entries');
  return { schema: 'agentbl-ofac-primary-names-v1', source_sha256: createHash('sha256').update(original).digest('hex'), records };
}
const normalize = (value) => value.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function screenPrimaryName(source, name) {
  if (source?.schema !== 'agentbl-ofac-primary-names-v1' || typeof name !== 'string' || !normalize(name)) throw new Error('Valid source and screening name required');
  const matches = source.records.filter((entry) => normalize(entry.name) === normalize(name));
  return { status: matches.length ? 'MATCH_REVIEW' : 'NO_EXACT_PRIMARY_NAME_MATCH', entry_ids: matches.map((item) => item.entry_id),
    source_sha256: source.source_sha256, scope: 'OFAC_SDN_primary_names_only', human_review_required: true, eligible: false,
    limitations: ['aliases_not_screened', 'beneficial_ownership_not_assessed', 'non_sdn_and_other_jurisdictions_not_screened', 'not_a_legal_determination'] };
}
