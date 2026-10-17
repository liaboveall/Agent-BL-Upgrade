import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Ledger } from '../../src/ledger/ledger.js';

export async function tmpLedger() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  return { ledger: new Ledger({ baseDir: dir }), dir };
}

export async function cleanupTmpLedger(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}
