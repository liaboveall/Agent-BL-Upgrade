// Small file-backed JSON helpers shared by the runtime stores (x402 receipts, Mystery reveals,
// agent decisions, activity log, ...). Everything that persists state goes through here so the
// failure modes are handled once:
//   - writes are atomic (temp file in the same directory + rename), so a crash never leaves a
//     half-written file behind;
//   - rename is retried with backoff on EPERM / EBUSY / EACCES (Windows holds files open while
//     antivirus or an indexer scans them);
//   - a failed write removes its temp file instead of leaking `<name>.<pid>.<ts>.tmp` files;
//   - JSONL logs are appended to and rotated by size, and read back from the tail.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DEFAULT_RETRIES = 6;
const DEFAULT_BACKOFF_MS = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let tempCounter = 0;

function tempPathFor(target) {
  tempCounter += 1;
  return `${target}.${process.pid}.${Date.now()}.${tempCounter}.tmp`;
}

async function removeQuietly(file) {
  try {
    await fs.rm(file, { force: true });
  } catch {
    // Nothing more can be done; the next startup sweep (cleanupOrphanTemps) will retry.
  }
}

async function renameWithRetry(from, to, { retries, backoffMs, rename }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!RETRYABLE.has(error?.code) || attempt >= retries) throw error;
      await sleep(backoffMs * 2 ** attempt);
    }
  }
}

/**
 * Atomically replace `file` with `contents`. `contents` is written as-is when it is a string or
 * Buffer, otherwise serialised as pretty-printed JSON with a trailing newline.
 * `options.rename` is an injection point for tests.
 */
export async function writeFileAtomic(file, contents, options = {}) {
  const {
    retries = DEFAULT_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
    rename = fs.rename,
    durable = false
  } = options;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = tempPathFor(file);
  try {
    await fs.writeFile(temporary, contents, typeof contents === 'string' ? 'utf8' : undefined);
    if (durable) {
      const handle = await fs.open(temporary, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await renameWithRetry(temporary, file, { retries, backoffMs, rename });
    if (durable) await syncDirectory(path.dirname(file));
  } catch (error) {
    await removeQuietly(temporary);
    throw error;
  }
}

export async function writeJsonAtomic(file, value, options = {}) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

/** Read and parse a JSON file. A missing file yields `fallback`; corrupt JSON throws. */
export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

/**
 * Serialises async writes for one store. A failed write rejects its own caller but does not
 * poison the queue, so a transient EBUSY cannot disable persistence until restart.
 */
export function createWriteQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

function rotatedName(file, index) {
  return `${file}.${index}`;
}

/**
 * Append one record (a JSON line). When the file would grow past `maxBytes` it is rotated to
 * `<file>.1` (older generations shift up) and at most `keepFiles` rotated files are kept.
 */
export async function appendJsonl(file, record, { maxBytes = 5 * 1024 * 1024, keepFiles = 3, durable = false } = {}) {
  const line = `${JSON.stringify(record)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  let size = 0;
  try {
    size = (await fs.stat(file)).size;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
    await removeQuietly(rotatedName(file, keepFiles));
    for (let index = keepFiles - 1; index >= 1; index -= 1) {
      try {
        await fs.rename(rotatedName(file, index), rotatedName(file, index + 1));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (keepFiles >= 1) await fs.rename(file, rotatedName(file, 1));
    else await removeQuietly(file);
  }
  const handle = await fs.open(file, 'a');
  try {
    await handle.writeFile(line, 'utf8');
    if (durable) await handle.sync();
  } finally { await handle.close(); }
  if (durable) await syncDirectory(path.dirname(file));
}

async function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readJsonlFile(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn final line after a crash must not make the whole log unreadable.
    }
  }
  return records;
}

/**
 * Read JSONL records oldest-first. Rotated generations are included (oldest first) when
 * `includeRotated` is set. `filter` keeps matching records; `tail` keeps only the last N of those.
 */
export async function readJsonl(file, { tail, filter, includeRotated = false, keepFiles = 3 } = {}) {
  const files = [];
  if (includeRotated) {
    for (let index = keepFiles; index >= 1; index -= 1) files.push(rotatedName(file, index));
  }
  files.push(file);
  let records = [];
  for (const candidate of files) records = records.concat(await readJsonlFile(candidate));
  if (filter) records = records.filter(filter);
  if (Number.isInteger(tail) && tail >= 0) records = tail === 0 ? [] : records.slice(-tail);
  return records;
}

/**
 * Remove `*.tmp` files left behind by a crashed write. Only files older than `olderThanMs` are
 * touched, so a write that is in flight right now is never deleted. Returns the removed names.
 */
export async function cleanupOrphanTemps(dir, olderThanMs = 10 * 60 * 1000, now = Date.now()) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs < olderThanMs) continue;
      await fs.rm(full, { force: true });
      removed.push(entry.name);
    } catch {
      // Raced with another cleanup or a still-open handle; leave it for the next sweep.
    }
  }
  return removed;
}
