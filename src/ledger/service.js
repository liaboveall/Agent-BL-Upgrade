import { Contract, isAddress } from 'ethers';
import { ChainEventRebuilder } from './rebuilder.js';
import { buildPositionView, balanceKey } from './positionView.js';
import { PROTOCOL_V5_ABI } from '../chain/protocolV5Abi.js';
import { chainStateName } from '../agent/runtime/poolRules.js';

const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { code, status, expose: true }); };
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Provider-only ledger integration. Signing stays in the user's wallet. */
export class CapitalLedgerService {
  constructor({ ledger, chainConfig, getContext, getMode = () => 'demo', confirmations = 1 }) {
    Object.assign(this, { ledger, chainConfig, getContext, getMode, confirmations });
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
    const result = await this.rebuilder.rebuild({ provider: ctx.provider, poolAddress: cfg.contracts.RWAOfferingPool,
      chainId: cfg.chainIdDecimal, protocolVersion: 5,
      fromBlock: cfg.deployments?.RWAOfferingPool?.blockNumber ?? 0, confirmations: this.confirmations });
    return { ...result, context: ctx };
  }

  async list(wallet, demoInvestments = []) {
    const chainPositions = new Map();
    let syncError = null;
    if (Number(this.chainConfig?.protocolVersion) === 5) {
      try {
        const { positions, cursor, context } = await this.sync();
        if (!cursor) throw new Error('No confirmed ledger checkpoint');
        const cfg = this.chainConfig;
        const token = new Contract(cfg.contracts.RWAToken, ['function balanceOf(uint256,address) view returns (uint256)'], context.provider);
        const ids = new Set(positions.filter((pos) => same(pos.investor, wallet)).map((pos) => pos.chain_pool_id));
        // Discover balances even if the local ledger was empty or lost. Scanning is bounded by
        // the number of pools created by this configured instance, without inferring their cost.
        const poolReader = new Contract(cfg.contracts.RWAOfferingPool, ['function nextPoolId() view returns (uint256)'], context.provider);
        const next = Number(await poolReader.nextPoolId({ blockTag: cursor.last_block }));
        if (!Number.isSafeInteger(next) || next > 10_001) throw new Error('Pool discovery exceeds the local ledger limit');
        for (let id = 1; id < next; id++) ids.add(id);
        for (const id of ids) {
          const options = { blockTag: cursor.last_block };
          const [shares, claimable, offering] = await Promise.all([token.balanceOf(id, wallet, options), context.pool.claimable(id, wallet, options), context.pool.offerings(id, options)]);
          const pi = cursor.protocol_instance;
          chainPositions.set(balanceKey(pi, id), { protocol_instance: pi, chain_pool_id: id, asset: offering.settlementAsset,
            shares: String(shares), claimable_atomic: String(claimable), state: chainStateName(offering.state), block_number: cursor.last_block, canonical: true });
        }
        const block = await context.provider.getBlock(cursor.last_block);
        if (!block || !same(block.hash, cursor.last_block_hash)) throw new Error('Position checkpoint reorganized');
      } catch { chainPositions.clear(); syncError = 'chain_reconciliation_required'; }
    }
    return { wallet: wallet.toLowerCase(), positions: buildPositionView({ wallet, demoInvestments,
      ledgerPositions: await this.ledger.listPositions(), chainPositions }), ...(syncError ? { warning: syncError } : {}) };
  }

  async prepareSubscription({ wallet, chain_pool_id: poolId, shares, max_unit_price: maxPrice, expected_quote_version: expectedVersion, deadline }) {
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
    return this.ledger.recordIntent({ protocol_instance: { chain_id: Number(cfg.chainIdDecimal), pool_address: cfg.contracts.RWAOfferingPool.toLowerCase(), protocol_version: 5 },
      chain_pool_id: Number(poolId), operation: 'SUBSCRIBE', investor: wallet, asset: offering.settlementAsset, amount_atomic: String(offering.issuePrice * BigInt(shares)), shares: String(shares), calldata });
  }

  async prepareClaim({ wallet, chain_pool_id: poolId }) {
    if (this.getMode() !== 'live') fail('live_mode_required', 'Switch to Live before preparing a wallet transaction');
    if (!isAddress(wallet) || !Number.isSafeInteger(Number(poolId)) || Number(poolId) < 1) fail('invalid_claim', 'A wallet and pool are required', 400);
    const ctx = await this.context(), cfg = this.chainConfig;
    const token = new Contract(cfg.contracts.RWAToken, ['function balanceOf(uint256,address) view returns (uint256)'], ctx.provider);
    const [offering, shares, amount] = await Promise.all([ctx.pool.offerings(poolId), token.balanceOf(poolId, wallet), ctx.pool.claimable(poolId, wallet)]);
    if (!offering.exists || ![9, 14].includes(Number(offering.state)) || shares === 0n) fail('position_not_claimable', 'No terminal position to claim');
    await ctx.pool.claim.staticCall(poolId, { from: wallet });
    return this.ledger.recordIntent({ protocol_instance: { chain_id: Number(cfg.chainIdDecimal), pool_address: cfg.contracts.RWAOfferingPool.toLowerCase(), protocol_version: 5 },
      chain_pool_id: Number(poolId), operation: 'CLAIM', investor: wallet, asset: offering.settlementAsset,
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

  async prepareRefund({ wallet, chain_pool_id: poolId }) {
    if (this.getMode() !== 'live') fail('live_mode_required', 'Switch to Live before preparing a wallet transaction');
    if (!isAddress(wallet) || !Number.isSafeInteger(Number(poolId)) || Number(poolId) < 1) fail('invalid_refund', 'A wallet and pool are required', 400);
    const ctx = await this.context(), cfg = this.chainConfig;
    const offering = await ctx.pool.offerings(poolId);
    await ctx.pool.refundInvestor.staticCall(poolId, wallet, { from: wallet });
    const amount = await ctx.pool.investorPaid(poolId, offering.settlementAsset, wallet);
    const token = new Contract(cfg.contracts.RWAToken, ['function balanceOf(uint256,address) view returns (uint256)'], ctx.provider);
    return this.ledger.recordIntent({ protocol_instance: { chain_id: Number(cfg.chainIdDecimal), pool_address: cfg.contracts.RWAOfferingPool.toLowerCase(), protocol_version: 5 },
      chain_pool_id: Number(poolId), operation: 'REFUND', investor: wallet, asset: offering.settlementAsset, amount_atomic: String(amount),
      shares: String(await token.balanceOf(poolId, wallet)), calldata: ctx.pool.interface.encodeFunctionData('refundInvestor', [poolId, wallet]) });
  }

  async checkpointBroadcast(intentId) {
    if (this.getMode() !== 'live') fail('live_mode_required', 'Switch to Live before preparing a wallet transaction');
    const intent = await this.ledger.getIntent(intentId), ctx = await this.context();
    if (!intent || !same(intent.protocol_instance.pool_address, this.chainConfig.contracts.RWAOfferingPool)
      || Number(intent.protocol_instance.chain_id) !== Number(this.chainConfig.chainIdDecimal)) fail('invalid_intent', 'Intent belongs to another protocol');
    await ctx.provider.call({ from: intent.investor, to: intent.protocol_instance.pool_address, data: intent.calldata, value: 0n });
    const [nonce, block] = await Promise.all([ctx.provider.getTransactionCount(intent.investor, 'pending'), ctx.provider.getBlockNumber()]);
    return this.ledger.checkpointBroadcast(intentId, { nonce, block });
  }

  async recoverIntent(intentId) {
    const intent = await this.ledger.getIntent(intentId);
    if (!intent) fail('invalid_intent', 'Saved transaction not found', 404);
    const ctx = await this.context();
    if (intent.tx_hash) {
      if (!await ctx.provider.getTransaction(intent.tx_hash)) return this.ledger.reconcileIntent(intentId, intent.tx_hash);
      return this.attach(intentId, intent.tx_hash);
    }
    if (intent.broadcast_nonce === undefined) return intent;
    const latest = await ctx.provider.getBlockNumber();
    if (latest - intent.prepared_block > 500) fail('manual_reconciliation_required', 'Saved transaction is outside the bounded scan; attach its original wallet hash');
    for (let n = intent.prepared_block; n <= latest; n++) {
      const block = await ctx.provider.getBlock(n, true); if (!block) fail('chain_unavailable', 'A recovery block is unavailable', 503);
      for (const hash of block.transactions) {
        const tx = await ctx.provider.getTransaction(hash); if (!tx) fail('chain_unavailable', 'A recovery transaction is unavailable', 503);
        if (!same(tx.from, intent.investor) || tx.nonce !== intent.broadcast_nonce) continue;
        if (!same(tx.to, intent.protocol_instance.pool_address) || !same(tx.data, intent.calldata) || tx.value !== 0n) fail('nonce_consumed_by_other_transaction', 'Another transaction used the saved nonce; reconcile in the wallet');
        return this.attach(intentId, hash);
      }
    }
    return { ...intent, reconciliation_required: true };
  }
}
