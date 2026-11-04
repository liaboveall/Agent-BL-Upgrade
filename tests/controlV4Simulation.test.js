import test from 'node:test';
import assert from 'node:assert/strict';
import { SimExecutor } from '../src/agent/runtime/executors/simExecutor.js';
import { planTransition } from '../src/agent/runtime/poolRules.js';

test('v4 simulation rejects changes to signed price and departure before final funding', async () => {
  const pool = { poolId: 'v4', status: 'Open', subscribedUsd: 4, subscribedShares: 5, tokenSupply: 10,
    quote: { final_issue_price_usd: 0.8 }, quoteVersion: 1 };
  const executor = new SimExecutor({ store: { pools: new Map([['v4', pool]]) } });
  const command = (action) => ({ action, pool_id: 'v4', decision_id: action, idempotency_key: action,
    params: { quote: { final_issue_price_usd: 0.7 }, departure_proof: 'research' } });
  await assert.rejects(executor.execute(command('REPRICE')), { code: 'immutable_terms' });
  await assert.rejects(executor.execute(command('OPEN')), { code: 'immutable_terms' });
  await assert.rejects(executor.execute(command('OPEN_WITH_WARNING')), { code: 'immutable_terms' });
  await assert.rejects(executor.execute(command('MARK_IN_TRANSIT')), { code: 'funding_not_finalized' });
  assert.equal(pool.quote.final_issue_price_usd, 0.8); assert.equal(pool.quoteVersion, 1); assert.equal(pool.status, 'Open');
  pool.status = 'Funded';
  await assert.rejects(executor.execute(command('MARK_IN_TRANSIT')), { code: 'funding_not_finalized' });
  pool.fundingFinalized = true;
  assert.equal((await executor.execute(command('MARK_IN_TRANSIT'))).success, true);
  assert.equal(pool.status, 'InTransit');
  assert.equal(planTransition('REPRICE', { state: 'Open', controlVersion: 4 }).ok, false);
  assert.equal(planTransition('REPRICE', { state: 'Open', controlVersion: 3 }).ok, true, 'legacy rules remain explicit');
});
