import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Exclusive writer for the append-only sequence. An abandoned same-host lock can be recovered
// only after its process is confirmed dead; recovery itself is exclusive.
export async function lockAnchorStore(file) {
  if (!file) return async () => {};
  await fs.mkdir(path.dirname(file), { recursive: true });
  const name = `${file}.lock`;
  const token = randomUUID();
  const acquire = async () => {
    const handle = await fs.open(name, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), token })); }
    catch (error) { await fs.rm(name, { force: true }); throw error; }
    finally { await handle.close(); }
  };
  try { await acquire(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recovery = await fs.open(`${name}.recovery`, 'wx', 0o600).catch(() => { throw new Error('Anchor journal is locked by another process'); });
    try {
      const owner = JSON.parse(await fs.readFile(name, 'utf8'));
      if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Anchor journal lock requires operator reconciliation', { cause: error });
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      if (!dead) throw new Error('Anchor journal is locked by another process', { cause: error });
      await fs.rm(name);
      await acquire();
    } finally { await recovery.close(); await fs.rm(`${name}.recovery`, { force: true }); }
  }
  return async () => {
    try {
      const current = JSON.parse(await fs.readFile(name, 'utf8'));
      if (current.token !== token) throw new Error('Anchor journal lock ownership changed; it was not removed');
      await fs.rm(name);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
