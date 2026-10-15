import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../lib/jsonStore.js';
import { sanitizeAudit, stripSecretFields, sealRecords, openRecords } from './privacy.js';

async function storageKey(file, create) {
  try { return Buffer.from(await fs.readFile(`${file}.key`, 'utf8'), 'base64'); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(`${file}.key`, crypto.generateKeySync('aes', { length: 256 }).export().toString('base64'), { flag: 'wx', mode: 0o600 }); }
    catch (race) { if (race.code !== 'EEXIST') throw race; }
    return storageKey(file, false);
  }
}

export async function writePrivateJson(file, input) {
  const value = stripSecretFields(input);
  await writeJsonAtomic(file, { ...sanitizeAudit(value), _private: sealRecords(value, await storageKey(file, true)) });
}

export async function readPrivateJson(file, fallback = null) {
  const stored = await readJson(file, fallback);
  if (!stored?._private) return stored;
  const { _private: sealed, ...audit } = stored;
  const decoded = openRecords(sealed, await storageKey(file, false));
  // Compare JSON after canonicalizing recursively without importing the decision logger.
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  if (JSON.stringify(canonical(sanitizeAudit(decoded))) !== JSON.stringify(canonical(audit))) throw new Error('Operational journal authentication mismatch');
  return decoded;
}
