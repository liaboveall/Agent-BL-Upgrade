// Operator-local, key-free broadcast checkpoints. An uncertain send is never retried automatically.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../src/lib/jsonStore.js';

export function createOwnerJournal(dir) {
  const root = path.join(dir, 'owner-cli');
  const name = (approvalId, index) => {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(approvalId) || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid owner journal identity');
    return path.join(root, `${approvalId}-${index}`);
  };
  return {
    read: (id, index) => readJson(`${name(id, index)}.json`, null),
    write: async (id, index, value) => {
      await fs.mkdir(root, { recursive: true });
      await writeJsonAtomic(`${name(id, index)}.json`, { approval_id: id, step_index: index, ...value, updated_at: new Date().toISOString() }, { durable: true });
    },
    async withLock(id, task) {
      await fs.mkdir(root, { recursive: true });
      const lockFile = `${name(id, 0)}.lock`;
      let lock;
      try { lock = await fs.open(lockFile, 'wx'); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('Another owner CLI holds this approval lock; reconcile any abandoned broadcast before removing the local lock', { cause: error });
        throw error;
      }
      try { return await task(); }
      finally { await lock.close(); await fs.rm(lockFile, { force: true }); }
    }
  };
}
