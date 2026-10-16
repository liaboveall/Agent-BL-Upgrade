// Loading the curated demo data the way the app shows it: dates moved to today (./caseDates.js) and,
// for cases with a benchmark or route profile, today's market and route evidence attached
// (../realdata/index.js). Raw JSON on disk stays anchored, so diffs and tests remain stable.

import fs from 'node:fs/promises';
import { rebaseCaseDates, rebaseDocumentText } from './caseDates.js';
import { enrichCaseWithRealData } from '../realdata/index.js';

/** A curated case object as the app shows it today. */
export async function prepareCuratedCase(raw, options = {}) {
  return enrichCaseWithRealData(rebaseCaseDates(raw, options), options);
}

/** Read and prepare a curated case file (path or file URL). */
export async function loadCuratedCase(file, options = {}) {
  return prepareCuratedCase(JSON.parse(await fs.readFile(file, 'utf8')), options);
}

/** Read a curated document (Markdown written around the demo anchor) with its dates moved to today. */
export async function loadCuratedDocument(file, options = {}) {
  return rebaseDocumentText(await fs.readFile(file, 'utf8'), options);
}
