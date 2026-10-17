import { Interface } from 'ethers';
import { PROTOCOL_V5_ABI } from '../chain/protocolV5Abi.js';

const POOL_EVENTS = [
  'Subscribed', 'FundEscrowed', 'DisbursedToExporter', 'InvestorRefunded',
  'Claimed', 'FeeDeducted', 'LiquidationRecoveryRecorded', 'AdditionalPaymentRecorded'
];

export class ChainEventRebuilder {
  constructor(ledger) {
    this.ledger = ledger;
  }

  async rebuild({ provider, poolAddress, chainId, protocolVersion, fromBlock, toBlock }) {
    const iface = new Interface(PROTOCOL_V5_ABI.RWAOfferingPool);
    const topics = [POOL_EVENTS.map((e) => iface.getEvent(e).topicHash)];

    const [logs, existingEntries] = await Promise.all([
      provider.getLogs({ address: poolAddress, topics, fromBlock, toBlock }),
      this.ledger.writer.readCashEntries()
    ]);

    const seen = new Set(
      existingEntries
        .filter((e) => e.source)
        .map((e) => `${e.source.tx_hash}:${e.source.log_index}`)
    );

    const protocolInstance = { chain_id: chainId, pool_address: poolAddress, protocol_version: protocolVersion };
    const assetCache = new Map();

    for (const log of logs) {
      const logIndex = Number(log.index ?? log.logIndex);
      const sourceKey = `${log.transactionHash}:${logIndex}`;
      if (seen.has(sourceKey)) continue;

      const parsed = iface.parseLog(log);
      if (!parsed) continue;

      let asset;
      if (parsed.name === 'LiquidationRecoveryRecorded' || parsed.name === 'AdditionalPaymentRecorded') {
        asset = await this.#settlementAsset(provider, poolAddress, iface, Number(parsed.args.poolId), assetCache);
      }

      await this.#apply(protocolInstance, parsed, log, asset);
      seen.add(sourceKey);
    }

    const cursor = {
      chain_id: chainId,
      pool_address: poolAddress,
      protocol_version: protocolVersion,
      last_block: toBlock
    };
    await this.ledger.writer.writeCursor(cursor);

    const positions = await this.ledger.listPositions(protocolInstance);
    return { positions, cursor };
  }

  async #settlementAsset(provider, poolAddress, iface, poolId, cache) {
    if (cache.has(poolId)) return cache.get(poolId);
    const data = iface.encodeFunctionData('offerings', [poolId]);
    const result = await provider.call({ to: poolAddress, data });
    const decoded = iface.decodeFunctionResult('offerings', result);
    const asset = decoded[8].toLowerCase();
    cache.set(poolId, asset);
    return asset;
  }

  async #apply(pi, parsed, log, asset) {
    const base = {
      protocol_instance: pi,
      chain_pool_id: Number(parsed.args.poolId),
      block_number: Number(log.blockNumber)
    };
    const source = {
      tx_hash: log.transactionHash,
      log_index: Number(log.index ?? log.logIndex)
    };

    if (parsed.name === 'FundEscrowed') {
      await this.ledger.applyEvent({
        ...base,
        kind: 'INVESTOR_DEPOSIT',
        asset: parsed.args.asset,
        from: parsed.args.investor,
        to: pi.pool_address,
        amount_atomic: String(parsed.args.amountAtomic),
        shares: String(parsed.args.shares),
        source
      });
    } else if (parsed.name === 'InvestorRefunded') {
      await this.ledger.applyEvent({
        ...base,
        kind: 'REFUND',
        asset: parsed.args.asset,
        to: parsed.args.investor,
        amount_atomic: String(parsed.args.amountAtomic),
        source
      });
    } else if (parsed.name === 'Claimed') {
      await this.ledger.applyEvent({
        ...base,
        kind: 'CLAIM',
        asset: parsed.args.asset,
        to: parsed.args.investor,
        amount_atomic: String(parsed.args.amountAtomic),
        shares: String(parsed.args.sharesBurned),
        source
      });
    } else if (parsed.name === 'DisbursedToExporter') {
      await this.ledger.applyEvent({
        ...base,
        kind: 'DISBURSEMENT',
        asset: parsed.args.asset,
        from: pi.pool_address,
        amount_atomic: String(parsed.args.amountAtomic),
        source
      });
    } else if (parsed.name === 'FeeDeducted') {
      await this.ledger.applyEvent({
        ...base,
        kind: 'FEE',
        asset: parsed.args.asset,
        from: pi.pool_address,
        amount_atomic: String(parsed.args.feeAtomic),
        source
      });
    } else if (parsed.name === 'LiquidationRecoveryRecorded' || parsed.name === 'AdditionalPaymentRecorded') {
      await this.ledger.applyEvent({
        ...base,
        kind: 'RECOVERY',
        asset,
        amount_atomic: String(parsed.args.amount),
        evidence_hash: parsed.args.paymentProof,
        source
      });
    }
  }
}
