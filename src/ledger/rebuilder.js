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
    const logs = await provider.getLogs({ address: poolAddress, topics, fromBlock, toBlock });
    const protocolInstance = { chain_id: chainId, pool_address: poolAddress, protocol_version: protocolVersion };

    for (const log of logs) {
      const parsed = iface.parseLog(log);
      if (!parsed) continue;
      await this.#apply(protocolInstance, parsed, log);
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

  async #apply(pi, parsed, log) {
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
    }
  }
}
