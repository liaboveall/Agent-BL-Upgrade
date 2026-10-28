// The curated, explicitly public example cases (data/demo-case.json and data/cases/*.case.json).
// Their identifiers are a read-only public namespace: a private upload never takes one over, it
// works on its own copy instead (see IngestService.resolveUploadCase).
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(import.meta.dirname, '../../../data');
let cached = null;

/** Case IDs of the curated catalog, read once. A file that cannot be read is skipped, never fatal. */
export function curatedCaseIds(dataDir = DATA_DIR) {
  if (cached && dataDir === DATA_DIR) return cached;
  const ids = new Set();
  const add = (file) => {
    try {
      const id = JSON.parse(fs.readFileSync(file, 'utf8'))?.case_id;
      if (typeof id === 'string' && id) ids.add(id);
    } catch { /* not a readable case file */ }
  };
  add(path.join(dataDir, 'demo-case.json'));
  let names = [];
  try { names = fs.readdirSync(path.join(dataDir, 'cases')).filter((name) => name.endsWith('.case.json')); } catch { /* no catalog */ }
  for (const name of names) add(path.join(dataDir, 'cases', name));
  if (dataDir === DATA_DIR) cached = ids;
  return ids;
}
