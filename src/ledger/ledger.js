import crypto from 'node:crypto';
import { LedgerWriter } from './writer.js';

export class Ledger {
  constructor({ baseDir, writer = new LedgerWriter(baseDir) }) {
    this.writer = writer;
  }

  static protocolInstanceKey({ chain_id, pool_address, protocol_version }) {
    return `${chain_id}:${pool_address.toLowerCase()}:${protocol_version}`;
  }

  async recordIntent({ protocol_instance, chain_pool_id, operation, investor, asset, amount_atomic, shares, calldata }) {
    const intent = {
      intent_id: crypto.randomUUID(),
      protocol_instance,
      chain_pool_id,
      operation,
      investor,
      asset: asset.toLowerCase(),
      amount_atomic: String(amount_atomic),
      shares: shares == null ? undefined : String(shares),
      calldata,
      status: 'draft',
      created_at: new Date().toISOString()
    };
    await this.writer.appendIntent(intent);
    return intent;
  }

  async markBroadcast(intentId, txHash) {
    const intents = await this.writer.readIntents((i) => i.intent_id === intentId);
    if (intents.length === 0) throw new Error('intent not found');
    const updated = { ...intents[0], status: 'broadcast', tx_hash: txHash.toLowerCase(), broadcast_at: new Date().toISOString() };
    await this.writer.appendIntent(updated);
  }

  async confirmIntent(intentId, txHash, blockNumber) {
    const updated = {
      intent_id: intentId,
      status: 'confirmed',
      tx_hash: txHash.toLowerCase(),
      block_number: Number(blockNumber),
      confirmed_at: new Date().toISOString()
    };
    await this.writer.appendIntent(updated);
  }

  async recordCashEntry({ intent_id, protocol_instance, chain_pool_id, kind, asset, from, to, amount_atomic, shares, source, evidence_hash, block_number }) {
    const entry = {
      entry_id: crypto.randomUUID(),
      intent_id,
      protocol_instance,
      chain_pool_id,
      kind,
      asset: asset.toLowerCase(),
      from: from?.toLowerCase(),
      to: to?.toLowerCase(),
      amount_atomic: String(amount_atomic),
      shares: shares == null ? undefined : String(shares),
      source: source ? { tx_hash: source.tx_hash.toLowerCase(), log_index: Number(source.log_index) } : undefined,
      evidence_hash,
      block_number: Number(block_number),
      occurred_at: new Date().toISOString()
    };
    await this.writer.appendCashEntry(entry);
    return entry;
  }

  async listPositions(protocolInstance) {
    const positions = await this.writer.readPositions();
    if (!protocolInstance) return Object.values(positions);
    const key = Ledger.protocolInstanceKey(protocolInstance);
    return Object.values(positions).filter((p) => Ledger.protocolInstanceKey(p.protocol_instance) === key);
  }

  async rebuildFromEvents(events) {
    const positions = {};
    for (const event of events) {
      const key = `${Ledger.protocolInstanceKey(event.protocol_instance)}:${event.chain_pool_id}:${event.investor.toLowerCase()}`;
      const pos = positions[key] ?? {
        position_id: crypto.randomUUID(),
        protocol_instance: event.protocol_instance,
        chain_pool_id: event.chain_pool_id,
        investor: event.investor.toLowerCase(),
        asset: event.asset.toLowerCase(),
        shares: '0',
        cost_atomic: '0',
        claimed_atomic: '0',
        status: 'active'
      };
      if (event.kind === 'INVESTOR_DEPOSIT') {
        pos.shares = (BigInt(pos.shares) + BigInt(event.shares)).toString();
        pos.cost_atomic = (BigInt(pos.cost_atomic) + BigInt(event.amount_atomic)).toString();
      } else if (event.kind === 'REFUND') {
        pos.status = 'refunded';
        pos.cost_atomic = '0';
        pos.shares = '0';
      } else if (event.kind === 'CLAIM') {
        pos.claimed_atomic = (BigInt(pos.claimed_atomic) + BigInt(event.amount_atomic)).toString();
        pos.shares = (BigInt(pos.shares) - BigInt(event.shares)).toString();
        if (pos.shares === '0') pos.status = 'fully_claimed';
      }
      positions[key] = pos;
    }
    await this.writer.writePositions(positions);
    return positions;
  }
}
