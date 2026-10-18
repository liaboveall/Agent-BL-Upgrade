import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readJson, writeJsonAtomic } from '../lib/jsonStore.js';

export const runtimeRestoreLock = (directory) => path.join(path.dirname(path.resolve(directory)), `.agentbl-restoring-${path.basename(path.resolve(directory))}.lock`);

/** Lifetime lease shared by the application and stopped-service backups. Never steals a remote lease. */
export async function acquireRuntimeLease(directory, purpose = 'application') {
  const root = path.resolve(directory), token = randomUUID(), lock = path.join(root, '.runtime-lease');
  if (await fs.lstat(runtimeRestoreLock(root)).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('A runtime restore is in progress or requires reconciliation');
  if (await readJson(path.join(root, '.restore-incomplete.json'))) throw new Error('Interrupted restore; preserve this directory and restore again to a new target');
  const candidate = path.join(root, `.runtime-lease-${token}`);
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(candidate);
  await writeJsonAtomic(path.join(candidate, 'owner.json'), { pid: process.pid, host: os.hostname(), token, purpose }, { durable: true });
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { await fs.rename(candidate, lock); acquired = true; break; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        const owner = await readJson(path.join(lock, 'owner.json'));
        let dead = false;
        if (owner?.host === os.hostname() && Number.isInteger(owner.pid)) {
          try { process.kill(owner.pid, 0); } catch (failure) { dead = failure.code === 'ESRCH'; }
        }
        if (!dead || !/^[a-f0-9-]{36}$/u.test(owner?.token ?? '')) throw Object.assign(new Error('Runtime is in use; stop its single writer before opening or backing it up'), { code: 'runtime_in_use' });
        // Nonempty tombstones stop two reclaimers replacing a successor's lease.
        try { await fs.rename(lock, path.join(root, `.abandoned-runtime-${owner.token}`)); }
        catch (failure) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(failure.code)) throw failure; }
      }
    }
    if (!acquired) throw new Error('Runtime lease contention; reconcile before retrying');
  } catch (error) { await fs.rm(candidate, { recursive: true, force: true }); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(lock, candidate); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 6) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
    released = true; await fs.rm(candidate, { recursive: true, force: true });
  };
}
