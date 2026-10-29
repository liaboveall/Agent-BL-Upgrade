import { readPrivateJson, writePrivateJson } from '../src/agent/security/privateStore.js';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventBus, EVENT_STATUS } from '../src/agent/runtime/eventBus.js';
import { EVENT_TYPES, EventValidationError, normalizeEvent } from '../src/agent/runtime/events.js';

const NOW = new Date('2026-10-12T12:00:00Z');
const norm = (raw) => normalizeEvent({ source: 'admin', ...raw }, { now: () => NOW });
const risk = (extra = {}) => norm({ type: 'WORLD_RISK_UPDATED', case_id: 'C1', data: { events: [{ severity: 'high' }] }, ...extra });

async function tempFiles() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-bus-'));
  return { dir, eventsFile: path.join(dir, 'events.jsonl'), indexFile: path.join(dir, 'index.json') };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const instant = async () => {};

// ---- events.js ----

test('events: normalizeEvent fills defaults and derives a stable event_id', () => {
  const a = risk({ occurred_at: '2026-10-12T10:00:00Z' });
  const b = risk({ occurred_at: '2026-10-12T10:00:00Z' });
  assert.equal(a.event_id, b.event_id, 'the same occurrence maps to the same id');
  assert.match(a.event_id, /^evt_[0-9a-f]{20}$/u);
  assert.equal(a.idempotency_key, `event:${a.event_id}`);
  assert.equal(a.source_mode, 'demo');
  assert.equal(a.observed_at, NOW.toISOString());
  assert.notEqual(risk({ occurred_at: '2026-10-12T11:00:00Z' }).event_id, a.event_id, 'a different occurrence is a different event');
  assert.equal(risk({ event_id: 'mine' }).event_id, 'mine', 'a caller-supplied id wins');
  assert.equal(normalizeEvent({ source: 'admin', type: 'RISK_CLEARED', case_id: 'C1' }, { now: () => NOW, defaultMode: 'live' }).source_mode, 'live');
});

test('events: invalid events are refused with a readable reason', () => {
  const bad = (raw, pattern) => assert.throws(() => norm(raw), (error) => {
    assert.ok(error instanceof EventValidationError);
    assert.match(error.message, pattern);
    return true;
  });
  bad({ type: 'NOPE', case_id: 'C1' }, /type/u);
  bad({ type: 'RISK_CLEARED' }, /case_id/u);
  bad({ type: 'RISK_CLEARED', case_id: 'C1', source: 'somewhere' }, /source/u);
  bad({ type: 'RISK_CLEARED', case_id: 'C1', occurred_at: 'yesterday-ish' }, /ISO date-time/u);
  bad({ type: 'RISK_CLEARED', case_id: 'C1', evidence_hash: '0x12' }, /evidence_hash/u);
  bad({ type: 'PAYMENT_RECEIVED', case_id: 'C1', data: { repayment_amount: 10 } }, /payment_proof/u);
  bad({ type: 'PAYMENT_RECEIVED', case_id: 'C1', data: { payment_proof: 'x', repayment_amount: -5 } }, /repayment_amount/u);
  bad({ type: 'EMERGENCY_STOP_CHANGED', case_id: 'C1', data: {} }, /stopped/u);
  assert.throws(() => normalizeEvent(null), EventValidationError);
  assert.throws(() => normalizeEvent([]), EventValidationError);
  assert.equal(EVENT_TYPES.length, 15);
  assert.ok(EVENT_TYPES.includes('SETTLEMENT_READY'), 'the agent proposes settlement as its own event');
});

test('events: payload keys beyond the checked ones are preserved but never trusted blindly', () => {
  const event = norm({ type: 'CARGO_ARRIVED', case_id: 'C1', data: { arrival_proof: 'bol-123', extra: { nested: true } } });
  assert.equal(event.data.arrival_proof, 'bol-123');
  assert.deepEqual(event.data.extra, { nested: true });
  assert.throws(() => norm({ type: 'CARGO_ARRIVED', case_id: 'C1', data: { arrival_proof: 12 } }), /arrival_proof/u);
});

// ---- eventBus.js ----

test('bus: an event is processed once; resubmitting it is a duplicate', async () => {
  const seen = [];
  const bus = new EventBus({ handler: async (event) => { seen.push(event.event_id); return { ok: true }; } });
  bus.start();
  const event = risk({ event_id: 'e1' });
  const first = await bus.submit(event);
  assert.deepEqual([first.accepted, first.duplicate, first.status], [true, false, 'RECEIVED']);
  await bus.idle();
  const again = await bus.submit(risk({ event_id: 'e1' }));
  assert.deepEqual([again.accepted, again.duplicate, again.status], [false, true, 'DONE']);
  await bus.idle();
  assert.deepEqual(seen, ['e1']);
  assert.equal(bus.get('event:e1').status, EVENT_STATUS.DONE);
  assert.deepEqual(bus.get('event:e1').result, { ok: true });
  assert.equal('event' in bus.get('event:e1'), false, 'the payload is dropped once it is no longer needed');
});

test('bus: events of one case run one at a time in arrival order, other cases run in parallel', async () => {
  const log = [];
  const active = { n: 0, max: 0 };
  const bus = new EventBus({
    concurrency: 4,
    handler: async (event) => {
      active.n += 1; active.max = Math.max(active.max, active.n);
      log.push(`start:${event.event_id}`);
      await sleep(event.data.delay ?? 10);
      log.push(`end:${event.event_id}`);
      active.n -= 1;
    }
  });
  bus.start();
  await bus.submit(norm({ type: 'RISK_CLEARED', case_id: 'A', event_id: 'a1', occurred_at: '2026-10-12T10:00:00Z', data: { delay: 40 } }));
  await bus.submit(norm({ type: 'WORLD_RISK_UPDATED', case_id: 'A', event_id: 'a2', occurred_at: '2026-10-12T10:01:00Z', data: { delay: 5 } }));
  await bus.submit(norm({ type: 'RISK_CLEARED', case_id: 'B', event_id: 'b1', occurred_at: '2026-10-12T10:00:00Z', data: { delay: 20 } }));
  await bus.idle();
  assert.ok(log.indexOf('end:a1') < log.indexOf('start:a2'), 'a2 must wait for a1');
  assert.ok(log.indexOf('start:b1') < log.indexOf('end:a1'), 'another case is not blocked by A');
});

test('bus: concurrency is capped', async () => {
  const active = { n: 0, max: 0 };
  const bus = new EventBus({
    concurrency: 3,
    handler: async () => { active.n += 1; active.max = Math.max(active.max, active.n); await sleep(15); active.n -= 1; }
  });
  bus.start();
  for (let i = 0; i < 8; i += 1) await bus.submit(norm({ type: 'RISK_CLEARED', case_id: `C${i}`, event_id: `e${i}` }));
  await bus.idle();
  assert.equal(active.max, 3);
  assert.equal(bus.status().counts.DONE, 8);
});

test('bus: an event older than the last handled one for the same case and type is STALE and never runs', async () => {
  const handled = [];
  const bus = new EventBus({ handler: async (event) => { handled.push(event.event_id); } });
  bus.start();
  await bus.submit(risk({ event_id: 'new', occurred_at: '2026-10-12T11:00:00Z' }));
  await bus.idle();
  await bus.submit(risk({ event_id: 'old', occurred_at: '2026-10-12T09:00:00Z' }));
  await bus.submit(norm({ type: 'CARGO_ARRIVED', case_id: 'C1', event_id: 'other-type', occurred_at: '2026-10-12T09:00:00Z' }));
  await bus.submit(risk({ event_id: 'other-case', case_id: 'C2', occurred_at: '2026-10-12T09:00:00Z' }));
  await bus.idle();
  assert.deepEqual(handled, ['new', 'other-type', 'other-case']);
  assert.equal(bus.get('event:old').status, EVENT_STATUS.STALE);
  assert.match(bus.get('event:old').note, /older than the last handled/u);
});

test('bus: a failing handler is retried, then the event is dead-lettered with its payload', async () => {
  let calls = 0;
  const settled = [];
  const bus = new EventBus({
    maxAttempts: 3, sleep: instant,
    handler: async () => { calls += 1; throw new Error('upstream down'); },
    onSettled: (entry) => settled.push(entry.status)
  });
  bus.start();
  await bus.submit(risk({ event_id: 'boom' }));
  await bus.idle();
  assert.equal(calls, 3);
  const entry = bus.get('event:boom');
  assert.equal(entry.status, EVENT_STATUS.DEAD);
  assert.match(entry.error.message, /upstream down/u);
  assert.equal(entry.attempts, 3);
  assert.ok(entry.event, 'the payload is kept so the event can be inspected or replayed');
  assert.deepEqual(settled, ['DEAD']);
  assert.equal(bus.status().dead, 1);
});

test('bus: a handler that recovers on a later attempt ends DONE; a dead event can be retried', async () => {
  let calls = 0;
  const bus = new EventBus({ maxAttempts: 3, sleep: instant, handler: async () => { calls += 1; if (calls < 3) throw new Error('flaky'); } });
  bus.start();
  await bus.submit(risk({ event_id: 'flaky' }));
  await bus.idle();
  assert.equal(bus.get('event:flaky').status, EVENT_STATUS.DONE);
  assert.equal(bus.get('event:flaky').attempts, 3);

  let healthy = false;
  const dead = new EventBus({ maxAttempts: 1, sleep: instant, handler: async () => { if (!healthy) throw new Error('down'); } });
  dead.start();
  await dead.submit(risk({ event_id: 'later' }));
  await dead.idle();
  assert.equal(dead.get('event:later').status, EVENT_STATUS.DEAD);
  healthy = true;
  assert.equal(await dead.retryDead('event:later'), true);
  await dead.idle();
  assert.equal(dead.get('event:later').status, EVENT_STATUS.DONE);
  assert.equal(await dead.retryDead('event:later'), false, 'only dead events can be retried');
  assert.equal(await dead.retryDead('event:missing'), false);
});

test('bus: state survives a restart; duplicates stay duplicates and STALE detection persists', async () => {
  const files = await tempFiles();
  const first = new EventBus({ ...files, handler: async () => ({ n: 1 }) });
  first.start();
  await first.submit(risk({ event_id: 'r1', occurred_at: '2026-10-12T11:00:00Z' }));
  await first.idle();
  await first.stop();

  const calls = [];
  const second = new EventBus({ ...files, handler: async (event) => { calls.push(event.event_id); } });
  await second.init();
  second.start();
  const again = await second.submit(risk({ event_id: 'r1', occurred_at: '2026-10-12T11:00:00Z' }));
  assert.equal(again.duplicate, true, 'a processed event is not run again after a restart');
  await second.submit(risk({ event_id: 'r0', occurred_at: '2026-10-12T08:00:00Z' }));
  await second.idle();
  assert.deepEqual(calls, []);
  assert.equal(second.get('event:r0').status, EVENT_STATUS.STALE);

  const audit = (await fs.readFile(files.eventsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(audit.map((line) => line.event.event_id), ['r1', 'r0'], 'every accepted event is in the audit log once');
});

test('bus: events that were queued or mid-flight when the process stopped are processed after restart', async () => {
  const files = await tempFiles();
  // Process 1 accepts an event but is never started (e.g. crashed right after the write).
  const crashed = new EventBus({ ...files, handler: async () => {} });
  await crashed.submit(risk({ event_id: 'queued', case_id: 'Q' }));
  // A second event was PROCESSING when the process died.
  const index = await readPrivateJson(files.indexFile);
  const inFlight = norm({ type: 'WORLD_RISK_UPDATED', case_id: 'P', event_id: 'inflight', data: { events: [] } });
  index.entries.push({
    idempotency_key: inFlight.idempotency_key, event_id: 'inflight', case_id: 'P', type: inFlight.type,
    occurred_at: inFlight.occurred_at, status: 'PROCESSING', attempts: 1,
    received_at: '2026-10-12T00:00:00.000Z', updated_at: '2026-10-12T00:00:01.000Z', event: inFlight
  });
  await writePrivateJson(files.indexFile, index);

  const seen = [];
  const revived = new EventBus({ ...files, handler: async (event) => { seen.push(event.event_id); } });
  await revived.init();
  revived.start();
  await revived.idle();
  assert.deepEqual(seen.sort(), ['inflight', 'queued']);
  assert.equal(revived.status().counts.DONE, 2);
});

test('bus: a bus that is not started keeps events queued and reports them', async () => {
  const bus = new EventBus({ handler: async () => {} });
  await bus.submit(risk({ event_id: 'waiting' }));
  assert.equal(bus.status().queued, 1);
  assert.equal(bus.status().started, false);
  await bus.idle(); // does not hang
  assert.equal(bus.get('event:waiting').status, EVENT_STATUS.RECEIVED);
  bus.start();
  await bus.idle();
  assert.equal(bus.get('event:waiting').status, EVENT_STATUS.DONE);
});

test('bus: the index is pruned to its cap without losing unfinished or dead events', async () => {
  const bus = new EventBus({ maxIndexEntries: 5, maxAttempts: 1, sleep: instant, handler: async (event) => { if (event.event_id === 'bad') throw new Error('x'); } });
  bus.start();
  await bus.submit(risk({ event_id: 'bad', case_id: 'BAD' }));
  await bus.idle();
  for (let i = 0; i < 12; i += 1) await bus.submit(risk({ event_id: `ok${i}`, case_id: `C${i}`, occurred_at: `2026-10-12T10:${String(i).padStart(2, '0')}:00Z` }));
  await bus.idle();
  assert.ok(bus.entries.size <= 5);
  assert.equal(bus.get('event:bad').status, EVENT_STATUS.DEAD, 'a dead event is never pruned');
});

test('bus: the handler receives a copy, so it cannot corrupt the stored event', async () => {
  const bus = new EventBus({ handler: async (event) => { event.data.events.length = 0; } });
  bus.start();
  await bus.submit(risk({ event_id: 'copy' }));
  await bus.idle();
  assert.equal(bus.get('event:copy').status, EVENT_STATUS.DONE);
});

test('bus: submit refuses an event that was not normalised', async () => {
  const bus = new EventBus({ handler: async () => {} });
  await assert.rejects(bus.submit({ type: 'RISK_CLEARED', case_id: 'C1' }), /idempotency_key/u);
  assert.throws(() => new EventBus({}), /handler/u);
});

// F02 (comprehensive review 2026-10-29, v4): an acceptance commits through its own index write. An event whose audit line
// or index write failed is in no index on disk, so a restart never runs what its submitter was told was refused, even
// when another event's acceptance was being written at the same time.
async function occupiedBus(t) {
  const files = await tempFiles();
  t.after(() => fs.rm(files.dir, { recursive: true, force: true }));
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; }), running = new Promise((resolve) => { started = resolve; });
  const bus = new EventBus({ ...files, concurrency: 1, handler: async (event) => { if (event.case_id === 'WARMUP') { started(); await gate; } } });
  await bus.init(); bus.start();
  await bus.submit(risk({ event_id: 'warmup', case_id: 'WARMUP' }));
  await running; // the only worker is held, so nothing but the acceptances below writes the index
  t.after(async () => { bus.started = false; release(); await bus.stop(); });
  return { files, bus };
}
async function restartRuns(files) {
  const ran = [];
  const restarted = new EventBus({ ...files, handler: async (event) => { ran.push(event.event_id); } });
  await restarted.init(); restarted.start(); await restarted.idle(); await restarted.stop();
  return ran;
}

test('F02 an event whose audit line failed is never indexed by a concurrent acceptance, and never runs after a restart', async (t) => {
  const { files, bus } = await occupiedBus(t);
  const open = fs.open;
  let appends = 0;
  fs.open = async (file, flags, ...rest) => {
    if (file === files.eventsFile && flags === 'a' && ++appends === 2) throw Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC' });
    return open(file, flags, ...rest);
  };
  let results;
  try { results = await Promise.allSettled([bus.submit(risk({ event_id: 'a', case_id: 'A' })), bus.submit(risk({ event_id: 'b', case_id: 'B' }))]); }
  finally { fs.open = open; }
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
  // The disk as a crash right now would leave it: the committed index, before any later write.
  const onDisk = (await readPrivateJson(files.indexFile)).entries.map((entry) => entry.event_id);
  assert.deepEqual(onDisk.sort(), ['a', 'warmup']);
  const audited = (await fs.readFile(files.eventsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).event.event_id);
  for (const id of onDisk) assert.ok(audited.includes(id), `${id} has its audit line`);
  const ran = await restartRuns(files);
  assert.ok(ran.includes('a')); assert.equal(ran.includes('b'), false, 'the refused event does not run');
});

test('F02 an event whose own index write failed is refused, is not in the index, and its retry is accepted once', async (t) => {
  const { files, bus } = await occupiedBus(t);
  const rename = fs.rename, writes = [];
  // Acceptances write in queue order: A's index write, then B's. B's write fails on every retry.
  fs.rename = async (from, to, ...rest) => {
    if (to === files.indexFile) { if (!writes.includes(from)) writes.push(from); if (writes.indexOf(from) === 1) throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }); }
    return rename(from, to, ...rest);
  };
  let results;
  try { results = await Promise.allSettled([bus.submit(risk({ event_id: 'a', case_id: 'A' })), bus.submit(risk({ event_id: 'b', case_id: 'B' }))]); }
  finally { fs.rename = rename; }
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
  assert.equal(bus.get('event:b'), null);
  assert.deepEqual((await readPrivateJson(files.indexFile)).entries.map((entry) => entry.event_id).sort(), ['a', 'warmup']);
  assert.equal((await restartRuns(files)).includes('b'), false);
  const retried = await bus.submit(risk({ event_id: 'b', case_id: 'B' }));
  assert.deepEqual([retried.accepted, retried.duplicate], [true, false]);
  assert.ok((await readPrivateJson(files.indexFile)).entries.some((entry) => entry.event_id === 'b'));
});
