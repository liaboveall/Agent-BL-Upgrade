import fs from 'node:fs/promises';
import { sanitizeAudit } from '../security/privacy.js';
import { readJsonl, writeFileAtomic } from '../../lib/jsonStore.js';

export function retainRecords(records, { now, retentionDays, maxRecords, protectedDecisions = new Set(), timestamp = 'timestamp' }) {
  const cutoff = now - retentionDays * 86400000;
  let kept = records.filter((record) => protectedDecisions.has(record.decision_id) || Date.parse(record[timestamp]) >= cutoff);
  let excess = Math.max(0, kept.length - maxRecords);
  kept = kept.filter((record) => {
    if (excess && !protectedDecisions.has(record.decision_id)) { excess--; return false; }
    return true;
  });
  return kept;
}

// Caller serializes this operation with appends. Consolidate rotations before applying a global cap.
export async function pruneJsonl(file, keepFiles, options) {
  if (!file) return [];
  const records = await readJsonl(file, { includeRotated: true, keepFiles });
  const kept = retainRecords(records, options).map((record) => sanitizeAudit(record));
  await writeFileAtomic(file, kept.map((record) => JSON.stringify(record)).join('\n') + (kept.length ? '\n' : ''));
  for (let i = 1; i <= keepFiles; i++) await fs.rm(`${file}.${i}`, { force: true });
  return kept;
}
