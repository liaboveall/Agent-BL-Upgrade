// Approved financing disclosure packs are public by design: investors download them and verify them offline.
// Keeping a plain copy, addressed by its disclosure hash, means the terms of a live pool stay readable when the
// encrypted identity vault is unavailable (another instance, a missing key, a lost vault). A copy is trusted only
// when it recomputes to that hash; the financing review then binds it to the chain's terms hash before any signing.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../lib/jsonStore.js';
import { verifyDisclosure } from './disclosure.js';

// Packs an operator ships with a checkout (copied from a runtime's public-disclosures directory).
export const SHIPPED_DISCLOSURES = path.resolve(import.meta.dirname, '../../data/disclosures');
const HASH = /^0x[a-f0-9]{64}$/u;

const fileFor = (directory, disclosureHash) => path.join(directory, `${disclosureHash.toLowerCase()}.json`);

/** Keep an approved pack's public copy once; existing files are never rewritten. */
export async function savePublicDisclosure(directory, pack) {
  const hash = String(pack?.disclosure_hash ?? '').toLowerCase();
  if (!HASH.test(hash) || !verifyDisclosure(pack)) return false;
  const file = fileFor(directory, hash);
  if (await fs.access(file).then(() => true, () => false)) return false;
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomic(file, pack, { durable: true });
  return true;
}

/** The first intact public copy of this disclosure in `directories`, or null. */
export async function readPublicDisclosure(disclosureHash, directories) {
  const hash = String(disclosureHash ?? '').toLowerCase();
  if (!HASH.test(hash)) return null;
  for (const directory of directories) {
    const pack = await readJson(fileFor(directory, hash)).catch(() => null);
    if (pack && String(pack.disclosure_hash).toLowerCase() === hash && verifyDisclosure(pack)) return pack;
  }
  return null;
}
