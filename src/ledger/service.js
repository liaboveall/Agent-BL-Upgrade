import { Contract, isAddress } from 'ethers';
import { Ledger, BLOCKING_INTENT_STATUSES } from './ledger.js';
import { ChainEventRebuilder } from './rebuilder.js';
import { buildPositionView, balanceKey } from './positionView.js';
import { PROTOCOL_V5_ABI } from '../chain/protocolV5Abi.js';
import { chainStateName } from '../agent/runtime/poolRules.js';
import { RpcReadPool, mapReads, assertSnapshot, snapshotInfo, boundedProvider } from '../rights/reads.js';
import { CONTROL_VERSION } from '../rights/typedData.js';
import { findNonceTransaction } from '../chain/nonceLookup.js';
import { NEW_RISK_CAPITAL_OPERATIONS, assertOperationOpen } from '../ops/intakePolicy.js';

const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { code, status, expose: true }); };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Provider-only ledger integration. Signing stays in the user's wallet. */
export class CapitalLedgerService {
  constructor({ ledger, chainConfig, getContext, getMode = () => 'demo', getGeneration = () => 0, readPool = new RpcReadPool(), confirmations = 1,
    intakeGate = () => ({ ok: true }) }) {
    // intakeGate: operational readiness for callers that do not pass their own (src/ops/intakePolicy.js).
    Object.assign(this, { ledger, chainConfig, getContext, getMode, getGeneration, readPool, confirmations, intakeGate });
    this.rebuilder = new ChainEventRebuilder(ledger);
  }

  async context() {
    const cfg = this.chainConfig;
    if (Number(cfg?.protocolVersion) !== 5) fail('capital_protocol_unavailable', 'This deployment does not support the v5 capital protocol');
    const ctx = await this.getContext();
    if (!ctx?.provider) fail('chain_unavailable', 'Read-only chain context unavailable', 503);
    const pool = new Contract(cfg.contracts.RWAOfferingPool, PROTOCOL_V5_ABI.RWAOfferingPool, ctx.provider);
    const [network, version] = await Promise.all([ctx.provider.getNetwork(), pool.protocolVersion()]);
    if (Number(network.chainId) !== Number(cfg.chainIdDecimal) || Number(version) !== 5) fail('protocol_identity_mismatch', 'Capital protocol identity changed');
    return { ...ctx, pool };
  }

  async sync() {
    const ctx = await this.context(), cfg = this.chainConfig;
    // Cold recovery can scan many 2,000-block log windows. Keep it bounded,
    // independently of the short budget for one page of current balances.
    const budget = this.readPool.budget(10000, { deadlineMs: 120000 });
    const result = await this.rebuilder.rebuild({ provider: boundedProvider(ctx.provider, budget.read), poolAddress: cfg.contracts.RWAOfferingPool,
      chainId: cfg.chainIdDecimal, protocolVersion: 5,
      fromBlock: cfg.deployments?.RWAOfferingPool?.blockNumber ?? 0, confirmations: this.confirmations });
    return { ...result, context: ctx, sync_read_metrics: budget.stats };
  }

  async list(wallet, demoInvestments = [], query = {}) {
    const chainPositions = new Map();
    let budget = { stats: { calls: 0, retries: 0, failures: 0 } };
    let syncError = null, snapshot = null, nextCursor = null, total = null, ledgerAtSnapshot = null;
    const failures = [], from = query.from ?? 1, limit = query.limit ?? 20;
    try {
      if (Number(this.chainConfig?.protocolVersion) === 5) {
        const { positions, cursor, context } = await this.sync();
        budget = this.readPool.budget(200);
        const { read } = budget;
        if (!cursor) throw new Error('No confirmed ledger checkpoint');
        const cfg = this.chainConfig;
        // Pagination of balances uses the requested confirmed block, independently of
        // any newer cash facts replayed during this HTTP request.
        const blockNumber = query.block_number ?? cursor.last_block;
        if (blockNumber > cursor.last_block) throw new Error('Unconfirmed position snapshot');
        const block = await read(() => context.provider.getBlock(blockNumber));
        if (!block || query.block_hash && !same(block.hash, query.block_hash) || blockNumber === cursor.last_block && !same(block.hash, cursor.last_block_hash)) throw new Error('Position checkpoint reorganized');
        const at = { blockTag: block.number };
        const next = Number(await read(() => context.pool.nextPoolId(at)));
        if (!Number.isSafeInteger(next) || next < 1 || next > 10_001) throw new Error('Pool discovery exceeds the local ledger limit');
        total = next - 1; nextCursor = from + limit < next ? from + limit : null;
        const token = new Contract(cfg.contracts.RWAToken, ['function balanceOf(uint256,address) view returns (uint256)'], context.provider);
        const ids = Array.from({ length: Math.max(0, Math.min(limit, next - from)) }, (_, i) => from + i);
        await mapReads(ids, async (id) => {
          try {
            const [shares, claimable, offering] = await Promise.all([
              read(() => token.balanceOf(id, wallet, at)), read(() => context.pool.claimable(id, wallet, at)), read(() => context.pool.offerings(id, at))]);
            const pi = cursor.protocol_instance;
            chainPositions.set(balanceKey(pi, id), { protocol_instance: pi, chain_pool_id: id, asset: offering.settlementAsset,
              shares: String(shares), claimable_atomic: String(claimable), state: chainStateName(offering.state), block_number: block.number, canonical: true });
          } catch { failures.push({ pool_id: id, code: 'position_read_unavailable' }); }
        });
        await assertSnapshot(context.provider, block, read);
        snapshot = snapshotInfo(block);
        ledgerAtSnapshot = Object.values(Ledger.project(Ledger.activeEntries(await this.ledger.writer.readCashEntries())
          .filter((entry) => entry.block_number <= block.number)));
        void positions;
      }
    } catch { chainPositions.clear(); syncError = 'chain_reconciliation_required'; }
    const positions = buildPositionView({ wallet, demoInvestments,
      ledgerPositions: Number(this.chainConfig?.protocolVersion) === 5 ? (ledgerAtSnapshot ?? await this.ledger.listPositions()).filter((pos) => pos.chain_pool_id >= from && pos.chain_pool_id < from + limit) : [], chainPositions })
      .map((position) => ({ ...position, recovery_rights_retained: position.mode === 'live' && this.chainConfig?.controlVersion >= 2 }));
    return { wallet: wallet.toLowerCase(), positions, complete: !syncError && failures.length === 0 && positions.every((pos) => pos.mode !== 'live' || pos.reconciled),
      failures, next_cursor: nextCursor, from, limit, total_pools: total, snapshot, read_metrics: budget.stats,
      ...(syncError || failures.length ? { warning: syncError ?? 'partial_position_reads' } : {}) };
  }

  async prepareSubscription({ wallet, chain_pool_id: poolId, shares, max_unit_price: maxPrice, expected_quote_version: expectedVersion, deadline, reviewed_disclosure_hash: disclosureHash, authorization_subject, authorization_session }, { readiness = this.intakeGate } = {}) {
    assertOperationOpen(NEW_RISK_CAPITAL_OPERATIONS, 'SUBSCRIBE', readiness, 'Controlled intake is paused');
    const generation = this.getGeneration();
    if (this.chainConfig?.controlVersion != null && this.chainConfig.controlVersion < CONTROL_VERSION) fail('legacy_exit_only', 'This instance accepts existing exits only');
    if (this.getMode() !== 'live') fail('live_mode_required', 'Switch to Live before preparing a wallet transaction');
    if (!isAddress(wallet) || !/^\d+$/u.test(String(shares)) || BigInt(shares) <= 0n || !Number.isSafeInteger(Number(poolId)) || Number(poolId) < 1) fail('invalid_subscription', 'A wallet, pool and positive whole shares are required', 400);
    const ctx = await this.context(), cfg = this.chainConfig;
    const [offering, version, stopped, eligible, chainDeadline, block] = await Promise.all([
      ctx.pool.offerings(poolId), ctx.pool.quoteVersion(poolId), ctx.pool.emergencyStopped(), ctx.pool.isInvestorEligible(wallet, poolId),
      ctx.pool.subscriptionDeadline(poolId), ctx.provider.getBlock('latest')]);
    if (!offering.exists || stopped || !eligible || ![2, 3, 6].includes(Number(offering.state))) fail('pool_unavailable', 'Offering unavailable');
    if (![maxPrice, expectedVersion, deadline].every((value) => /^\d+$/u.test(String(value)))) fail('invalid_terms', 'Price, quote version and deadline are required', 400);
    if (BigInt(maxPrice) !== offering.issuePrice || BigInt(expectedVersion) !== version || offering.subscribed + BigInt(shares) > offering.tokenSupply) fail('quote_changed', 'Request a fresh subscription quote');
    const until = BigInt(deadline) < chainDeadline ? BigInt(deadline) : chainDeadline;
    if (until < BigInt(block.timestamp) || until > BigInt(block.timestamp) + 900n) fail('invalid_deadline', 'Subscription deadline expired or exceeds 15 minutes');
    const calldata = ctx.pool.interface.encodeFunctionData('subscribeWithTerms', [poolId, BigInt(shares), offering.issuePrice, version, until]);
    if (generation !== this.getGeneration() || this.getMode() !== 'live') fail('execution_context_changed', 'Execution context changed while preparing; review again');
    assertOperationOpen(NEW_RISK_CAPITAL_OPERATIONS, 'SUBSCRIBE', readiness, 'Controlled intake is paused');
    return this.ledger.recordIntent({ protocol_instance: { chain_id: Number(cfg.chainIdDecimal), pool_address: cfg.contracts.RWAOfferingPool.toLowerCase(), protocol_version: 5 },
      chain_pool_id: Number(poolId), operation: 'SUBSCRIBE', execution_generation: generation, authorization_subject, authorization_session, created_block: (await ctx.provider.getBlockNumber()) + 1, investor: wallet, asset: offering.settlementAsset, amount_atomic: String(offering.issuePrice * BigInt(shares)), shares: String(shares), calldata,
      ...(disclosureHash ? { reviewed_disclosure_hash: disclosureHash, reviewed_quote_version: String(version) } : {}) });
  }

  async prepareClaim({ wallet, chain_pool_id: poolId, authorization_subject, authorization_session }) {
    const generation = this.getGeneration();
    if (this.getMode() !== 'live') fail('live_mode_required', 'Switch to Live before preparing a wallet transaction');
    if (!isAddress(wallet) || !Number.isSafeInteger(Number(poolId)) || Number(poolId) < 1) fail('invalid_claim', 'A wallet and pool are required', 400);
    const ctx = await this.context(), cfg = this.chainConfig;
    const token = new Contract(cfg.contracts.RWAToken, ['function balanceOf(uint256,address) view returns (uint256)'], ctx.provider);
    const [offering, shares, amount] = await Promise.all([ctx.pool.offerings(poolId), token.balanceOf(poolId, wallet), ctx.pool.claimable(poolId, wallet)]);
    if (!offering.exists || ![9, 14].includes(Number(offering.state)) || (shares === 0n && amount === 0n)) fail('position_not_claimable', 'No terminal position to claim');
    await ctx.pool.claim.staticCall(poolId, { from: wallet });
    if (generation !== this.getGeneration() || this.getMode() !== 'live') fail('execution_context_changed', 'Execution context changed while preparing; review again');
    return this.ledger.recordIntent({ protocol_instance: { chain_id: Number(cfg.chainIdDecimal), pool_address: cfg.contracts.RWAOfferingPool.toLowerCase(), protocol_version: 5 },
      chain_pool_id: Number(poolId), operation: 'CLAIM', execution_generation: generation, authorization_subject, authorization_session, created_block: (await ctx.provider.getBlockNumber()) + 1, investor: wallet, asset: offering.settlementAsset,
      amount_atomic: String(amount), shares: String(shares), calldata: ctx.pool.interface.encodeFunctionData('claim', [poolId]) });
  }

  async attach(intentId, txHash) {
    const intent = await this.ledger.getIntent(intentId);
    if (!intent || !/^0x[0-9a-f]{64}$/iu.test(txHash)) fail('invalid_intent', 'Intent and transaction hash are required', 400);
    const ctx = await this.context();
    if (Number(intent.protocol_instance.chain_id) !== Number(this.chainConfig.chainIdDecimal)
      || !same(intent.protocol_instance.pool_address, this.chainConfig.contracts.RWAOfferingPool)) fail('protocol_identity_mismatch', 'Intent belongs to another protocol instance');
    const tx = await ctx.provider.getTransaction(txHash);
    if (!tx || !same(tx.to, intent.protocol_instance.pool_address) || !same(tx.from, intent.investor)
      || !same(tx.data, intent.calldata) || BigInt(tx.value) !== 0n || Number(tx.chainId) !== Number(intent.protocol_instance.chain_id)
      || intent.broadcast_nonce !== undefined && tx.nonce !== intent.broadcast_nonce) fail('intent_transaction_mismatch', 'Transaction does not match the saved wallet intent');
    await this.ledger.markBroadcast(intentId, txHash);
    await this.sync();
    return this.#settleReceipt(intentId, ctx);
  }

  /**
   * A mined transaction without a cash event may have failed. Only a canonical receipt with status 0 that is as deep as
   * the ledger's confirmations ends the operation as `reverted`; a receipt that disappeared re-opens it for reconciliation.
   */
  async #settleReceipt(intentId, ctx) {
    const intent = await this.ledger.getIntent(intentId);
    if (!intent?.tx_hash || intent.status === 'confirmed') return intent;
    const { read } = this.readPool.budget(20);
    const receipt = await read(() => ctx.provider.getTransactionReceipt(intent.tx_hash));
    if (!receipt) return intent.status === 'reverted' ? this.ledger.reconcileIntent(intentId, intent.tx_hash) : intent;
    if (Number(receipt.status) !== 0) return intent;
    if (!await this.#settled(receipt, ctx, read)) return intent;
    if (intent.status === 'reverted' && same(intent.block_hash, receipt.blockHash)) return intent;
    return this.ledger.revertIntent(intentId, intent.tx_hash, { block_number: receipt.blockNumber, block_hash: receipt.blockHash });
  }

  /** A receipt the ledger may act on: in the canonical block it names, and as deep as the configured confirmations. */
  async #settled(receipt, ctx, read) {
    if (!receipt?.blockHash) return false;
    const [block, latest] = await Promise.all([read(() => ctx.provider.getBlock(receipt.blockNumber)), read(() => ctx.provider.getBlockNumber())]);
    return Boolean(block?.hash) && same(block.hash, receipt.blockHash) && Number(latest) - Number(receipt.blockNumber) + 1 >= this.confirmations;
  }

  async prepareRefund({ wallet, chain_pool_id: poolId, authorization_subject, authorization_session }) {
    const generation = this.getGeneration();
    if (this.getMode() !== 'live') fail('live_mode_required', 'Switch to Live before preparing a wallet transaction');
    if (!isAddress(wallet) || !Number.isSafeInteger(Number(poolId)) || Number(poolId) < 1) fail('invalid_refund', 'A wallet and pool are required', 400);
    const ctx = await this.context(), cfg = this.chainConfig;
    const offering = await ctx.pool.offerings(poolId);
    await ctx.pool.refundInvestor.staticCall(poolId, wallet, { from: wallet });
    const amount = await ctx.pool.investorPaid(poolId, offering.settlementAsset, wallet);
    const token = new Contract(cfg.contracts.RWAToken, ['function balanceOf(uint256,address) view returns (uint256)'], ctx.provider);
    if (generation !== this.getGeneration() || this.getMode() !== 'live') fail('execution_context_changed', 'Execution context changed while preparing; review again');
    return this.ledger.recordIntent({ protocol_instance: { chain_id: Number(cfg.chainIdDecimal), pool_address: cfg.contracts.RWAOfferingPool.toLowerCase(), protocol_version: 5 },
      chain_pool_id: Number(poolId), operation: 'REFUND', execution_generation: generation, authorization_subject, authorization_session, created_block: (await ctx.provider.getBlockNumber()) + 1, investor: wallet, asset: offering.settlementAsset, amount_atomic: String(amount),
      shares: String(await token.balanceOf(poolId, wallet)), calldata: ctx.pool.interface.encodeFunctionData('refundInvestor', [poolId, wallet]) });
  }

  /** The last check before the wallet sees a saved intent; new money is re-checked against readiness before and after the chain reads. */
  async checkpointBroadcast(intentId, { readiness = this.intakeGate } = {}) {
    const paused = 'Controlled intake is paused; this saved subscription cannot be sent now';
    if (this.getMode() !== 'live') fail('live_mode_required', 'Switch to Live before preparing a wallet transaction');
    const intent = await this.ledger.getIntent(intentId);
    assertOperationOpen(NEW_RISK_CAPITAL_OPERATIONS, intent?.operation, readiness, paused);
    const ctx = await this.context();
    if (!intent || !same(intent.protocol_instance.pool_address, this.chainConfig.contracts.RWAOfferingPool)
      || Number(intent.protocol_instance.chain_id) !== Number(this.chainConfig.chainIdDecimal)) fail('invalid_intent', 'Intent belongs to another protocol');
    if (intent.execution_generation !== undefined && intent.execution_generation !== this.getGeneration()) fail('execution_context_changed', 'Execution mode changed; prepare and review a new draft');
    await ctx.provider.call({ from: intent.investor, to: intent.protocol_instance.pool_address, data: intent.calldata, value: 0n });
    const [pending, block] = await Promise.all([ctx.provider.getTransactionCount(intent.investor, 'pending'), ctx.provider.getBlockNumber()]);
    // An operation the wallet said it never sent keeps its nonce: this send reuses it, so at most one of them is mined.
    const reserved = await this.#reservedNonce(intent, ctx);
    if (reserved !== null && Number(pending) > reserved) fail('wallet_nonce_pending', 'A pending wallet transaction uses the saved nonce. Wait until it is mined, then reconcile before sending again');
    const nonce = reserved ?? Number(pending);
    if (intent.execution_generation !== undefined && intent.execution_generation !== this.getGeneration() || this.getMode() !== 'live') fail('execution_context_changed', 'Execution context changed before broadcast');
    assertOperationOpen(NEW_RISK_CAPITAL_OPERATIONS, intent.operation, readiness, paused);
    return this.ledger.checkpointBroadcast(intentId, { nonce, block });
  }

  /** Resolve this wallet's released operations against the chain; the nonce still reserved by them, or null. */
  async #reservedNonce(intent, ctx) {
    const released = (await this.ledger.listIntents({ investor: intent.investor, chainId: intent.protocol_instance.chain_id }))
      .filter((other) => other.status === 'released' && other.intent_id !== intent.intent_id);
    if (!released.length) return null;
    const { read } = this.readPool.budget(2000);
    const latestNonce = Number(await read(() => ctx.provider.getTransactionCount(intent.investor, 'latest')));
    const open = [];
    for (const other of released) {
      if (latestNonce <= other.broadcast_nonce) { open.push(other.broadcast_nonce); continue; }
      // The nonce was used meanwhile: by something else (the operation can never be mined), or by the released
      // operation after all. Then the wallet did send it, and this send must not repeat it without the user seeing so.
      const settled = await this.#resolveConsumedNonce(other, ctx, read);
      if (settled.confirmation_pending) {
        throw Object.assign(new Error('Another transaction used the saved nonce but is not confirmed yet; wait for its confirmations, then reconcile'),
          { code: 'wallet_nonce_unconfirmed', status: 409, expose: true, details: { intent_ids: [other.intent_id] } });
      }
      if (settled.status !== 'superseded') {
        throw Object.assign(new Error('An operation the wallet reported as not sent was mined after all; review it before sending again'),
          { code: 'released_operation_mined', status: 409, expose: true, details: { intent_ids: [other.intent_id] } });
      }
    }
    return open.length ? Math.min(...open) : null;
  }

  /**
   * The saved nonce was consumed: bind the transaction if it is this operation (perhaps re-sent), else supersede it --
   * but only once that other transaction is canonical and deep. Until then the operation keeps its status (and so keeps
   * blocking or reserving), and the result says the confirmation is pending.
   */
  async #resolveConsumedNonce(intent, ctx, read) {
    const latest = await read(() => ctx.provider.getBlockNumber());
    let found;
    try { found = await findNonceTransaction(ctx.provider, read, { from: intent.investor, nonce: intent.broadcast_nonce, fromBlock: intent.prepared_block, latest }); }
    catch (error) {
      if (error?.code === 'nonce_history_unavailable') fail('manual_reconciliation_required', 'This node cannot locate the saved transaction by its nonce; attach its original wallet hash');
      if (error?.code === 'recovery_block_missing' || error?.code === 'recovery_transaction_missing') fail('chain_unavailable', 'A recovery block or transaction is unavailable', 503);
      throw error;
    }
    if (!found) return intent;
    const { hash, tx } = found;
    // A later send of the same call can carry the reserved nonce; then that operation owns the transaction.
    const boundElsewhere = (await this.ledger.listIntents({ investor: intent.investor })).some((other) => other.intent_id !== intent.intent_id && same(other.tx_hash ?? '', hash));
    if (boundElsewhere || !same(tx.to, intent.protocol_instance.pool_address) || !same(tx.data, intent.calldata) || BigInt(tx.value) !== 0n) {
      const receipt = await read(() => ctx.provider.getTransactionReceipt(hash));
      if (!await this.#settled(receipt, ctx, read)) return { ...intent, confirmation_pending: true, nonce_used_by_tx_hash: hash.toLowerCase() };
      return this.ledger.supersedeIntent(intent.intent_id, { by_tx_hash: hash, block_number: receipt.blockNumber, block_hash: receipt.blockHash });
    }
    if (intent.tx_hash && !same(intent.tx_hash, hash)) await this.ledger.replaceTransaction(intent.intent_id, hash, intent.tx_hash);
    return this.attach(intent.intent_id, hash);
  }

  /**
   * The wallet reported that it did not send a checkpointed operation. Nothing here trusts that report alone: a
   * transaction the node still knows keeps the operation open, a consumed nonce is resolved against the chain, and
   * an unused nonce is released but stays reserved for the next send of this wallet (see checkpointBroadcast).
   */
  async releaseIntent(intentId) {
    const intent = await this.ledger.getIntent(intentId);
    if (!intent) fail('invalid_intent', 'Saved transaction not found', 404);
    if (intent.status === 'draft') return this.ledger.abandonIntent(intentId);
    if (!BLOCKING_INTENT_STATUSES.includes(intent.status)) return intent;
    if (intent.broadcast_nonce === undefined) fail('manual_reconciliation_required', 'This operation has no saved nonce; attach its original wallet hash');
    const ctx = await this.context(), { read } = this.readPool.budget(2000);
    if (intent.tx_hash && await read(() => ctx.provider.getTransaction(intent.tx_hash))) {
      if (await read(() => ctx.provider.getTransactionReceipt(intent.tx_hash))) return this.recoverIntent(intentId);
      fail('transaction_pending', 'The wallet transaction is still pending. Speed it up or cancel it in the wallet, then reconcile');
    }
    if (Number(await read(() => ctx.provider.getTransactionCount(intent.investor, 'latest'))) > intent.broadcast_nonce) return this.#resolveConsumedNonce(intent, ctx, read);
    return this.ledger.releaseIntent(intentId);
  }

  /** Operations of one wallet in this instance that still need attention (blocking or holding a reserved nonce). */
  async openIntents(wallet) {
    const pool = this.chainConfig.contracts.RWAOfferingPool;
    return (await this.ledger.listIntents({ investor: wallet, chainId: this.chainConfig.chainIdDecimal }))
      .filter((intent) => same(intent.protocol_instance.pool_address, pool) && [...BLOCKING_INTENT_STATUSES, 'released'].includes(intent.status))
      .map(({ intent_id, operation, chain_pool_id, status, tx_hash, broadcast_nonce, created_at }) => ({ intent_id, operation, chain_pool_id, status, tx_hash: tx_hash ?? null, broadcast_nonce: broadcast_nonce ?? null, created_at }));
  }

  async recoverIntent(intentId) {
    let intent = await this.ledger.getIntent(intentId);
    if (!intent) fail('invalid_intent', 'Saved transaction not found', 404);
    if (intent.status === 'abandoned') return intent;
    const ctx = await this.context(), { read } = this.readPool.budget(2000);
    if (intent.status === 'superseded') {
      // Superseded stays final only while the transaction that took the nonce is still where it was recorded.
      const receipt = await read(() => ctx.provider.getTransactionReceipt(intent.superseded_by_tx_hash));
      if (receipt && (!intent.superseded_block_hash || same(receipt.blockHash, intent.superseded_block_hash)) && await this.#settled(receipt, ctx, read)) return intent;
      intent = await this.ledger.reopenSuperseded(intentId);
    }
    if (intent.tx_hash) {
      if (await read(() => ctx.provider.getTransaction(intent.tx_hash))) return this.attach(intentId, intent.tx_hash);
      // The hash is unknown to the node: dropped, replaced by a re-send with the same nonce, or never propagated.
      if (intent.broadcast_nonce !== undefined && Number(await read(() => ctx.provider.getTransactionCount(intent.investor, 'latest'))) > intent.broadcast_nonce) {
        return this.#resolveConsumedNonce(intent, ctx, read);
      }
      return intent.status === 'released' ? intent : this.ledger.reconcileIntent(intentId, intent.tx_hash);
    }
    if (intent.broadcast_nonce === undefined) return intent;
    const settled = await this.#resolveConsumedNonce(intent, ctx, read);
    return (settled === intent || settled.confirmation_pending) && intent.status !== 'released' ? { ...settled, reconciliation_required: true } : settled;
  }
}
