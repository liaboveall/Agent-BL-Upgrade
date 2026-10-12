// Pool registry (docs/agent-implementation-plan.md WP1.7, D4): which offchain pool belongs to which
// case and, in Live, which on-chain pool it mirrors. The agent only ever acts on a pool that is mapped
// here; an unmapped pool in Live gets proposals but no on-chain action.
//
// A "protected" pool is the standing Live demo pool (on-chain pool #2, copper). The policy refuses to
// propose anything terminal for it (settle, freeze, liquidate, cancel), so the reprice → pause →
// resume cycle can be demonstrated again and again.

import { createWriteQueue, readJson, writeJsonAtomic } from '../../lib/jsonStore.js';
import { ACTIVE_STATES, chainStateName } from './poolRules.js';

/** On-chain pools that exist from the 2026-10-12 testnet deployment and are linked automatically in Live. */
export const KNOWN_LIVE_POOLS = Object.freeze([
  Object.freeze({
    case_id: 'CASE-EBL-2026-CU-SG-SHA',
    chain_pool_id: 2,
    ebl_id: 2,
    protected: true,
    note: 'Wave B gate pool; standing Live demo pool (copper)'
  })
]);

/** Pool #1 is the deployment smoke test. It is already Repaid and is kept only as history. */
export const HISTORY_CHAIN_POOLS = Object.freeze([1]);

export class PoolRegistry {
  /**
   * @param {{file?: string|null, now?: ()=>Date, protectedChainPools?: number[]}} [options]
   */
  constructor({ file = null, now = () => new Date(), protectedChainPools = [] } = {}) {
    this.file = file;
    this.now = now;
    this.protectedChainPools = new Set(protectedChainPools.map(Number));
    this.entries = new Map(); // case_id -> entry
    this.enqueueWrite = createWriteQueue();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    if (this.file) {
      const saved = await readJson(this.file, null);
      for (const entry of saved?.pools ?? []) this.entries.set(entry.case_id, entry);
    }
    this.initialized = true;
    return this;
  }

  async #persist() {
    if (!this.file) return;
    const snapshot = { version: 1, pools: [...this.entries.values()] };
    await this.enqueueWrite(() => writeJsonAtomic(this.file, snapshot));
  }

  /** Record offchain (Demo) pools. Idempotent; the file is written once for the whole batch. */
  async registerOffchainBatch(pools, source = 'demo-auto') {
    await this.init();
    let changed = false;
    for (const { case_id: caseId, pool_id: poolId } of pools) {
      if (this.entries.has(caseId)) continue;
      this.entries.set(caseId, {
        case_id: caseId,
        pool_id: poolId ?? caseId,
        chain: null,
        protected: false,
        history_only: false,
        source,
        linked_at: this.now().toISOString(),
        note: null
      });
      changed = true;
    }
    if (changed) await this.#persist();
  }

  /** Record one offchain (Demo) pool. Idempotent. */
  async registerOffchain({ case_id: caseId, pool_id: poolId, source = 'demo-auto' }) {
    await this.registerOffchainBatch([{ case_id: caseId, pool_id: poolId }], source);
    return this.get(caseId);
  }

  /**
   * Map a case to an on-chain pool after checking the chain.
   * @param {object} input
   * @param {string} input.case_id
   * @param {number} input.chain_pool_id
   * @param {number} [input.ebl_id]                expected eBL id; must match the chain when given
   * @param {boolean} [input.protected]
   * @param {{readPool:(id:number)=>Promise<{exists:boolean, eblId:number, state:string}>}} reader
   */
  async linkChain({ case_id: caseId, pool_id: poolId, chain_pool_id: chainPoolId, ebl_id: eblId, protected: isProtected = false, source = 'live-link', note = null }, reader) {
    await this.init();
    const id = Number(chainPoolId);
    if (!caseId) throw new TypeError('case_id is required');
    if (!Number.isSafeInteger(id) || id < 1) throw new RangeError('chain_pool_id must be a positive integer');
    if (HISTORY_CHAIN_POOLS.includes(id)) {
      throw new RegistryError('history_pool', `On-chain pool #${id} is history only (already in a terminal state)`);
    }
    const taken = [...this.entries.values()].find((entry) => entry.chain?.pool_id === id && entry.case_id !== caseId);
    if (taken) throw new RegistryError('pool_already_linked', `On-chain pool #${id} is already linked to ${taken.case_id}`);

    const onChain = await reader.readPool(id);
    if (!onChain?.exists) throw new RegistryError('chain_pool_missing', `On-chain pool #${id} does not exist`);
    if (eblId !== undefined && Number(onChain.eblId) !== Number(eblId)) {
      throw new RegistryError('ebl_mismatch', `On-chain pool #${id} belongs to eBL #${onChain.eblId}, not #${eblId}`);
    }
    if (!ACTIVE_STATES.includes(onChain.state) && onChain.state !== 'Paused') {
      throw new RegistryError('pool_not_active', `On-chain pool #${id} is ${onChain.state}; only active or paused pools are linked`);
    }

    const entry = {
      case_id: caseId,
      pool_id: poolId ?? this.entries.get(caseId)?.pool_id ?? caseId,
      chain: { pool_id: id, ebl_id: Number(onChain.eblId), contract: 'RWAOfferingPool' },
      protected: Boolean(isProtected) || this.protectedChainPools.has(id),
      history_only: false,
      source,
      linked_at: this.now().toISOString(),
      note
    };
    this.entries.set(caseId, entry);
    await this.#persist();
    return structuredClone(entry);
  }

  /**
   * Link the known Live pools (D4). Each one is verified on-chain first; a mismatch is reported and
   * skipped, never forced. No transaction is sent.
   * @returns {Promise<Array<{case_id:string, chain_pool_id:number, linked:boolean, reason?:string}>>}
   */
  async bootstrapLive(reader, known = KNOWN_LIVE_POOLS) {
    const results = [];
    for (const pool of known) {
      try {
        await this.linkChain({ ...pool, source: 'live-bootstrap' }, reader);
        results.push({ case_id: pool.case_id, chain_pool_id: pool.chain_pool_id, linked: true });
      } catch (error) {
        results.push({ case_id: pool.case_id, chain_pool_id: pool.chain_pool_id, linked: false, reason: error.code ?? error.message });
      }
    }
    return results;
  }

  /** Find an entry by case id or offchain pool id. */
  get(caseOrPoolId) {
    const direct = this.entries.get(caseOrPoolId);
    if (direct) return structuredClone(direct);
    const byPool = [...this.entries.values()].find((entry) => entry.pool_id === caseOrPoolId);
    return byPool ? structuredClone(byPool) : null;
  }

  chainPoolIdFor(caseOrPoolId) {
    return this.get(caseOrPoolId)?.chain?.pool_id ?? null;
  }

  isProtected(caseOrPoolId) {
    const entry = this.get(caseOrPoolId);
    if (!entry) return false;
    return Boolean(entry.protected) || (entry.chain ? this.protectedChainPools.has(entry.chain.pool_id) : false);
  }

  list() {
    return structuredClone([...this.entries.values()]);
  }

  /** Forget the offchain-only (Demo) entries; chain links are never dropped by a Demo reset. */
  async clearOffchain() {
    await this.init();
    let changed = false;
    for (const [caseId, entry] of this.entries) {
      if (!entry.chain) { this.entries.delete(caseId); changed = true; }
    }
    if (changed) await this.#persist();
  }
}

export class RegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.status = code === 'chain_pool_missing' ? 404 : 409;
    this.expose = true;
  }
}

/** A chain reader over the pool contract of a ChainExecutor context. */
export function createChainReader(context) {
  return {
    async readPool(chainPoolId) {
      const offering = await context.pool.offerings(chainPoolId);
      const exists = Boolean(offering?.exists);
      if (!exists) return { exists: false };
      return {
        exists: true,
        eblId: Number(offering.eblId),
        state: chainStateName(await context.pool.stateOf(chainPoolId)),
        subscribed: Number(offering.subscribed ?? 0)
      };
    }
  };
}
