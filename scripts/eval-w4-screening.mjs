import fs from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parseSdnExport, screenPrimaryName } from '../src/provenance/screening.js';

const base = 'docs/evidence/w4-local-2026-10-17/provider-runs', at = new Date().toISOString();
await fs.mkdir(base, { recursive: true });
const result = { schema: 'agentbl-screening-source-probe-v1', executed_at: at,
  provider: 'OFAC-public-Sanctions-List-Service', status: 'UNAVAILABLE', business_accepted: false, attempts: [] };
for (const url of ['https://sanctionslistservice.ofac.treas.gov/api/download/sdn.csv', 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV']) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
    result.attempts.push({ url, http_status: response.status, response_host: new URL(response.url).hostname }); if (!response.ok) continue;
    const text = await response.text(), sourceHash = createHash('sha256').update(text).digest('hex');
    const sourceFile = `ofac-sdn-${sourceHash}.csv.gz`;
    await fs.writeFile(`${base}/${sourceFile}`, gzipSync(Buffer.from(text)));
    result.attempts.at(-1).source_file = sourceFile;
    result.attempts.at(-1).source_sha256 = sourceHash;
    const source = parseSdnExport(text);
    Object.assign(result, { status: 'SOURCE_OBSERVED', source_url: url, source_sha256: source.source_sha256,
      source_last_modified: response.headers.get('last-modified'), source_file: sourceFile, rows: source.records.length,
      probes: ['BANK MELLAT', 'DCSA CTK', 'Global Retail Imports'].map((name) => ({ name, ...screenPrimaryName(source, name) })),
      scope: 'source connectivity and exact primary-name fidelity; not an independent sanctions screening quality evaluation' });
    break;
  } catch (error) { result.attempts.push({ url, error: error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'TIMEOUT' : 'SOURCE_UNAVAILABLE_OR_SCHEMA_INVALID',
    transport_code: /^[A-Z_]{1,80}$/u.test(error?.cause?.code ?? '') ? error.cause.code : null,
    schema_diagnostics: error?.details ?? null }); }
}
const file = `${base}/${at.replaceAll(/[:.]/gu, '-')}-screening.json`;
await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ file, status: result.status, rows: result.rows ?? null, attempts: result.attempts, business_accepted: false }));
