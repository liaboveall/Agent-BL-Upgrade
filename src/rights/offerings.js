import { HttpError } from '../app/http.js';
import { chainStateName } from '../agent/runtime/poolRules.js';
import { assertSnapshot, mapReads, readSnapshot, snapshotInfo } from './reads.js';
import { CONTROL_VERSION } from './typedData.js';
import { verifyChain } from './chain.js';
import { multicallFor, multicallViews } from '../chain/multicall.js';

// Read in this order per pool: [offering, termsHash, quoteVersion, subscriptionDeadline, maturityAt, disbursedAtomic, recoveredAtomic, terms].
const VIEWS = [['pool', 'offerings'], ['controller', 'termsHash'], ['pool', 'quoteVersion'], ['pool', 'subscriptionDeadline'],
  ['pool', 'maturityAt'], ['pool', 'disbursedAtomic'], ['pool', 'recoveredAtomic'], ['controller', 'terms']];

function offeringRow(config, block, poolId, [offer, termsHash, version, deadline, maturity, disbursed, recovered, terms], escrow) {
  return { offering: { pool_id: poolId, state: chainStateName(offer.state), shares: String(offer.tokenSupply), subscribed: String(offer.subscribed),
    issue_price_atomic: String(offer.issuePrice), redemption_per_share_atomic: String(offer.targetRedemptionValue), settlement_asset: offer.settlementAsset,
    raised_atomic: String(offer.raisedAtomic), disbursed_atomic: String(disbursed), recovered_atomic: String(recovered), escrow_atomic: String(escrow),
    subscription_deadline: String(deadline), disbursement_deadline: terms.disburseUntil == null ? null : String(terms.disburseUntil), maturity: String(maturity),
    quote_version: String(version), terms_hash: termsHash, policy_hash: terms.policyHash, disclosure_hash: terms.disclosureHash, block_number: block.number,
    subscription_open: config.controlVersion === CONTROL_VERSION && [2, 3, 6].includes(Number(offer.state)) && Number(deadline) >= block.timestamp && offer.subscribed < offer.tokenSupply } };
}

/** One page in two eth_calls through the verified Multicall3: every view at the snapshot block, then each escrow. */
async function batchedRows(chain, config, multicall, ids, block, read) {
  const values = await multicallViews(multicall, ids.flatMap((poolId) => VIEWS.map(([name, method]) => ({ contract: chain[name], method, args: [poolId] }))),
    { blockTag: block.number, read });
  const perPool = ids.map((_, index) => values.slice(index * VIEWS.length, (index + 1) * VIEWS.length));
  const readable = ids.flatMap((poolId, index) => perPool[index].some((value) => value instanceof Error) ? [] : [index]);
  const escrows = await multicallViews(multicall, readable.map((index) => ({ contract: chain.pool, method: 'escrowed', args: [ids[index], perPool[index][0].settlementAsset] })),
    { blockTag: block.number, read });
  const escrowOf = new Map(readable.map((index, position) => [index, escrows[position]]));
  return ids.map((poolId, index) => {
    const escrow = escrowOf.get(index);
    return escrow === undefined || escrow instanceof Error ? { pool_id: poolId, code: 'pool_read_unavailable' } : offeringRow(config, block, poolId, perPool[index], escrow);
  });
}

function singleRows(chain, config, ids, block, read) {
  const at = { blockTag: block.number };
  return mapReads(ids, async (poolId) => {
    try {
      const values = await Promise.all(VIEWS.map(([name, method]) => read(() => chain[name][method](poolId, at))));
      const escrow = await read(() => chain.pool.escrowed(poolId, values[0].settlementAsset, at));
      return offeringRow(config, block, poolId, values, escrow);
    } catch { return { pool_id: poolId, code: 'pool_read_unavailable' }; }
  });
}

export async function readOfferings(chain, config, pool, query = {}) {
  const budget = pool.budget(480), { read } = budget;
  const block = await readSnapshot(chain.provider, query, read), at = { blockTag: block.number };
  await verifyChain(chain, { read, readAt: at });
  const next = Number(await read(() => chain.pool.nextPoolId(at)));
  if (!Number.isSafeInteger(next) || next < 1) throw new HttpError(503, 'pool_count_invalid', 'Pool discovery is unavailable');
  const from = query.pool_id ?? query.from ?? 1, limit = query.pool_id ? 1 : query.limit ?? 10;
  if (query.pool_id && from >= next) throw new HttpError(404, 'controlled_pool_not_found', 'Funding pool not found in this instance');
  const ids = Array.from({ length: Math.max(0, Math.min(next - from, limit)) }, (_, index) => from + index);
  // A failed batch (an RPC that rejects large calls, say) falls back to the per-view reads rather than failing the page.
  const multicall = ids.length ? await multicallFor(chain.provider, read) : null;
  const rows = (multicall && await batchedRows(chain, config, multicall, ids, block, read).catch(() => null)) || await singleRows(chain, config, ids, block, read);
  await assertSnapshot(chain.provider, block, read);
  const failed = rows.filter((row) => !row.offering);
  return { offerings: rows.flatMap((row) => row.offering ? [row.offering] : []), failures: failed, complete: failed.length === 0,
    total_pools: next - 1, from, limit, next_cursor: from + limit < next ? from + limit : null,
    snapshot: snapshotInfo(block), read_metrics: budget.stats, scope: 'research_test_assets_only', config };
}
