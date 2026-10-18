import { Contract, isAddress } from 'ethers';
import { Ledger } from './ledger.js';
import { ChainEventRebuilder } from './rebuilder.js';
import { buildPositionView, balanceKey } from './positionView.js';
import { PROTOCOL_V5_ABI } from '../chain/protocolV5Abi.js';
import { chainStateName } from '../agent/runtime/poolRules.js';
import { RpcReadPool, mapReads, assertSnapshot, snapshotInfo, boundedProvider } from '../rights/reads.js';

const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { code, status, expose: true }); };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Provider-only ledger integration. Signing stays in the user's wallet. */
export class CapitalLedgerService {
  constructor({ ledger, chainConfig, getContext, getMode = () => 'demo', getGeneration = () => 0, readPool = new RpcReadPool(), confirmations = 1 }) {
    Object.assign(this, { ledger, chainConfig, getContext, getMode, getGeneration, readPool, confirmations });
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
    const budget = this.readPool.budget(10000);
    const result = await this.rebuilder.rebuild({ provider: boundedProvider(ctx.provider, budget.read), poolAddress: cfg.contracts.RWAOfferingPool,
      chainId: cfg.chainIdDecimal, protocolVersion: 5,
      fromBlock: cfg.deployments?.RWAOfferingPool?.blockNumber ?? 0, confirmations: this.confirmations });
    return { ...result, context: ctx, sync_read_metrics: budget.stats };
  }

  async list(wallet, demoInvestments = [], query = {}) {
    const chainPositions = new Map(), budget = this.readPool.budget(200), { read } = budget;
    let syncError = null, snapshot = null, nextCursor = null, total = null, ledgerAtSnapshot = null;
    const failures = [], from = query.from ?? 1, limit = query.limit ?? 20;
    try {
      if (Number(this.chainConfig?.protocolVersion) === 5) {
        const { positions, cursor, context } = await this.sync();
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
      .map((position) => ({ ...position, recovery_rights_retained: position.mode === 'live' && this.chainConfig?.controlVersion === 2 }));
    return { wallet: wallet.toLowerCase(), positions, complete: !syncError && failures.length === 0 && positions.every((pos) => pos.mode !== 'live' || pos.reconciled),
      failures, next_cursor: nextCursor, from, limit, total_pools: total, snapshot, read_metrics: budget.stats,
      ...(syncError || failures.length ? { warning: syncError ?? 'partial_position_reads' } : {}) };
  }

  async prepareSubscription({ wallet, chain_pool_id: poolId, shares, max_unit_price: maxPrice, expected_quote_version: expectedVersion, deadline, reviewed_disclosure_hash: disclosureHash, authorization_subject, authorization_session }) {
    const generation = this.getGeneration();
    if (this.chainConfig?.controlVersion === 1) fail('legacy_exit_only', 'This instance accepts existing exits only');
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
    return this.ledger.getIntent(intentId);
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

  async checkpointBroadcast(intentId) {
    if (this.getMode() !== 'live') fail('live_mode_required', 'Switch to Live before preparing a wallet transaction');
    const intent = await this.ledger.getIntent(intentId), ctx = await this.context();
    if (!intent || !same(intent.protocol_instance.pool_address, this.chainConfig.contracts.RWAOfferingPool)
      || Number(intent.protocol_instance.chain_id) !== Number(this.chainConfig.chainIdDecimal)) fail('invalid_intent', 'Intent belongs to another protocol');
    if (intent.execution_generation !== undefined && intent.execution_generation !== this.getGeneration()) fail('execution_context_changed', 'Execution mode changed; prepare and review a new draft');
    await ctx.provider.call({ from: intent.investor, to: intent.protocol_instance.pool_address, data: intent.calldata, value: 0n });
    const [nonce, block] = await Promise.all([ctx.provider.getTransactionCount(intent.investor, 'pending'), ctx.provider.getBlockNumber()]);
    if (intent.execution_generation !== undefined && intent.execution_generation !== this.getGeneration() || this.getMode() !== 'live') fail('execution_context_changed', 'Execution context changed before broadcast');
    return this.ledger.checkpointBroadcast(intentId, { nonce, block });
  }

  async recoverIntent(intentId) {
    const intent = await this.ledger.getIntent(intentId);
    if (!intent) fail('invalid_intent', 'Saved transaction not found', 404);
    const ctx = await this.context(), { read } = this.readPool.budget(2000);
    if (intent.tx_hash) {
      if (!await read(() => ctx.provider.getTransaction(intent.tx_hash))) return this.ledger.reconcileIntent(intentId, intent.tx_hash);
      return this.attach(intentId, intent.tx_hash);
    }
    if (intent.broadcast_nonce === undefined) return intent;
    const latest = await read(() => ctx.provider.getBlockNumber());
    if (latest - intent.prepared_block > 500) fail('manual_reconciliation_required', 'Saved transaction is outside the bounded scan; attach its original wallet hash');
    for (let n = intent.prepared_block; n <= latest; n++) {
      const block = await read(() => ctx.provider.getBlock(n, true)); if (!block) fail('chain_unavailable', 'A recovery block is unavailable', 503);
      for (const hash of block.transactions) {
        const tx = await read(() => ctx.provider.getTransaction(hash)); if (!tx) fail('chain_unavailable', 'A recovery transaction is unavailable', 503);
        if (!same(tx.from, intent.investor) || tx.nonce !== intent.broadcast_nonce) continue;
        if (!same(tx.to, intent.protocol_instance.pool_address) || !same(tx.data, intent.calldata) || tx.value !== 0n) fail('nonce_consumed_by_other_transaction', 'Another transaction used the saved nonce; reconcile in the wallet');
        return this.attach(intentId, hash);
      }
    }
    return { ...intent, reconciliation_required: true };
  }
}
