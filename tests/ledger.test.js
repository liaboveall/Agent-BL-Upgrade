import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Ledger } from '../src/ledger/ledger.js';

const pi = { chain_id: 1439, pool_address: `0x${'1'.repeat(40)}`, protocol_version: 5 };
const investor = `0x${'2'.repeat(40)}`, asset = `0x${'3'.repeat(40)}`;
const event = (overrides = {}) => ({ protocol_instance: pi, chain_pool_id: 1, kind: 'INVESTOR_DEPOSIT', asset,
  from: investor, to: pi.pool_address, amount_atomic: '80', shares: '100', source: { tx_hash: `0x${'a'.repeat(64)}`, log_index: 0 }, ...overrides });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { ledger: new Ledger({ baseDir: dir }), dir };
}
function child(code, args = []) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = ''; proc.stderr.on('data', (chunk) => { output += chunk; });
    proc.on('error', reject); proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(output || `Child exited ${code}`)));
  });
}

describe('W2 durable capital ledger', () => {
  it('retains intent terms and refuses a second transaction hash on restart', async (t) => {
    const { ledger, dir } = await fixture(t);
    const intent = await ledger.recordIntent({ protocol_instance: pi, chain_pool_id: 1, operation: 'SUBSCRIBE', investor, asset, amount_atomic: 80n, shares: 100n });
    const tx = `0x${'b'.repeat(64)}`;
    await ledger.markBroadcast(intent.intent_id, tx);
    const restored = new Ledger({ baseDir: dir });
    await restored.confirmIntent(intent.intent_id, tx, 123);
    assert.equal((await restored.getIntent(intent.intent_id)).shares, '100');
    assert.equal((await restored.getIntent(intent.intent_id)).status, 'confirmed');
    await assert.rejects(restored.markBroadcast(intent.intent_id, `0x${'c'.repeat(64)}`), /another transaction/u);
  });

  it('records deposits, zero/partial claims and refunds without mixing wallets or protocol instances', async (t) => {
    const { ledger } = await fixture(t);
    await ledger.applyEvent(event());
    await ledger.applyEvent(event({ protocol_instance: { ...pi, chain_id: 1 } }));
    await ledger.applyEvent(event({ chain_pool_id: 2, from: asset, source: { tx_hash: `0x${'a'.repeat(64)}`, log_index: 1 } }));
    await ledger.applyEvent(event({ kind: 'CLAIM', from: pi.pool_address, to: investor, amount_atomic: '95', source: { tx_hash: `0x${'b'.repeat(64)}`, log_index: 0 } }));
    const positions = await ledger.listPositions();
    assert.equal(positions.length, 3);
    assert.equal(positions.find((pos) => pos.investor === investor && pos.protocol_instance.chain_id === 1439).claimed_atomic, '95');
    await ledger.applyEvent(event({ kind: 'REFUND', chain_pool_id: 2, to: asset, amount_atomic: '80', shares: undefined, source: { tx_hash: `0x${'c'.repeat(64)}`, log_index: 0 } }));
    const refund = (await ledger.listPositions()).find((pos) => pos.chain_pool_id === 2);
    assert.equal(refund.cost_atomic, '80', 'historical cost is never erased by a refund');
    assert.equal(refund.refunded_atomic, '80'); assert.equal(refund.shares, '0'); assert.equal(refund.status, 'refunded');
  });

  it('deduplicates concurrent same-process writers and rejects conflicting evidence', async (t) => {
    const { ledger, dir } = await fixture(t);
    const second = new Ledger({ baseDir: dir });
    await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? ledger : second).applyEvent(event())));
    assert.equal((await ledger.writer.readCashEntries()).length, 1);
    assert.equal((await ledger.listPositions())[0].shares, '100');
    await assert.rejects(second.applyEvent(event({ shares: '101' })), /Conflicting/u);
  });

  it('recovers a committed cash entry after a crash before writing its position snapshot', async (t) => {
    const { ledger, dir } = await fixture(t);
    ledger.writer.writePositions = async () => { throw new Error('simulated power loss'); };
    await assert.rejects(ledger.applyEvent(event()), /power loss/u);
    const restored = new Ledger({ baseDir: dir });
    assert.equal((await restored.listPositions())[0].shares, '100');
    await restored.applyEvent(event());
    assert.equal((await restored.writer.readCashEntries()).length, 1);
  });

  it('keeps orphaned chain facts in the audit history while rebuilding canonical positions', async (t) => {
    const { ledger } = await fixture(t);
    const { entry } = await ledger.applyEvent(event());
    await ledger.applyEvents([], { voidedEntryIds: [entry.entry_id] });
    assert.deepEqual(await ledger.listPositions(), []);
    assert.equal((await ledger.writer.readCashEntries()).length, 2);
    await ledger.applyEvent(event());
    assert.equal((await ledger.listPositions())[0].shares, '100');
    assert.equal((await ledger.writer.readCashEntries()).length, 3);
  });

  it('preserves a torn tail for audit, recovers the committed prefix, and rejects interior corruption', async (t) => {
    const { ledger, dir } = await fixture(t);
    await ledger.applyEvent(event());
    await fs.appendFile(path.join(dir, 'cash-entries.jsonl'), '{"entry_id":"torn');
    const restored = new Ledger({ baseDir: dir });
    assert.equal((await restored.listPositions())[0].shares, '100');
    assert.equal((await fs.readdir(dir)).filter((file) => file.includes('.torn-')).length, 1);
    await fs.appendFile(path.join(dir, 'cash-entries.jsonl'), '{broken}\n');
    await assert.rejects(restored.listPositions(), /Corrupt ledger history/u);
  });

  it('serializes independent processes and recovers a dead writer lease without double counting', async (t) => {
    const { ledger, dir } = await fixture(t);
    const module = pathToFileURL(path.resolve('src/ledger/ledger.js')).href;
    const code = `import { Ledger } from ${JSON.stringify(module)}; const ledger = new Ledger({ baseDir: process.argv[1] }); await ledger.applyEvent(JSON.parse(process.argv[2]));`;
    await Promise.all(Array.from({ length: 4 }, () => child(code, [dir, JSON.stringify(event())])));
    assert.equal((await ledger.writer.readCashEntries()).length, 1);
    const writerModule = pathToFileURL(path.resolve('src/ledger/writer.js')).href;
    await child(`import { LedgerWriter } from ${JSON.stringify(writerModule)}; await new LedgerWriter(process.argv[1]).exclusive(() => { process.exit(0); });`, [dir]);
    await ledger.applyEvent(event());
    assert.equal((await ledger.listPositions())[0].shares, '100');
    assert.equal((await fs.readdir(dir)).filter((file) => file.startsWith('dead-writer-')).length, 1);
  });

  it('preserves a successor lease while the previous writer cleans up its released directory', { timeout: 10_000 }, async (t) => {
    const { ledger, dir } = await fixture(t);
    const remove = fs.rm.bind(fs);
    let ready, resume, paused = false;
    const cleaning = new Promise((resolve) => { ready = resolve; });
    const proceed = new Promise((resolve) => { resume = resolve; });
    t.mock.method(fs, 'rm', async (file, options) => {
      if (!paused && path.dirname(file) === dir && path.basename(file).startsWith('writer')) {
        paused = true;
        // Stop recursive deletion after it empties the old directory, when POSIX rename
        // would allow another process to replace it with a newly acquired nonempty lease.
        await fs.unlink(path.join(file, 'owner.json'));
        ready(); await proceed;
      }
      return remove(file, options);
    });
    const first = ledger.applyEvent(event());
    await Promise.race([cleaning, first.then(() => { throw new Error('Expected directory cleanup'); })]);
    const module = pathToFileURL(path.resolve('src/ledger/ledger.js')).href;
    const code = `import { Ledger } from ${JSON.stringify(module)};
      const ledger = new Ledger({ baseDir: process.argv[1] });
      const write = ledger.writer.writePositions.bind(ledger.writer);
      ledger.writer.writePositions = async (positions) => {
        await write(positions); process.send('holding');
        await new Promise((resolve) => process.once('message', resolve));
      };
      await ledger.applyEvent(JSON.parse(process.argv[2])); process.disconnect();`;
    const next = event({ source: { tx_hash: `0x${'b'.repeat(64)}`, log_index: 0 } });
    const proc = spawn(process.execPath, ['--input-type=module', '-e', code, dir, JSON.stringify(next)],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    proc.stderr.on('data', (chunk) => { output += chunk; });
    const holding = new Promise((resolve) => proc.once('message', resolve));
    const finished = new Promise((resolve, reject) => {
      proc.once('error', reject);
      proc.once('exit', (code) => code === 0 ? resolve() : reject(new Error(output || `Child exited ${code}`)));
    });
    try {
      await Promise.race([holding, finished.then(() => { throw new Error('Writer exited before holding the lease'); })]);
      resume(); await first;
      const owner = JSON.parse(await fs.readFile(path.join(dir, 'writer.lock', 'owner.json'), 'utf8'));
      assert.equal(owner.pid, proc.pid, 'previous cleanup must preserve the active successor lease');
    } finally {
      resume();
      if (proc.connected) proc.send('release');
      await finished;
    }
    assert.equal((await ledger.writer.readCashEntries()).length, 2);
    assert.equal((await ledger.listPositions())[0].shares, '200');
  });

  it('retries transient Windows lease retirement errors while preserving the shared lock and committed entry', async (t) => {
    const { ledger, dir } = await fixture(t), rename = fs.rename;
    let attempts = 0;
    fs.rename = async (from, to) => {
      if (from === path.join(dir, 'writer.lock')) {
        attempts++;
        assert.ok(await fs.stat(path.join(from, 'owner.json')));
        if (attempts <= 2) throw Object.assign(new Error('transient sharing violation'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
      }
      return rename(from, to);
    };
    try { await ledger.applyEvent(event()); }
    finally { fs.rename = rename; }
    assert.equal(attempts, 3);
    await assert.rejects(fs.access(path.join(dir, 'writer.lock')), { code: 'ENOENT' });
    await ledger.applyEvent(event());
    assert.equal((await ledger.writer.readCashEntries()).length, 1);
  });

  it('records disbursement, recovery and fee without creating fictitious investor positions', async (t) => {
    const { ledger } = await fixture(t);
    for (const [index, kind] of ['DISBURSEMENT', 'RECOVERY', 'FEE'].entries()) {
      await ledger.applyEvent(event({ kind, source: { tx_hash: `0x${'d'.repeat(64)}`, log_index: index } }));
    }
    assert.deepEqual(await ledger.listPositions(), []);
  });
});
