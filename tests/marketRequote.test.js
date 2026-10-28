import test from 'node:test';
import assert from 'node:assert/strict';
import { requoteDemoPools } from '../src/app/server.js';
import { createPool, resetStore, storeState, subscribeToPool } from '../src/app/store.js';
import { loadCuratedCase } from '../src/core/curatedCases.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { SimExecutor } from '../src/agent/runtime/executors/simExecutor.js';

const COPPER = 'CASE-EBL-CU-SIN-SHA', CRUDE = 'CASE-EBL-OIL-FUJ-SIN';
// What a pool looks like when a public source was slow while the catalog was first built.
const outage = (quote) => ({ ...quote, pricing_action: 'PAUSE_OFFERING', data_review_required: true, quote_hash: `0x${'ee'.repeat(32)}` });

test('a case paused by a data outage at startup reopens from current data; agent-owned and sized pools keep their state', async (t) => {
  resetStore(); t.after(resetStore);
  const copper = await loadCuratedCase(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url));
  const crude = await loadCuratedCase(new URL('../data/cases/crude-fuj-sin.case.json', import.meta.url));
  const copperQuote = quoteFromCase(copper, { payout_speed: copper.financing.payout_speed });
  assert.equal(copperQuote.pricing_action, 'OPEN_OFFERING', 'Fixture: the offline copper quote is openable');
  const stale = createPool(COPPER, copper, outage(copperQuote));
  assert.deepEqual([stale.status, stale.statusSource], ['Paused', 'quote']);

  // An agent decision owns the crude pool from now on: a market re-quote must not reopen what the agent paused.
  createPool(CRUDE, crude, quoteFromCase(crude, { payout_speed: crude.financing.payout_speed }));
  const agent = new SimExecutor();
  await agent.execute({ decision_id: 'decision_requote_test', idempotency_key: 'requote-test', action: 'PAUSE', pool_id: CRUDE });
  assert.deepEqual([storeState.pools.get(CRUDE).status, storeState.pools.get(CRUDE).statusSource], ['Paused', 'agent']);

  const changed = await requoteDemoPools();
  assert.deepEqual(changed, [COPPER]);
  const reopened = storeState.pools.get(COPPER);
  assert.equal(reopened.status, 'Open');
  assert.equal(reopened.quote.data_review_required, false);
  assert.notEqual(reopened.quote.quote_hash, outage(copperQuote).quote_hash);
  assert.equal(storeState.pools.get(CRUDE).status, 'Paused');

  // Unchanged data leaves the quote, its version and the sold shares alone.
  subscribeToPool('0xDemoWallet', COPPER, 1000);
  const version = reopened.quoteVersion;
  assert.deepEqual(await requoteDemoPools(), []);
  assert.equal(storeState.pools.get(COPPER).quoteVersion, version);
  assert.ok(storeState.pools.get(COPPER).subscribedShares > 0);
});
