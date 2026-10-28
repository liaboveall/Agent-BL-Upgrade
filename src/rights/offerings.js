import { id } from 'ethers';
import { HttpError } from '../app/http.js';
import { chainStateName } from '../agent/runtime/poolRules.js';
import { assertSnapshot, mapReads, readSnapshot, snapshotInfo } from './reads.js';
import { CONTROL_VERSION } from './typedData.js';
import { verifyChain } from './chain.js';
import { multicallFor, multicallViews } from '../chain/multicall.js';

// Read in this order per pool: [offering, termsHash, quoteVersion, subscriptionDeadline, maturityAt, disbursedAtomic, recoveredAtomic, terms].
const VIEWS = [['pool', 'offerings'], ['controller', 'termsHash'], ['pool', 'quoteVersion'], ['pool', 'subscriptionDeadline'],
  ['pool', 'maturityAt'], ['pool', 'disbursedAtomic'], ['pool', 'recoveredAtomic'], ['controller', 'terms']];
// What the controller checks for every investor besides the investor's own eligibility, plus where a resolution stands.
// Instances (and fixture adapters) without a view keep the base row; for the current version that row cannot open.
const EXTRA_VIEWS = [['pool', 'fundingFinalized'], ['controller', 'valuations'], ['controller', 'valuer'], ['controller', 'resolutions']];
const VALUER = id('VALUER');
const ZERO = /^0x0{40}$/iu;
const SUBSCRIBABLE = [2, 3, 6];
const CANCELLABLE_EMPTY = [2, 6, 7, 8, 11];

const supports = (chain, [name, method]) => typeof chain[name]?.[method] === 'function';
const viewsFor = (chain) => [...VIEWS, ...EXTRA_VIEWS.filter((view) => supports(chain, view))];

/** Per-pool reads that need the first round: escrow, and the valuer's role, title activity and asset allowance. */
function secondViews(chain, value) {
  const items = [{ key: 'escrow', contract: chain.pool, method: 'escrowed', args: [value.poolId, value.offerings.settlementAsset] }];
  if (value.valuer && supports(chain, ['controller', 'roles'])) items.push({ key: 'valuer_role', contract: chain.controller, method: 'roles', args: [VALUER, value.valuer] });
  if (value.terms?.eblId != null && supports(chain, ['registry', 'isActive'])) items.push({ key: 'title_active', contract: chain.registry, method: 'isActive', args: [value.terms.eblId] });
  if (supports(chain, ['controller', 'testAsset'])) items.push({ key: 'asset_allowed', contract: chain.controller, method: 'testAsset', args: [value.offerings.settlementAsset] });
  return items;
}

function resolutionOf(resolution, controller) {
  const proposer = resolution?.proposer;
  if (!proposer || ZERO.test(proposer)) return null;
  const text = (value) => value == null ? null : String(value);
  return { notice_until: text(resolution.noticeUntil), hard_deadline: text(resolution.hardDeadline), reviewed: Boolean(resolution.reviewer && !ZERO.test(resolution.reviewer)),
    disputed: Boolean(resolution.disputed), dispute_used: Boolean(resolution.disputeUsed), finalized: Boolean(resolution.finalized),
    // A cash-only exit started by anyone at maturity can only be finalized at its hard deadline.
    cash_only_exit: Boolean(controller) && String(proposer).toLowerCase() === controller.toLowerCase() };
}

/**
 * Every reason a new subscription would fail for everyone, as the controller's isEligible() and the pool see it.
 * The investor's own credential and term acceptance are checked when that wallet prepares its subscription.
 */
function subscriptionBlockers(config, block, instance, value, second) {
  const offer = value.offerings, blockers = [];
  if (config.controlVersion !== CONTROL_VERSION) blockers.push('legacy_instance');
  if (!SUBSCRIBABLE.includes(Number(offer.state))) blockers.push('state_closed');
  if (Number(value.subscriptionDeadline) < block.timestamp) blockers.push('deadline_passed');
  if (BigInt(offer.subscribed) >= BigInt(offer.tokenSupply)) blockers.push('fully_subscribed');
  if (config.controlVersion !== CONTROL_VERSION) return blockers;
  const unknown = instance.intake_stopped == null || instance.screening_valid_until == null || value.valuations == null
    || second.valuer_role == null || second.title_active == null || second.asset_allowed == null;
  if (unknown) { blockers.push('eligibility_unverified'); return blockers; }
  if (instance.intake_stopped) blockers.push('intake_stopped');
  if (Number(instance.screening_valid_until) < block.timestamp) blockers.push('screening_expired');
  if (Number(value.valuations.validUntil) < block.timestamp) blockers.push('valuation_expired');
  if (!second.valuer_role) blockers.push('valuer_inactive');
  if (!second.title_active) blockers.push('title_inactive');
  if (!second.asset_allowed) blockers.push('asset_not_allowed');
  return blockers;
}

function offeringRow(config, block, instance, value, second) {
  const { poolId, offerings: offer, termsHash, quoteVersion: version, subscriptionDeadline: deadline, maturityAt: maturity,
    disbursedAtomic: disbursed, recoveredAtomic: recovered, terms } = value;
  const state = Number(offer.state), expired = Number(deadline) < block.timestamp;
  const blockers = subscriptionBlockers(config, block, instance, value, second);
  const finalized = value.fundingFinalized == null ? null : Boolean(value.fundingFinalized);
  return { offering: { pool_id: poolId, state: chainStateName(offer.state), shares: String(offer.tokenSupply), subscribed: String(offer.subscribed),
    issue_price_atomic: String(offer.issuePrice), redemption_per_share_atomic: String(offer.targetRedemptionValue), settlement_asset: offer.settlementAsset,
    raised_atomic: String(offer.raisedAtomic), min_raise_atomic: offer.minRaise == null ? null : String(offer.minRaise), disbursed_atomic: String(disbursed), recovered_atomic: String(recovered), escrow_atomic: String(second.escrow),
    subscription_deadline: String(deadline), disbursement_deadline: terms.disburseUntil == null ? null : String(terms.disburseUntil), maturity: String(maturity),
    quote_version: String(version), terms_hash: termsHash, policy_hash: terms.policyHash, disclosure_hash: terms.disclosureHash, block_number: block.number,
    valuation_valid_until: value.valuations?.validUntil == null ? null : String(value.valuations.validUntil),
    funding_finalized: finalized,
    // A successful partial raise stays Subscribed until anyone closes it with finalizeFunding().
    finalize_funding_available: finalized === false && SUBSCRIBABLE.includes(state) && expired && BigInt(offer.subscribed) > 0n
      && offer.minRaise != null && BigInt(offer.raisedAtomic) >= BigInt(offer.minRaise),
    // No subscriber and past its deadline: only the operator's cancellation releases the pledged title.
    empty_expired: BigInt(offer.subscribed) === 0n && expired && CANCELLABLE_EMPTY.includes(state),
    resolution: resolutionOf(value.resolutions, instance.controller),
    subscription_blockers: blockers, subscription_open: blockers.length === 0 } };
}

const named = (views, poolId, values) => ({ poolId, ...Object.fromEntries(views.map(([, method], index) => [method, values[index]])) });

/** One page in two eth_calls through the verified Multicall3: every view at the snapshot block, then the dependent ones. */
async function batchedRows(chain, config, instance, multicall, ids, block, read) {
  const views = viewsFor(chain);
  const values = await multicallViews(multicall, ids.flatMap((poolId) => views.map(([name, method]) => ({ contract: chain[name], method, args: [poolId] }))),
    { blockTag: block.number, read });
  const perPool = ids.map((poolId, index) => values.slice(index * views.length, (index + 1) * views.length));
  const readable = ids.flatMap((_, index) => perPool[index].some((value) => value instanceof Error) ? [] : [index]);
  const firsts = new Map(readable.map((index) => [index, named(views, ids[index], perPool[index])]));
  const seconds = new Map(readable.map((index) => [index, secondViews(chain, firsts.get(index))]));
  const flat = readable.flatMap((index) => seconds.get(index));
  const answers = await multicallViews(multicall, flat, { blockTag: block.number, read });
  let offset = 0;
  return ids.map((poolId, index) => {
    if (!firsts.has(index)) return { pool_id: poolId, code: 'pool_read_unavailable' };
    const items = seconds.get(index), results = answers.slice(offset, offset += items.length);
    if (results[0] instanceof Error) return { pool_id: poolId, code: 'pool_read_unavailable' };
    const second = Object.fromEntries(items.map((item, position) => [item.key, results[position] instanceof Error ? null : results[position]]));
    return offeringRow(config, block, instance, firsts.get(index), second);
  });
}

function singleRows(chain, config, instance, ids, block, read) {
  const at = { blockTag: block.number }, views = viewsFor(chain);
  return mapReads(ids, async (poolId) => {
    try {
      const value = named(views, poolId, await Promise.all(views.map(([name, method]) => read(() => chain[name][method](poolId, at)))));
      const items = secondViews(chain, value);
      const results = await Promise.all(items.map((item, position) => read(() => item.contract[item.method](...item.args, at))
        .catch((error) => { if (position === 0) throw error; return null; })));
      return offeringRow(config, block, instance, value, Object.fromEntries(items.map((item, position) => [item.key, results[position]])));
    } catch { return { pool_id: poolId, code: 'pool_read_unavailable' }; }
  });
}

/** Instance-wide switches the controller applies to every subscription and draw, read once per snapshot. */
async function instanceAvailability(chain, read, at) {
  const optional = (method) => supports(chain, ['controller', method]) ? read(() => chain.controller[method](at)).catch(() => null) : Promise.resolve(null);
  const [intake, screening, controller] = await Promise.all([optional('intakeStopped'), optional('screeningValidUntil'),
    typeof chain.controller?.getAddress === 'function' ? chain.controller.getAddress() : null]);
  return { intake_stopped: intake == null ? null : Boolean(intake), screening_valid_until: screening == null ? null : String(screening), controller };
}

// Directory filters. `open` takes new money; `active` still holds money (escrow, or subscribers in a pool that has not
// ended); `closed` is over or never got a subscriber. `all` (reads.js readPage) lists every pool in order.
const ENDED = ['Repaid', 'Cancelled', 'LossSettled'];
export function offeringFilter(offering) {
  if (offering.subscription_open) return 'open';
  return BigInt(offering.escrow_atomic ?? 0) > 0n || !ENDED.includes(offering.state) && BigInt(offering.subscribed) > 0n ? 'active' : 'closed';
}
// A filtered page scans forward in chunks and stops early rather than spend the whole read budget; it may then hold
// fewer rows than the limit, and `next_cursor` says where the scan continues.
const SCAN_CHUNK = 10, SCAN_BUDGET = 320;

export async function readOfferings(chain, config, pool, query = {}) {
  const budget = pool.budget(480), { read } = budget;
  const block = await readSnapshot(chain.provider, query, read), at = { blockTag: block.number };
  await verifyChain(chain, { read, readAt: at });
  const next = Number(await read(() => chain.pool.nextPoolId(at)));
  if (!Number.isSafeInteger(next) || next < 1) throw new HttpError(503, 'pool_count_invalid', 'Pool discovery is unavailable');
  const from = query.pool_id ?? query.from ?? 1, limit = query.pool_id ? 1 : query.limit ?? 10;
  const filter = !query.pool_id && query.status && query.status !== 'all' ? query.status : null;
  if (query.pool_id && from >= next) throw new HttpError(404, 'controlled_pool_not_found', 'Funding pool not found in this instance');
  const range = (start, count) => Array.from({ length: Math.max(0, Math.min(next - start, count)) }, (_, index) => start + index);
  const instance = await instanceAvailability(chain, read, at);
  // A failed batch (an RPC that rejects large calls, say) falls back to the per-view reads rather than failing the page.
  const multicall = next > from ? await multicallFor(chain.provider, read) : null;
  const readRows = async (ids) => (multicall && await batchedRows(chain, config, instance, multicall, ids, block, read).catch(() => null)) || singleRows(chain, config, instance, ids, block, read);
  let rows, cursor;
  if (!filter) { rows = await readRows(range(from, limit)); cursor = from + limit; }
  else {
    rows = []; cursor = from;
    // Unreadable pools cannot be classified, so they are always reported rather than silently filtered out.
    while (cursor < next && rows.filter((row) => row.offering).length < limit && (cursor === from || budget.stats.calls < SCAN_BUDGET)) {
      const ids = range(cursor, SCAN_CHUNK), chunk = await readRows(ids);
      for (const [index, row] of chunk.entries()) {
        cursor = ids[index] + 1;
        if (!row.offering || offeringFilter(row.offering) === filter) rows.push(row);
        if (rows.filter((item) => item.offering).length >= limit) break;
      }
    }
  }
  await assertSnapshot(chain.provider, block, read);
  const failed = rows.filter((row) => !row.offering);
  const { controller: _controller, ...availability } = instance;
  return { offerings: rows.flatMap((row) => row.offering ? [row.offering] : []), failures: failed, complete: failed.length === 0,
    total_pools: next - 1, from, limit, status: filter ?? 'all', next_cursor: cursor < next ? cursor : null,
    availability: { ...availability, screening_valid: availability.screening_valid_until == null ? null : Number(availability.screening_valid_until) >= block.timestamp },
    snapshot: snapshotInfo(block), read_metrics: budget.stats, scope: 'research_test_assets_only', config };
}
