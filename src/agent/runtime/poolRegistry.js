// Pool registry (docs/agent-implementation-plan.md WP1.7, D4): which offchain pool belongs to which
// case and, in Live, which on-chain pool it mirrors. The agent only ever acts on a pool that is mapped
// here; an unmapped pool in Live gets proposals but no on-chain action.
//
// A "protected" pool is the historical Live demo pool (on-chain pool #2, copper). The policy refuses to
// propose anything terminal for it (settle, freeze, liquidate, cancel), so the reprice → pause →
// resume cycle can be demonstrated again and again.

import { createWriteQueue, readJson, writeJsonAtomic } from '../../lib/jsonStore.js';
import { ACTIVE_STATES, chainStateName } from './poolRules.js';

/**
 * On-chain pools of the testnet deployment that are linked automatically in Live, so a fresh runtime
 * directory needs no saved PoolRegistry file. Each one names the repository file holding the cargo
 * identity it was registered with and that identity's hash; both the link (bootstrapLive) and an
 * opening proposal for the same case are checked against them, never against a newer catalog case.
 */
export const KNOWN_LIVE_POOLS = Object.freeze([
  Object.freeze({
    case_id: 'CASE-EBL-2026-CU-SG-SHA',
    chain_pool_id: 2,
    ebl_id: 2,
    cargo_hash: '0xcbb79a2dc7946a1b0db32fa57833f07d5130915393acbf4315ddc3958383ad2f',
    // Historical: the 2026-06 copper case, priced by the pre-tenor model at 0.7910.
    identity_file: 'data/cases/archive/copper-sg-shanghai-2026-06.case.json',
    protected: true,
    historical: true,
    note: 'Wave B gate pool; historical Live demo pool (copper, 2026-06)'
  }),
  Object.freeze({
    case_id: 'CASE-EBL-CU-SIN-SHA',
    chain_pool_id: 3,
    ebl_id: 3,
    cargo_hash: '0xe23dd894cefb4fb021b86ab21ec21f701d691a62e8093f5c500974813f3cd032',
    // Opened from data/uploads/copper-sg-shanghai/ on 2026-10-16 (docs/evidence/live-opening-pool3.json).
    identity_file: 'data/chain-identities/copper-sg-shanghai-ebl3.case.json',
    protected: false,
    historical: false,
    note: 'Current Live copper pool (opened 2026-10-16)'
  })
]);

/** The known Live pool registered for a case, or null. */
export function knownLivePool(caseId) {
  return KNOWN_LIVE_POOLS.find((pool) => pool.case_id === caseId) ?? null;
}

/** Pool #1 is the deployment smoke test. It is already Repaid and is kept only as history. */
export const HISTORY_CHAIN_POOLS = Object.freeze([1]);

export class PoolRegistry {
  /**
   * @param {{file?: string|null, now?: ()=>Date, protectedChainPools?: number[]}} [options]
   */
  constructor({ file = null, now = () => new Date(), protectedChainPools = [], historyChainPools = HISTORY_CHAIN_POOLS } = {}) {
    this.file = file;
    this.now = now;
    this.protectedChainPools = new Set(protectedChainPools.map(Number));
    this.historyChainPools = new Set(historyChainPools.map(Number));
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
   * @param {string} [input.cargo_hash]            expected registered cargo identity; must match the chain when given
   * @param {boolean} [input.protected]
   * @param {{readPool:(id:number)=>Promise<{exists:boolean, eblId:number, state:string, cargoHash?:string}>}} reader
   */
  async linkChain({ case_id: caseId, pool_id: poolId, chain_pool_id: chainPoolId, ebl_id: eblId, cargo_hash: cargoHash,
    protected: isProtected = false, source = 'live-link', note = null }, reader) {
    await this.init();
    const id = Number(chainPoolId);
    if (!caseId) throw new TypeError('case_id is required');
    if (!Number.isSafeInteger(id) || id < 1) throw new RangeError('chain_pool_id must be a positive integer');
    if (this.historyChainPools.has(id)) {
      throw new RegistryError('history_pool', `On-chain pool #${id} is history only (already in a terminal state)`);
    }
    const taken = [...this.entries.values()].find((entry) => entry.chain?.pool_id === id && entry.case_id !== caseId);
    if (taken) throw new RegistryError('pool_already_linked', `On-chain pool #${id} is already linked to ${taken.case_id}`);

    const onChain = await reader.readPool(id);
    if (!onChain?.exists) throw new RegistryError('chain_pool_missing', `On-chain pool #${id} does not exist`);
    if (eblId !== undefined && Number(onChain.eblId) !== Number(eblId)) {
      throw new RegistryError('ebl_mismatch', `On-chain pool #${id} belongs to eBL #${onChain.eblId}, not #${eblId}`);
    }
    if (cargoHash !== undefined && String(onChain.cargoHash ?? '').toLowerCase() !== String(cargoHash).toLowerCase()) {
      throw new RegistryError('cargo_mismatch', `eBL #${onChain.eblId} of on-chain pool #${id} is not registered with the expected cargo identity`);
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

  getByChainPoolId(id) {
    const entry = [...this.entries.values()].find((item) => item.chain?.contract === 'RWAOfferingPool' && item.chain.pool_id === Number(id));
    return entry ? structuredClone(entry) : null;
  }

  /** A confirmed log discovers active pools and terminal history; it never replaces a CLI mapping. */
  async discoverChain({ case_id: caseId, chain_pool_id: id, snapshot }) {
    await this.init();
    if (!caseId || !Number.isSafeInteger(id) || id < 1 || !snapshot?.exists || snapshot.pool_id !== id) {
      throw new RegistryError('invalid_discovery', 'A confirmed pool snapshot is required');
    }
    const existing = this.getByChainPoolId(id);
    if (existing) {
      if (existing.chain.ebl_id !== snapshot.ebl_id) throw new RegistryError('ebl_mismatch', 'Discovered collateral conflicts with the saved pool mapping');
      const history = this.historyChainPools.has(id) || ![...ACTIVE_STATES, 'Paused'].includes(snapshot.state);
      if (existing.history_only !== history) {
        existing.history_only = history;
        this.entries.set(existing.case_id, existing);
        await this.#persist();
      }
      return existing;
    }
    if (this.get(caseId)?.chain) throw new RegistryError('case_already_linked', 'The case already maps to another on-chain pool');
    const entry = { case_id: caseId, pool_id: this.get(caseId)?.pool_id ?? caseId,
      chain: { pool_id: id, ebl_id: snapshot.ebl_id, contract: 'RWAOfferingPool' },
      protected: this.protectedChainPools.has(id), history_only: this.historyChainPools.has(id) || ![...ACTIVE_STATES, 'Paused'].includes(snapshot.state),
      source: 'chain-watcher', linked_at: this.now().toISOString(), note: null };
    this.entries.set(caseId, entry);
    await this.#persist();
    return structuredClone(entry);
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

/** A chain reader over the pool and registry contracts of a ChainExecutor context. */
export function createChainReader(context) {
  return {
    async readPool(chainPoolId) {
      const offering = await context.pool.offerings(chainPoolId);
      const exists = Boolean(offering?.exists);
      if (!exists) return { exists: false };
      const eblId = Number(offering.eblId);
      return {
        exists: true,
        eblId,
        state: chainStateName(await context.pool.stateOf(chainPoolId)),
        subscribed: Number(offering.subscribed ?? 0),
        // Without a registry the identity stays unknown, so an expected cargo hash cannot match.
        cargoHash: context.registry?.cargoHashOf ? String(await context.registry.cargoHashOf(eblId)) : null
      };
    }
  };
}
