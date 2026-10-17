import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { appendJsonl, writeJsonAtomic, writeFileAtomic, readJson, createWriteQueue } from '../lib/jsonStore.js';

const queues = new Map();

export class LedgerWriter {
  constructor(baseDir) {
    this.baseDir = path.resolve(baseDir);
    if (!queues.has(this.baseDir)) queues.set(this.baseDir, createWriteQueue());
    this.queue = queues.get(this.baseDir);
  }

  #file(name) { return path.join(this.baseDir, name); }

  /** Serialize a complete read/append/project transaction across instances and processes. */
  exclusive(task) {
    return this.queue(async () => {
      await fs.mkdir(this.baseDir, { recursive: true });
      const token = crypto.randomUUID();
      const candidate = this.#file(`writer-${process.pid}-${token}`);
      const lock = this.#file('writer.lock');
      await fs.mkdir(candidate);
      await writeJsonAtomic(path.join(candidate, 'owner.json'), { pid: process.pid, host: os.hostname(), token }, { durable: true });
      const expires = Date.now() + 10_000;
      let acquired = false;
      try {
        while (!acquired) {
          try { await fs.rename(candidate, lock); acquired = true; }
          catch (error) {
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
            const owner = await readJson(path.join(lock, 'owner.json'), null);
            let alive = true;
            if (owner?.host === os.hostname() && Number.isInteger(owner.pid)) {
              try { process.kill(owner.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
            }
            if (!alive && /^[a-f0-9-]{36}$/u.test(owner?.token ?? '')) {
              // Nonempty tombstones prevent two reclaimers from replacing a newly acquired lock.
              try { await fs.rename(lock, this.#file(`dead-writer-${owner.token}`)); }
              catch (failure) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(failure.code)) throw failure; }
            }
            if (Date.now() >= expires) throw Object.assign(new Error('Ledger writer is busy'), { code: 'ledger_busy' });
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        await this.#records('intents.jsonl', true);
        await this.#records('cash-entries.jsonl', true);
        return await task();
      } finally {
        if (acquired) await fs.rm(lock, { recursive: true, force: true });
        else await fs.rm(candidate, { recursive: true, force: true });
      }
    });
  }

  async #records(name, repair = false) {
    let raw;
    try { raw = await fs.readFile(this.#file(name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const lines = raw.split('\n');
    const records = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      try { records.push(JSON.parse(lines[index])); }
      catch (error) {
        if (index !== lines.length - 1 || raw.endsWith('\n')) throw new Error(`Corrupt ledger history: ${name}:${index + 1}`, { cause: error });
        if (repair) {
          const prefix = raw.slice(0, raw.lastIndexOf('\n') + 1);
          const tail = raw.slice(prefix.length);
          const hash = crypto.createHash('sha256').update(tail).digest('hex');
          await writeFileAtomic(this.#file(`${name}.torn-${hash}`), tail, { durable: true });
          await writeFileAtomic(this.#file(name), prefix, { durable: true });
        }
      }
    }
    if (repair && raw && !raw.endsWith('\n') && records.length === lines.filter((line) => line.trim()).length) {
      await writeFileAtomic(this.#file(name), `${raw}\n`, { durable: true });
    }
    return records;
  }

  appendIntent(intent) { return appendJsonl(this.#file('intents.jsonl'), intent, { maxBytes: Infinity, durable: true }); }
  appendCashEntry(entry) { return appendJsonl(this.#file('cash-entries.jsonl'), entry, { maxBytes: Infinity, durable: true }); }
  writePositions(positions) { return writeJsonAtomic(this.#file('positions.json'), positions, { durable: true }); }
  writeCursor(cursor) { return writeJsonAtomic(this.#file('cursor.json'), cursor, { durable: true }); }
  async readIntents(filter) { const rows = await this.#records('intents.jsonl'); return filter ? rows.filter(filter) : rows; }
  async readCashEntries(filter) { const rows = await this.#records('cash-entries.jsonl'); return filter ? rows.filter(filter) : rows; }
  readPositions() { return readJson(this.#file('positions.json'), {}); }
  readCursor() { return readJson(this.#file('cursor.json'), {}); }
}
