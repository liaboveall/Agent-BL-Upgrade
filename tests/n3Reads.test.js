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

test('N3 directory filters scan forward on one snapshot, report unreadable pools and continue from their cursor', async () => {
  const block = { number: 77, hash: `0x${'ab'.repeat(32)}`, timestamp: 1_000_000 };
  // Pools cycle through Funded with subscribers (active), Repaid and fully claimed (closed) and Cancelled with escrow left (active).
  const kind = (id) => [[4n, 5n, 0n], [9n, 5n, 0n], [12n, 5n, 3n]][id % 3];
  const chain = { provider: { getBlock: async () => block }, verify: async () => ({}),
    controller: { termsHash: async () => 'commitment', terms: async () => ({ disburseUntil: 5000, policyHash: 'policy', disclosureHash: 'disclosure' }) },
    pool: { nextPoolId: async () => 26, offerings: async (id) => { if (id === 9) throw new Error('Unavailable');
      return { state: kind(id)[0], tokenSupply: 10n, subscribed: kind(id)[1], issuePrice: 800000n, targetRedemptionValue: 1000000n, settlementAsset: 'asset', raisedAtomic: 0n }; },
    quoteVersion: async () => 1, subscriptionDeadline: async () => block.timestamp - 10, maturityAt: async () => block.timestamp + 10, disbursedAtomic: async () => 0n,
    recoveredAtomic: async () => 0n, escrowed: async (id) => kind(id)[2] } };
  const pool = new RpcReadPool(), config = { controlVersion: 2 };
  const closed = await readOfferings(chain, config, pool, { from: 1, limit: 3, status: 'closed' });
  assert.deepEqual(closed.offerings.map((offer) => offer.pool_id), [1, 4, 7]); assert.equal(closed.next_cursor, 8); assert.equal(closed.status, 'closed');
  const active = await readOfferings(chain, config, pool, { from: 8, limit: 10, status: 'active', block_number: 77, block_hash: block.hash });
  assert.deepEqual(active.failures, [{ pool_id: 9, code: 'pool_read_unavailable' }], 'an unreadable pool is reported, never filtered out');
  assert.deepEqual(active.offerings.map((offer) => offer.pool_id), [8, 11, 12, 14, 15, 17, 18, 20, 21, 23]); assert.equal(active.next_cursor, 24);
  assert.equal((await readOfferings(chain, config, pool, { from: 24, limit: 10, status: 'open' })).next_cursor, null);
  assert.equal(readPage(new URLSearchParams('status=active')).status, 'active');
  assert.throws(() => readPage(new URLSearchParams('status=mine')), { code: 'invalid_pagination' });
});

test('N3 a current pool opens only when screening, valuation, valuer, title, asset and intake allow every investor', async () => {
  const block = { number: 50, hash: `0x${'ab'.repeat(32)}`, timestamp: 1_000_000 }, ZERO = `0x${'0'.repeat(40)}`, CONTROLLER = `0x${'c0'.repeat(20)}`;
  const s = {};
  const reset = () => Object.assign(s, { screening: block.timestamp + 100, valuation: block.timestamp + 100, valuer: true, title: true, asset: true, intake: false,
    state: 2n, subscribed: 0n, deadline: block.timestamp + 100, finalized: false, resolution: { proposer: ZERO, reviewer: ZERO } });
  const chain = { provider: { getBlock: async () => block }, verify: async () => ({}),
    controller: { getAddress: async () => CONTROLLER, termsHash: async () => 'commitment', terms: async () => ({ eblId: 7n, disburseUntil: 5000, policyHash: 'p', disclosureHash: 'd' }),
      intakeStopped: async () => s.intake, screeningValidUntil: async () => s.screening, valuations: async () => ({ validUntil: s.valuation }),
      valuer: async () => `0x${'11'.repeat(20)}`, roles: async () => s.valuer, testAsset: async () => s.asset, resolutions: async () => s.resolution },
    registry: { isActive: async () => s.title },
    pool: { nextPoolId: async () => 2, quoteVersion: async () => 1, subscriptionDeadline: async () => s.deadline, maturityAt: async () => block.timestamp + 1000,
      disbursedAtomic: async () => 0n, recoveredAtomic: async () => 0n, escrowed: async () => 0n, fundingFinalized: async () => s.finalized,
      offerings: async () => ({ state: s.state, tokenSupply: 10n, subscribed: s.subscribed, issuePrice: 800000n, targetRedemptionValue: 1000000n,
        settlementAsset: 'asset', raisedAtomic: s.subscribed * 800000n, minRaise: 4000000n }) } };
  const read = async () => { const page = await readOfferings(chain, { controlVersion: 3 }, new RpcReadPool(), { from: 1, limit: 10 }); return { ...page.offerings[0], availability: page.availability }; };
  reset(); let offer = await read();
  assert.deepEqual([offer.subscription_open, offer.subscription_blockers, offer.availability.screening_valid], [true, [], true]);
  for (const [change, code] of [[{ screening: block.timestamp - 1 }, 'screening_expired'], [{ valuation: block.timestamp - 1 }, 'valuation_expired'],
    [{ valuer: false }, 'valuer_inactive'], [{ title: false }, 'title_inactive'], [{ asset: false }, 'asset_not_allowed'], [{ intake: true }, 'intake_stopped']]) {
    reset(); Object.assign(s, change); offer = await read();
    assert.deepEqual([offer.subscription_open, offer.subscription_blockers], [false, [code]], code);
  }
  // A raise above its minimum but short of the supply must be finalized before anyone can draw it.
  reset(); Object.assign(s, { subscribed: 6n, deadline: block.timestamp - 1 }); offer = await read();
  assert.deepEqual([offer.finalize_funding_available, offer.empty_expired, offer.subscription_blockers], [true, false, ['deadline_passed']]);
  s.finalized = true; assert.equal((await read()).finalize_funding_available, false);
  reset(); s.deadline = block.timestamp - 1; offer = await read();
  assert.deepEqual([offer.empty_expired, offer.finalize_funding_available], [true, false]);
  reset(); Object.assign(s, { state: 13n, subscribed: 10n, resolution: { proposer: CONTROLLER, reviewer: ZERO, noticeUntil: 10n, hardDeadline: 20n, disputed: false, disputeUsed: false, finalized: false } });
  offer = await read();
  assert.deepEqual(offer.resolution, { notice_until: '10', hard_deadline: '20', reviewed: false, disputed: false, dispute_used: false, finalized: false, cash_only_exit: true });
  assert.deepEqual(offer.subscription_blockers, ['state_closed', 'fully_subscribed']);
  // A current-version reader that cannot read the eligibility switches never reports the pool as open.
  reset(); delete chain.controller.screeningValidUntil; offer = await read();
  assert.deepEqual([offer.subscription_open, offer.subscription_blockers], [false, ['eligibility_unverified']]);
});
