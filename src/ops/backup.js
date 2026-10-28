import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { seal, unseal } from '../rights/vault.js';
import { writeJsonAtomic } from '../lib/jsonStore.js';
import { acquireRuntimeLease, runtimeRestoreLock } from './lease.js';
import { RUNTIME_BACKUP_LIMIT_BYTES } from './budget.js';

const AAD = 'agentbl-runtime-backup-v1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const limit = RUNTIME_BACKUP_LIMIT_BYTES;
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const skip = (name) => /^\.(?:runtime-lease|abandoned-runtime-|restore-incomplete)/u.test(name);
function relativePath(name) {
  ensure(typeof name === 'string' && name.length > 0 && name.length < 1024 && !name.includes('\\') && !name.includes(':')
    && !name.includes('\0') && !name.startsWith('/') && name.split('/').every((part) => part && part !== '.' && part !== '..'), 'Unsafe backup path');
  return name;
}
async function walk(root, prefix = '') {
  const result = [];
  for (const entry of (await fs.readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!prefix && skip(entry.name)) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    relativePath(name);
    ensure(!entry.isSymbolicLink(), 'Symlinks are forbidden in runtime backups');
    if (entry.isDirectory()) result.push(...await walk(root, name));
    else { ensure(entry.isFile(), 'Unsupported runtime file'); result.push(name); }
  }
  return result;
}
export async function createRuntimeBackup({ directory, output, key, configuration = {}, sourceRevision = 'UNRECORDED' }) {
  ensure(Buffer.isBuffer(key) && key.length === 32, 'A separate 32-byte backup key is required');
  const root = path.resolve(directory), destination = path.resolve(output);
  ensure(!destination.startsWith(root + path.sep) && destination !== root, 'Backup must be outside the runtime directory');
  await fs.access(root);
  const unlock = await acquireRuntimeLease(root, 'stopped-service-backup');
  try {
    const files = [], names = await walk(root); let total = 0;
    for (const name of names) {
      const data = await fs.readFile(path.join(root, name)); total += data.length; ensure(total <= limit, 'Backup exceeds supported size');
      files.push({ path: name, size: data.length, sha256: hash(data), data: data.toString('base64') });
    }
    const manifest = { schema: AAD, created_at: new Date().toISOString(), source_revision: sourceRevision, consistency: 'stopped-single-writer',
      configuration, total_bytes: total, files };
    const envelope = { schema: 'agentbl-encrypted-runtime-backup-v1', ...seal(key, manifest, AAD) };
    // Never overwrite a recovery point, even if an operator reuses a filename.
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const handle = await fs.open(destination, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(envelope)}\n`); await handle.sync(); } finally { await handle.close(); }
    return { schema: AAD, file_count: files.length, total_bytes: total, encrypted_sha256: hash(await fs.readFile(destination)),
      source_revision: sourceRevision, manifest_sha256: hash(JSON.stringify(files.map(({ data: _data, ...file }) => file))) };
  } finally { await unlock(); }
}
export function validateRuntimeBackup(envelope, key) {
  ensure(envelope?.schema === 'agentbl-encrypted-runtime-backup-v1', 'Unsupported backup envelope');
  const manifest = unseal(key, envelope, AAD);
  ensure(manifest?.schema === AAD && manifest.consistency === 'stopped-single-writer' && Array.isArray(manifest.files)
    && manifest.files.length <= 100_000, 'Unsupported backup manifest');
  const seen = new Set(), caseFolded = new Set(); let total = 0;
  for (const file of manifest.files) {
    relativePath(file.path);
    ensure(!skip(file.path.split('/')[0]) && !seen.has(file.path) && !caseFolded.has(file.path.toLowerCase()), 'Duplicate or reserved backup path');
    const data = Buffer.from(file.data, 'base64'); total += data.length;
    ensure(total <= limit && Number.isSafeInteger(file.size) && data.length === file.size && hash(data) === file.sha256, 'Backup file integrity failed');
    seen.add(file.path); caseFolded.add(file.path.toLowerCase());
  }
  // A file cannot also be the parent of another file, on either Windows or Linux.
  for (const name of caseFolded) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { ensure(!caseFolded.has(parts.join('/')), 'Conflicting backup paths'); parts.pop(); }
  }
  ensure(total === manifest.total_bytes, 'Backup total differs from manifest');
  return manifest;
}
export async function restoreRuntimeBackup({ input, directory, key }) {
  const destination = path.resolve(directory), parent = path.dirname(destination);
  ensure(destination !== parent, 'Cannot restore to a filesystem root');
  try { await fs.lstat(destination); throw new Error('Restore destination already exists; preserve it and choose a new directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const size = (await fs.stat(input)).size; ensure(size <= limit * 2, 'Backup envelope exceeds supported size');
  const manifest = validateRuntimeBackup(JSON.parse(await fs.readFile(input, 'utf8')), key);
  const staging = path.join(parent, `.agentbl-restore-${randomUUID()}`);
  await fs.mkdir(parent, { recursive: true });
  const restoreLock = runtimeRestoreLock(destination), reservation = await fs.open(restoreLock, 'wx', 0o600);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const target = path.resolve(staging, relativePath(file.path));
      ensure(target.startsWith(staging + path.sep), 'Restore path escaped staging directory');
      await fs.mkdir(path.dirname(target), { recursive: true });
      const handle = await fs.open(target, 'wx', 0o600);
      try { await handle.writeFile(Buffer.from(file.data, 'base64')); await handle.sync(); } finally { await handle.close(); }
    }
    await writeJsonAtomic(path.join(staging, 'restore-history', `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${randomUUID()}.json`), { schema: 'agentbl-runtime-restore-v1', restored_at: new Date().toISOString(),
      source_revision: manifest.source_revision, file_count: manifest.files.length, source_contacted: false,
      backup_sha256: hash(await fs.readFile(input)), configuration: manifest.configuration }, { durable: true });
    // Exclusive target reservation prevents an empty concurrently-created directory being replaced by rename.
    await fs.mkdir(destination);
    await writeJsonAtomic(path.join(destination, '.restore-incomplete.json'), { schema: 'agentbl-incomplete-restore-v1' }, { durable: true });
    for (const entry of await fs.readdir(staging)) await fs.rename(path.join(staging, entry), path.join(destination, entry));
    await fs.rm(path.join(destination, '.restore-incomplete.json'));
    await fs.rmdir(staging);
    return { file_count: manifest.files.length, total_bytes: manifest.total_bytes, source_revision: manifest.source_revision, configuration: manifest.configuration };
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
  finally { await reservation.close(); await fs.rm(restoreLock, { force: true }); }
}
