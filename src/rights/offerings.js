import { HttpError } from '../app/http.js';
import { chainStateName } from '../agent/runtime/poolRules.js';
import { assertSnapshot, mapReads, readSnapshot, snapshotInfo } from './reads.js';

export async function readOfferings(chain, config, pool, query = {}) {
  const budget = pool.budget(480), { read } = budget;
  const block = await readSnapshot(chain.provider, query, read), at = { blockTag: block.number };
  await chain.verify({ read, readAt: at });
  const next = Number(await read(() => chain.pool.nextPoolId(at)));
  if (!Number.isSafeInteger(next) || next < 1) throw new HttpError(503, 'pool_count_invalid', 'Pool discovery is unavailable');
  const from = query.pool_id ?? query.from ?? 1, limit = query.pool_id ? 1 : query.limit ?? 10;
  if (query.pool_id && from >= next) throw new HttpError(404, 'controlled_pool_not_found', 'Funding pool not found in this instance');
  const ids = Array.from({ length: Math.max(0, Math.min(next - from, limit)) }, (_, index) => from + index);
  const rows = await mapReads(ids, async (poolId) => {
    try {
      const view = (contract, method) => read(() => contract[method](poolId, at));
      const [offer, termsHash, version, deadline, maturity, disbursed, recovered, terms] = await Promise.all([
        view(chain.pool, 'offerings'), view(chain.controller, 'termsHash'), view(chain.pool, 'quoteVersion'), view(chain.pool, 'subscriptionDeadline'),
        view(chain.pool, 'maturityAt'), view(chain.pool, 'disbursedAtomic'), view(chain.pool, 'recoveredAtomic'), view(chain.controller, 'terms') ]);
      const escrow = await read(() => chain.pool.escrowed(poolId, offer.settlementAsset, at));
      return { offering: { pool_id: poolId, state: chainStateName(offer.state), shares: String(offer.tokenSupply), subscribed: String(offer.subscribed),
        issue_price_atomic: String(offer.issuePrice), redemption_per_share_atomic: String(offer.targetRedemptionValue), settlement_asset: offer.settlementAsset,
        raised_atomic: String(offer.raisedAtomic), disbursed_atomic: String(disbursed), recovered_atomic: String(recovered), escrow_atomic: String(escrow),
        subscription_deadline: String(deadline), disbursement_deadline: terms.disburseUntil == null ? null : String(terms.disburseUntil), maturity: String(maturity),
        quote_version: String(version), terms_hash: termsHash, policy_hash: terms.policyHash, disclosure_hash: terms.disclosureHash, block_number: block.number,
        subscription_open: config.controlVersion !== 1 && [2, 3, 6].includes(Number(offer.state)) && Number(deadline) >= block.timestamp && offer.subscribed < offer.tokenSupply } };
    } catch { return { pool_id: poolId, code: 'pool_read_unavailable' }; }
  });
  await assertSnapshot(chain.provider, block, read);
  const failed = rows.filter((row) => !row.offering);
  return { offerings: rows.flatMap((row) => row.offering ? [row.offering] : []), failures: failed, complete: failed.length === 0,
    total_pools: next - 1, from, limit, next_cursor: from + limit < next ? from + limit : null,
    snapshot: snapshotInfo(block), read_metrics: budget.stats, scope: 'research_test_assets_only', config };
}
