import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendJsonl,
  cleanupOrphanTemps,
  createWriteQueue,
  readJson,
  readJsonl,
  writeJsonAtomic
} from '../src/lib/jsonStore.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-jsonstore-'));
}

test('writeJsonAtomic writes pretty JSON and readJson returns it (WP0.3)', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'nested', 'state.json');
  await writeJsonAtomic(file, { a: 1, b: [2, 3] });
  assert.deepEqual(await readJson(file), { a: 1, b: [2, 3] });
  assert.match(await fs.readFile(file, 'utf8'), /\n$/u);
  assert.deepEqual((await fs.readdir(path.dirname(file))), ['state.json']);
});

test('readJson returns the fallback for a missing file but throws on corrupt JSON', async () => {
  const dir = await tempDir();
  assert.deepEqual(await readJson(path.join(dir, 'missing.json'), { empty: true }), { empty: true });
  const bad = path.join(dir, 'bad.json');
  await fs.writeFile(bad, '{ not json');
  await assert.rejects(readJson(bad), SyntaxError);
});

test('writeJsonAtomic retries a transient EPERM rename and then succeeds', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'state.json');
  let calls = 0;
  const rename = async (from, to) => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return fs.rename(from, to);
  };
  await writeJsonAtomic(file, { ok: true }, { rename, backoffMs: 1 });
  assert.equal(calls, 3);
  assert.deepEqual(await readJson(file), { ok: true });
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

test('writeJsonAtomic removes its temp file when the rename keeps failing', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'state.json');
  const rename = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  await assert.rejects(writeJsonAtomic(file, { ok: true }, { rename, retries: 2, backoffMs: 1 }), { code: 'EBUSY' });
  assert.deepEqual(await fs.readdir(dir), []);
});

test('writeJsonAtomic does not retry non-transient errors', async () => {
  const dir = await tempDir();
  let calls = 0;
  const rename = async () => { calls += 1; throw Object.assign(new Error('nope'), { code: 'ENOSPC' }); };
  await assert.rejects(writeJsonAtomic(path.join(dir, 's.json'), {}, { rename, backoffMs: 1 }), { code: 'ENOSPC' });
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('createWriteQueue runs tasks in order and survives a failed task', async () => {
  const enqueue = createWriteQueue();
  const order = [];
  const first = enqueue(async () => { await new Promise((r) => setTimeout(r, 15)); order.push(1); });
  const failing = enqueue(async () => { order.push(2); throw new Error('boom'); });
  const third = enqueue(async () => { order.push(3); return 'ok'; });
  await first;
  await assert.rejects(failing, /boom/u);
  assert.equal(await third, 'ok');
  assert.deepEqual(order, [1, 2, 3]);
});

test('appendJsonl appends records and readJsonl returns them oldest-first with tail and filter', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'log.jsonl');
  for (let i = 1; i <= 5; i += 1) await appendJsonl(file, { i, even: i % 2 === 0 });
  assert.deepEqual((await readJsonl(file)).map((r) => r.i), [1, 2, 3, 4, 5]);
  assert.deepEqual((await readJsonl(file, { tail: 2 })).map((r) => r.i), [4, 5]);
  assert.deepEqual((await readJsonl(file, { filter: (r) => r.even })).map((r) => r.i), [2, 4]);
  assert.deepEqual((await readJsonl(file, { filter: (r) => r.even, tail: 1 })).map((r) => r.i), [4]);
  assert.deepEqual(await readJsonl(path.join(dir, 'none.jsonl')), []);
});

test('appendJsonl rotates by size and keeps at most keepFiles generations', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'log.jsonl');
  const options = { maxBytes: 60, keepFiles: 2 };
  for (let i = 1; i <= 12; i += 1) await appendJsonl(file, { i, pad: 'xxxxxxxxxx' }, options);
  const names = (await fs.readdir(dir)).sort();
  assert.deepEqual(names, ['log.jsonl', 'log.jsonl.1', 'log.jsonl.2']);
  const current = await readJsonl(file);
  assert.ok(current.length >= 1);
  assert.equal(current.at(-1).i, 12);
  const all = await readJsonl(file, { includeRotated: true, keepFiles: 2 });
  const ids = all.map((r) => r.i);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'rotated generations are read oldest-first');
  assert.equal(ids.at(-1), 12);
  assert.ok(ids[0] > 1, 'generations beyond keepFiles are dropped');
});

test('readJsonl skips a torn final line left by a crash', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'log.jsonl');
  await fs.writeFile(file, '{"i":1}\n{"i":2}\n{"i":3', 'utf8');
  assert.deepEqual((await readJsonl(file)).map((r) => r.i), [1, 2]);
});

test('cleanupOrphanTemps removes only old *.tmp files', async () => {
  const dir = await tempDir();
  const old = path.join(dir, 'x402-reports.json.1.2.tmp');
  const fresh = path.join(dir, 'x402-reports.json.3.4.tmp');
  const keep = path.join(dir, 'x402-reports.json');
  await Promise.all([old, fresh, keep].map((f) => fs.writeFile(f, '{}')));
  const past = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(old, past, past);
  const removed = await cleanupOrphanTemps(dir, 10 * 60 * 1000);
  assert.deepEqual(removed, ['x402-reports.json.1.2.tmp']);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['x402-reports.json', 'x402-reports.json.3.4.tmp']);
  assert.deepEqual(await cleanupOrphanTemps(path.join(dir, 'does-not-exist')), []);
});
