import { Contract, Interface } from 'ethers';
import { PROTOCOL_V5_ABI } from '../chain/protocolV5Abi.js';
import { Ledger } from './ledger.js';
import { createWriteQueue } from '../lib/jsonStore.js';

const EVENTS = ['FundEscrowed', 'DisbursedToExporter', 'InvestorRefunded', 'Claimed', 'FeeDeducted', 'RepaymentReceived'];
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const number = (value) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid chain block or log index');
  return result;
};

export class ChainEventRebuilder {
  constructor(ledger) { this.ledger = ledger; this.queue = createWriteQueue(); }

  rebuild(options) { return this.queue(() => this.#rebuild(options)); }

  async #rebuild({ provider, poolAddress, chainId, protocolVersion = 5, fromBlock = 0, toBlock = 'latest', confirmations = 1, forceReplay = false }) {
    if (Number(protocolVersion) !== 5) throw new Error('Capital ledger requires protocol v5');
    if (number(confirmations) < 1) throw new Error('At least one confirmation is required');
    const network = await provider.getNetwork();
    if (BigInt(network.chainId) !== BigInt(chainId)) throw new Error('Ledger chain identity mismatch');
    if (provider.send && BigInt(await provider.send('eth_chainId', [])) !== BigInt(chainId)) throw new Error('Ledger RPC chain identity mismatch');
    const pi = { chain_id: Number(chainId), pool_address: poolAddress.toLowerCase(), protocol_version: 5 };
    const key = Ledger.protocolInstanceKey(pi);
    const cursors = await this.ledger.writer.readCursor();
    const previous = cursors[key];
    const history = Ledger.activeEntries(await this.ledger.writer.readCashEntries());
    const instanceHistory = history.filter((entry) => Ledger.protocolInstanceKey(entry.protocol_instance) === key);
    const latest = number(await provider.getBlockNumber());
    const confirmed = latest - number(confirmations) + 1;
    const end = toBlock === 'latest' ? confirmed : Math.min(number(toBlock), confirmed);
    if (end < 0) return { positions: [], cursor: previous ?? null };
    const start = Math.min(number(fromBlock), previous?.start_block ?? number(fromBlock));
    const iface = new Interface(PROTOCOL_V5_ABI.RWAOfferingPool);
    const version = iface.decodeFunctionResult('protocolVersion', await provider.call({ to: poolAddress, data: iface.encodeFunctionData('protocolVersion') }))[0];
    if (Number(version) !== 5) throw new Error('Ledger pool protocol identity mismatch');
    const checkpoint = await provider.getBlock(end);
    if (!checkpoint?.hash) throw new Error('Confirmed block unavailable');
    let reorg = Boolean(forceReplay || previous?.entry_count !== undefined && previous.entry_count !== instanceHistory.length);
    if (previous) {
      const old = await provider.getBlock(previous.last_block);
      reorg ||= previous.last_block > end || !old || !same(old.hash, previous.last_block_hash);
    }
    // Replay the checkpoint block so a crash after appending a fact repairs its projection.
    const scanFrom = reorg || !previous ? start : Math.max(start, Math.min(end, previous.last_block));
    const logs = [];
    for (let from = scanFrom; from <= end; from += 2000) {
      logs.push(...await provider.getLogs({ address: poolAddress, topics: [EVENTS.map((name) => iface.getEvent(name).topicHash)], fromBlock: from, toBlock: Math.min(end, from + 1999) }));
    }
    logs.sort((a, b) => a.blockNumber - b.blockNumber || number(a.index ?? a.logIndex) - number(b.index ?? b.logIndex));
    const blocks = new Map([[end, checkpoint]]), transactions = new Map(), entries = [];
    for (const log of logs) {
      if (!same(log.address, poolAddress) || log.removed || number(log.blockNumber) < scanFrom || log.blockNumber > end) throw new Error('Invalid ledger log');
      if (!blocks.has(log.blockNumber)) blocks.set(log.blockNumber, await provider.getBlock(log.blockNumber));
      if (!blocks.get(log.blockNumber)?.hash || !same(log.blockHash, blocks.get(log.blockNumber).hash)) throw new Error('Ledger log was reorganized');
      const parsed = iface.parseLog(log);
      if (!parsed || !EVENTS.includes(parsed.name)) throw new Error('Unexpected capital event');
      const base = { protocol_instance: pi, chain_pool_id: number(parsed.args.poolId), asset: parsed.args.asset,
        block_number: number(log.blockNumber), block_hash: log.blockHash.toLowerCase(),
        source: { tx_hash: log.transactionHash, log_index: number(log.index ?? log.logIndex) },
        occurred_at: new Date(number(blocks.get(log.blockNumber).timestamp) * 1000).toISOString() };
      const args = parsed.args;
      if (parsed.name === 'FundEscrowed') entries.push({ ...base, kind: 'INVESTOR_DEPOSIT', from: args.investor, to: poolAddress, amount_atomic: String(args.amountAtomic), shares: String(args.shares) });
      if (parsed.name === 'InvestorRefunded') entries.push({ ...base, kind: 'REFUND', from: poolAddress, to: args.investor, amount_atomic: String(args.amountAtomic) });
      if (parsed.name === 'Claimed') entries.push({ ...base, kind: 'CLAIM', from: poolAddress, to: args.investor, amount_atomic: String(args.amountAtomic), shares: String(args.sharesBurned) });
      if (parsed.name === 'RepaymentReceived') entries.push({ ...base, kind: 'RECOVERY', from: args.payer, to: poolAddress, amount_atomic: String(args.amountAtomic) });
      if (parsed.name === 'DisbursedToExporter' || parsed.name === 'FeeDeducted') {
        const tx = await provider.getTransaction(log.transactionHash);
        const decoded = tx && iface.parseTransaction(tx);
        if (!decoded || !same(tx.to, poolAddress)) throw new Error('Capital transfer transaction unavailable');
        entries.push({ ...base, kind: parsed.name === 'FeeDeducted' ? 'FEE' : 'DISBURSEMENT', from: poolAddress,
          to: decoded.args[2], amount_atomic: String(args.feeAtomic ?? args.amountAtomic), evidence_hash: args.evidenceHash ?? args.feeEvidenceHash });
      }
    }
    const voided = reorg ? history.filter((entry) => Ledger.protocolInstanceKey(entry.protocol_instance) === key
      && entry.block_number >= scanFrom).map((entry) => entry.entry_id) : [];
    const candidate = new Map(history.filter((entry) => !voided.includes(entry.entry_id)).map((entry) => [Ledger.sourceKey(entry), entry]));
    for (const entry of entries) candidate.set(Ledger.sourceKey(entry), entry);
    const balances = new Map();
    for (const entry of candidate.values()) {
      if (Ledger.protocolInstanceKey(entry.protocol_instance) !== key) continue;
      const balanceKey = `${entry.chain_pool_id}:${entry.asset.toLowerCase()}`;
      const sign = ['INVESTOR_DEPOSIT', 'RECOVERY'].includes(entry.kind) ? 1n : -1n;
      balances.set(balanceKey, (balances.get(balanceKey) ?? 0n) + sign * BigInt(entry.amount_atomic));
    }
    const pool = new Contract(poolAddress, PROTOCOL_V5_ABI.RWAOfferingPool, provider);
    for (const [balanceKey, balance] of balances) {
      const [poolId, asset] = balanceKey.split(':');
      if (balance < 0n || await pool.escrowed(poolId, asset, { blockTag: end }) !== balance) throw new Error('Escrow conservation mismatch; replay cannot commit incomplete cash facts');
    }
    const recheck = await provider.getBlock(end);
    if (!recheck || !same(recheck.hash, checkpoint.hash)) throw new Error('Chain changed during ledger replay');
    const surviving = instanceHistory.filter((entry) => !voided.includes(entry.entry_id));
    const entryCount = new Set([...surviving, ...entries].map(Ledger.sourceKey)).size;
    const cursor = { protocol_instance: pi, start_block: start, last_block: end, last_block_hash: checkpoint.hash.toLowerCase(), confirmations: Number(confirmations), entry_count: entryCount };
    const result = await this.ledger.applyEvents(entries, { cursor, voidedEntryIds: voided, expectedCursor: previous ?? null });
    const intents = await this.ledger.writer.readIntents();
    const latestIntents = new Map();
    for (const intent of intents) latestIntents.set(intent.intent_id, { ...latestIntents.get(intent.intent_id), ...intent });
    const active = Ledger.activeEntries(await this.ledger.writer.readCashEntries());
    for (const intent of latestIntents.values()) {
      if (!intent.protocol_instance || Ledger.protocolInstanceKey(intent.protocol_instance) !== key) continue;
      const kind = intent.operation === 'CLAIM' ? 'CLAIM' : 'INVESTOR_DEPOSIT';
      const entry = active.find((item) => item.kind === kind && Ledger.protocolInstanceKey(item.protocol_instance) === key && item.chain_pool_id === intent.chain_pool_id
        && same(kind === 'CLAIM' ? item.to : item.from, intent.investor) && same(item.asset, intent.asset)
        && (kind === 'CLAIM' || item.amount_atomic === intent.amount_atomic) && item.shares === intent.shares
        && (!intent.tx_hash || same(item.source.tx_hash, intent.tx_hash)));
      if (!entry) {
        if (reorg && intent.status === 'confirmed' && intent.tx_hash) await this.ledger.reconcileIntent(intent.intent_id, intent.tx_hash);
        continue;
      }
      const occupied = await this.ledger.writer.readIntents((row) => row.tx_hash && same(row.tx_hash, entry.source.tx_hash) && row.intent_id !== intent.intent_id);
      if (occupied.length) continue;
      if (!intent.tx_hash) {
        if (!transactions.has(entry.source.tx_hash)) transactions.set(entry.source.tx_hash, await provider.getTransaction(entry.source.tx_hash));
        const tx = transactions.get(entry.source.tx_hash);
        if (!intent.calldata || !tx || !same(tx.data, intent.calldata) || !same(tx.from, intent.investor) || !same(tx.to, poolAddress)) continue;
      }
      if (intent.status !== 'confirmed') await this.ledger.confirmIntent(intent.intent_id, entry.source.tx_hash, entry.block_number);
    }
    return { positions: result.positions.filter((pos) => Ledger.protocolInstanceKey(pos.protocol_instance) === key), cursor, reorg };
  }
}
