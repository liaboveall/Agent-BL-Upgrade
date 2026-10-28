// What one stopped-service backup can hold (src/ops/backup.js reads the whole runtime directory into one sealed
// envelope), and how close the runtime directory is to it. The intake quota is bounded by the same number so the
// store never accepts more than a backup can carry.
import fs from 'node:fs/promises';
import path from 'node:path';

export const RUNTIME_BACKUP_LIMIT_BYTES = 256 * 1024 * 1024;
// Uploads may use at most this share of a backup; ledgers, decisions, logs and the vault need the rest.
export const INTAKE_BACKUP_SHARE = 0.5;

/** Bytes the next backup would read: every regular file of the runtime directory except the lease markers. */
export async function runtimeBytes(directory, { skip = /^\.(?:runtime-lease|abandoned-runtime-|restore-incomplete)/u } = {}) {
  let total = 0;
  const walk = async (folder, top) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (top && skip.test(entry.name)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file, false);
      else if (entry.isFile()) total += (await fs.stat(file).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(directory, true);
  return total;
}
