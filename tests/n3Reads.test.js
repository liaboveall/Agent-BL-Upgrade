import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcReadPool, readPage } from '../src/rights/reads.js';
import { readOfferings } from '../src/rights/offerings.js';

test('N3 bounds shared RPC work, queue and timeouts even while the transport is stuck', async () => {
  const pool = new RpcReadPool({ concurrency: 2, queueLimit: 2, timeoutMs: 25 });
  const releases = [], jobs = Array.from({ length: 4 }, () => pool.run(() => new Promise((resolve) => releases.push(resolve))));
  await assert.rejects(pool.run(() => 1), { code: 'rpc_read_busy' });
  const outcomes = await Promise.allSettled(jobs);
  assert.equal(outcomes.filter((row) => row.status === 'rejected' && row.reason.code === 'rpc_read_timeout').length, 4);
  assert.equal(pool.active, 2); assert.equal(releases.length, 2, 'Timed out transports still occupy their slots');
  releases.forEach((resolve) => resolve()); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.active, 0); assert.equal(await pool.run(() => 42), 42);
});

test('N3 read retries are bounded and never expose a provider exception', async () => {
  const pool = new RpcReadPool({ retries: 1 }), { read, stats } = pool.budget(3); let calls = 0;
  assert.equal(await read(() => { if (++calls === 1) throw Object.assign(new Error('private rpc url and token'), { code: 'NETWORK_ERROR' }); return 7; }), 7);
  assert.equal(stats.retries, 1);
  await assert.rejects(read(() => { throw new Error('private material in a provider failure'); }), (error) => error.code === 'rpc_read_unavailable' && !error.message.includes('private'));
  await assert.rejects(read(() => 1), { code: 'rpc_read_budget_exceeded' });
  for (const query of ['from=0', 'limit=21', 'block_number=1', 'block_number=1&block_hash=x', 'from=9007199254740992']) assert.throws(() => readPage(new URLSearchParams(query)), { code: 'invalid_pagination' });
});

test('N3 stable 25-pool snapshots cover every page and distinguish failures, new pools and reorgs', async () => {
  let next = 26, failId = null, reorg = false, calls = 0, active = 0, peak = 0;
  const block = { number: 123, hash: `0x${'ab'.repeat(32)}`, timestamp: Math.floor(Date.now() / 1000) };
  const call = (fn) => async (...args) => { calls++; active++; peak = Math.max(peak, active); try { await new Promise((resolve) => setImmediate(resolve)); return fn(...args); } finally { active--; } };
  const chain = { provider: { getBlock: call(() => ({ ...block, ...(reorg ? { hash: `0x${'cd'.repeat(32)}` } : {}) })) }, verify: async () => ({}),
    controller: { termsHash: call(() => 'commitment'), terms: call(() => ({ disburseUntil: 5000, policyHash: 'policy', disclosureHash: 'disclosure' })) },
    pool: { nextPoolId: call(() => next), offerings: call((id, at) => {
      assert.equal(at.blockTag, block.number); if (id === failId) throw new Error('Unavailable');
      return { state: 2n, tokenSupply: 10n, subscribed: 0n, issuePrice: 800000n, targetRedemptionValue: 1000000n, settlementAsset: 'asset', raisedAtomic: 0n };
    }), quoteVersion: call(() => 1), subscriptionDeadline: call(() => block.timestamp + 1000), maturityAt: call(() => block.timestamp + 2000), disbursedAtomic: call(() => 0n), recoveredAtomic: call(() => 0n), escrowed: call(() => 0n) } };
  const pool = new RpcReadPool(), config = { controlVersion: 2 }, ids = [];
  let query = { from: 1, limit: 10 };
  for (;;) {
    const result = await readOfferings(chain, config, pool, query); assert.equal(result.complete, true); ids.push(...result.offerings.map((offer) => offer.pool_id));
    if (!result.next_cursor) break;
    query = { from: result.next_cursor, limit: 10, block_number: result.snapshot.block_number, block_hash: result.snapshot.block_hash };
  }
  assert.deepEqual(ids, Array.from({ length: 25 }, (_, i) => i + 1)); assert.ok(peak <= 6);
  failId = 12; const partial = await readOfferings(chain, config, pool, { from: 11, limit: 10 });
  assert.equal(partial.complete, false); assert.deepEqual(partial.failures, [{ pool_id: 12, code: 'pool_read_unavailable' }]); assert.equal(partial.offerings.length, 9);
  failId = null; assert.equal((await readOfferings(chain, config, pool, { pool_id: 12 })).offerings[0].pool_id, 12);
  next = 27; assert.equal((await readOfferings(chain, config, pool, { from: 21 })).total_pools, 26);
  reorg = true; await assert.rejects(readOfferings(chain, config, pool, query), { code: 'chain_reconciliation_required' });
  assert.ok(calls > 250);
});
