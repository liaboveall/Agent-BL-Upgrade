// Read-only maintenance checklist. No signer, private key, authorization or transaction builder.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
process.env.NODE_TEST_CONTEXT = 'operations-readonly-review';
const { loadRightsChain } = await import('../src/rights/chain.js');
const { readOfferings } = await import('../src/rights/offerings.js');
const { controlledCapitalConfig } = await import('../src/app/controlledRoutes.js');
const configPath = new URL('../public/rights-instance.json', import.meta.url);
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const chain = await loadRightsChain(fileURLToPath(configPath));
try {
  const binding = await chain.verify(), pages = [];
  let query = { from: 1, limit: 10 };
  do {
    const page = await readOfferings(chain, controlledCapitalConfig(config), chain.readPool, query); pages.push(page);
    if (!page.complete) throw new Error('Incomplete pool snapshot; do not plan maintenance from missing data');
    if (!page.next_cursor) break;
    query = { from: page.next_cursor, limit: 10, block_number: page.snapshot.block_number, block_hash: page.snapshot.block_hash };
  } while (true);
  const offers = pages.flatMap(page => page.offerings), tasks = [];
  if (!pages[0].availability.screening_valid) tasks.push({ owner: 'compliance', action: 'refresh_screening', reason: 'Global screening is expired or inactive; review current evidence before setting a new validity window.' });
  for (const pool of offers) {
    if (pool.unsubscribed_exit_available) tasks.push({ pool_id: pool.pool_id, owner: 'enrolled participant', action: 'start_exit', reason: 'Expired empty offering; verify its public terms and release the original collateral.' });
    if (pool.undisbursed_exit_available) tasks.push({ pool_id: pool.pool_id, owner: 'enrolled participant', action: 'start_exit', reason: 'Draw deadline passed without disbursement; return undrawn principal under the current freeze policy.' });
    if (pool.finalize_funding_available) tasks.push({ pool_id: pool.pool_id, owner: 'enrolled participant', action: 'finalize_funding', reason: 'Minimum met and subscription window ended.' });
  }
  if (!offers.some(pool => pool.subscription_open)) tasks.push({ owner: 'issuer / holder / reviewers / valuer', action: 'prepare_new_offering', reason: 'No pool is open for subscription. Expired signed deadlines cannot be renewed by refreshing global screening.' });
  console.log(JSON.stringify({ observed_at: new Date().toISOString(), instance: config.instance_id, binding, snapshot: pages[0].snapshot,
    public_transactions: 0, unsigned_checklist_only: true, total_pools: offers.length, subscribable: offers.filter(pool => pool.subscription_open).length,
    availability: pages[0].availability, tasks }, null, 2));
} finally { await chain.provider.destroy(); }
