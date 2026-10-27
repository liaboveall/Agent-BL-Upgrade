import crypto from 'node:crypto';
import { LedgerWriter } from './writer.js';

const POSITION_KINDS = new Set(['INVESTOR_DEPOSIT', 'REFUND', 'CLAIM']);
const money = (value) => {
  const text = String(value ?? '0');
  if (!/^\d+$/u.test(text)) throw new Error('Ledger amounts must be unsigned atomic integers');
  return text;
};
const lower = (value) => value == null ? undefined : String(value).toLowerCase();

export class Ledger {
  constructor({ baseDir, writer = new LedgerWriter(baseDir) }) { this.writer = writer; }

  static protocolInstanceKey({ chain_id, pool_address, protocol_version }) {
    return `${chain_id}:${pool_address.toLowerCase()}:${protocol_version}`;
  }

  static activeEntries(entries) {
    const voided = new Set(entries.flatMap((entry) => entry.voided_entry_ids ?? []));
    return entries.filter((entry) => entry.kind !== 'CHAIN_REORG' && !voided.has(entry.entry_id));
  }

  static sourceKey(entry) {
    return entry.source ? `${Ledger.protocolInstanceKey(entry.protocol_instance)}:${lower(entry.source.tx_hash)}:${entry.source.log_index}` : null;
  }

  static project(entries) {
    const positions = {};
    for (const event of Ledger.activeEntries(entries)) Ledger.applyPosition(positions, event);
    return positions;
  }

  /** Fold one active entry into `positions`. Throws before changing anything, so it also validates the entry. */
  static applyPosition(positions, event) {
    if (!POSITION_KINDS.has(event.kind)) return positions;
    const investor = lower(event.investor ?? (event.kind === 'INVESTOR_DEPOSIT' ? event.from : event.to));
    if (!investor) throw new Error('Investor missing from position event');
    const key = `${Ledger.protocolInstanceKey(event.protocol_instance)}:${event.chain_pool_id}:${investor}`;
    const pos = positions[key] ? { ...positions[key] } : {
      position_id: key, protocol_instance: event.protocol_instance, chain_pool_id: event.chain_pool_id,
      investor, asset: lower(event.asset), shares: '0', cost_atomic: '0', claimed_atomic: '0', refunded_atomic: '0', status: 'active'
    };
    if (pos.asset !== lower(event.asset)) throw new Error('Position settlement asset changed');
    if (event.kind === 'INVESTOR_DEPOSIT') {
      pos.shares = String(BigInt(pos.shares) + BigInt(money(event.shares)));
      pos.cost_atomic = String(BigInt(pos.cost_atomic) + BigInt(money(event.amount_atomic)));
      pos.status = 'active';
    } else if (event.kind === 'REFUND') {
      pos.refunded_atomic = String(BigInt(pos.refunded_atomic) + BigInt(money(event.amount_atomic)));
      pos.shares = '0';
      pos.status = 'refunded';
    } else {
      const shares = BigInt(pos.shares) - BigInt(money(event.shares));
      if (shares < 0n) throw new Error('Claim exceeds recorded shares; rebuild the complete history');
      pos.shares = String(shares);
      pos.claimed_atomic = String(BigInt(pos.claimed_atomic) + BigInt(money(event.amount_atomic)));
      if (shares === 0n) pos.status = 'fully_claimed';
    }
    positions[key] = pos;
    return positions;
  }

  async recordIntent(input) {
    return this.writer.exclusive(async () => {
      const intent = { ...input, intent_id: crypto.randomUUID(),
        investor: lower(input.investor), asset: lower(input.asset),
        amount_atomic: money(input.amount_atomic), shares: input.shares == null ? undefined : money(input.shares),
        status: 'draft', created_at: new Date().toISOString() };
      await this.writer.appendIntent(intent);
      return intent;
    });
  }

  async getIntent(intentId) {
    const rows = await this.writer.readIntents((row) => row.intent_id === intentId);
    return rows.length ? Object.assign({}, ...rows) : null;
  }

  async #updateIntent(intentId, status, txHash, extra = {}) {
    return this.writer.exclusive(async () => {
      const intent = await this.getIntent(intentId);
      if (!intent) throw new Error('intent not found');
      if (!/^0x[0-9a-f]{64}$/iu.test(txHash)) throw new Error('invalid transaction hash');
      const occupied = await this.writer.readIntents((row) => row.tx_hash && lower(row.tx_hash) === lower(txHash) && row.intent_id !== intentId);
      if (occupied.length) throw new Error('Transaction already bound to another intent');
      if (intent.tx_hash && lower(intent.tx_hash) !== lower(txHash)) throw new Error('Intent already bound to another transaction; reconcile before retrying');
      if (intent.status === 'confirmed' && status === 'broadcast') return intent;
      const updated = { ...intent, ...extra, status, tx_hash: lower(txHash), [`${status}_at`]: new Date().toISOString() };
      await this.writer.appendIntent(updated);
      return updated;
    });
  }

  markBroadcast(intentId, txHash) { return this.#updateIntent(intentId, 'broadcast', txHash); }
  checkpointBroadcast(intentId, checkpoint) {
    return this.writer.exclusive(async () => {
      const intent = await this.getIntent(intentId);
      if (!intent || intent.tx_hash || intent.broadcast_nonce !== undefined) throw new Error('Intent already has a broadcast checkpoint; reconcile it before another send');
      const history = await this.writer.readIntents();
      const latest = new Map(); for (const row of history) latest.set(row.intent_id, { ...latest.get(row.intent_id), ...row });
      if ([...latest.values()].some((other) => other.intent_id !== intentId && lower(other.investor) === lower(intent.investor)
        && Number(other.protocol_instance?.chain_id) === Number(intent.protocol_instance.chain_id)
        && ['broadcast_prepared', 'broadcast', 'reconciliation_required'].includes(other.status))) throw Object.assign(new Error('Reconcile the saved wallet operation before another send'), { code: 'wallet_reconciliation_required', status: 409, expose: true });
      if (!Number.isSafeInteger(checkpoint.nonce) || checkpoint.nonce < 0 || !Number.isSafeInteger(checkpoint.block) || checkpoint.block < 0) throw new Error('Invalid broadcast checkpoint');
      const updated = { ...intent, status: 'broadcast_prepared', broadcast_nonce: checkpoint.nonce, prepared_block: checkpoint.block };
      await this.writer.appendIntent(updated); return updated;
    });
  }
  confirmIntent(intentId, txHash, blockNumber) { return this.#updateIntent(intentId, 'confirmed', txHash, { block_number: Number(blockNumber) }); }
  reconcileIntent(intentId, txHash) { return this.#updateIntent(intentId, 'reconciliation_required', txHash); }

  #entry(input) {
    return { ...input, entry_id: crypto.randomUUID(),
      asset: lower(input.asset), from: lower(input.from), to: lower(input.to), investor: lower(input.investor),
      amount_atomic: money(input.amount_atomic), shares: input.shares == null ? undefined : money(input.shares),
      source: input.source ? { ...input.source, tx_hash: lower(input.source.tx_hash), log_index: Number(input.source.log_index) } : undefined,
      occurred_at: input.occurred_at ?? new Date().toISOString() };
  }

  async applyEvents(events, { cursor, voidedEntryIds = [], expectedCursor } = {}) {
    return this.writer.exclusive(async () => {
      if (cursor && expectedCursor !== undefined) {
        const current = (await this.writer.readCursor())[Ledger.protocolInstanceKey(cursor.protocol_instance)] ?? null;
        if (JSON.stringify(current) !== JSON.stringify(expectedCursor)) throw new Error('Ledger cursor changed during replay; retry from the new checkpoint');
      }
      const history = await this.writer.readCashEntries();
      if (voidedEntryIds.length) {
        const marker = { entry_id: crypto.randomUUID(), kind: 'CHAIN_REORG', voided_entry_ids: voidedEntryIds, occurred_at: new Date().toISOString() };
        await this.writer.appendCashEntry(marker);
        history.push(marker);
      }
      const seen = new Map(Ledger.activeEntries(history).filter((entry) => entry.source).map((entry) => [Ledger.sourceKey(entry), entry]));
      // New entries cannot be voided by markers already in the history, so the projection is extended one
      // entry at a time instead of re-projecting the complete history for every event.
      const positions = Ledger.project(history);
      const additions = [];
      for (const event of events) {
        const entry = this.#entry(event), key = Ledger.sourceKey(entry);
        if (key && seen.has(key)) {
          const old = seen.get(key);
          for (const field of ['kind', 'asset', 'from', 'to', 'amount_atomic', 'shares', 'chain_pool_id']) {
            if (old[field] !== entry[field]) throw new Error('Conflicting chain event; reconciliation required');
          }
          continue;
        }
        // Validate the projection before committing the fact.
        Ledger.applyPosition(positions, entry);
        await this.writer.appendCashEntry(entry);
        history.push(entry); additions.push(entry);
        if (key) seen.set(key, entry);
      }
      await this.writer.writePositions(positions);
      if (cursor) {
        const cursors = await this.writer.readCursor();
        await this.writer.writeCursor({ ...cursors, [Ledger.protocolInstanceKey(cursor.protocol_instance)]: cursor });
      }
      return { entries: additions, positions: Object.values(positions) };
    });
  }

  async applyEvent(event) {
    const result = await this.applyEvents([event]);
    const investor = lower(event.investor ?? (event.kind === 'INVESTOR_DEPOSIT' ? event.from : event.to));
    return { entry: result.entries[0], position: POSITION_KINDS.has(event.kind) ? result.positions.find((pos) =>
      pos.investor === investor && pos.chain_pool_id === event.chain_pool_id && Ledger.protocolInstanceKey(pos.protocol_instance) === Ledger.protocolInstanceKey(event.protocol_instance)) : undefined };
  }

  recordCashEntry(event) { return this.applyEvent(event).then((result) => result.entry); }

  async listPositions(protocolInstance) {
    return this.writer.exclusive(async () => {
      const positions = Ledger.project(await this.writer.readCashEntries());
      await this.writer.writePositions(positions);
      return Object.values(positions).filter((pos) => !protocolInstance || Ledger.protocolInstanceKey(pos.protocol_instance) === Ledger.protocolInstanceKey(protocolInstance));
    });
  }

  async rebuildFromEvents(events) {
    await this.applyEvents(events);
    return Object.fromEntries((await this.listPositions()).map((pos) => [pos.position_id, pos]));
  }
}
