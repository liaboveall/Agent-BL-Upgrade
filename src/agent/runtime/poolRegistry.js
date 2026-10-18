// Demo pool catalog. Controlled positions are identified and rebuilt by the capital ledger.
import { createWriteQueue, readJson, writeJsonAtomic } from '../../lib/jsonStore.js';
export class PoolRegistry {
  constructor({
    file = null,
    now = () => new Date()
  } = {}) {
    this.file = file;
    this.now = now;
    this.entries = new Map();
    this.enqueueWrite = createWriteQueue();
    this.initialized = false;
  }
  async init() {
    if (this.initialized) return this;
    if (this.file) {
      const saved = await readJson(this.file, null);
      for (const entry of saved?.pools ?? []) {
        if (entry.chain) throw new Error('Unexpected chain mapping in the research namespace');
        this.entries.set(entry.case_id, entry);
      }
    }
    this.initialized = true;
    return this;
  }
  async #persist() {
    if (this.file) {
      const snapshot = {
        version: 2,
        pools: [...this.entries.values()]
      };
      await this.enqueueWrite(() => writeJsonAtomic(this.file, snapshot));
    }
  }
  async registerOffchainBatch(pools, source = 'demo-auto') {
    await this.init();
    let changed = false;
    for (const {
      case_id: caseId,
      pool_id: poolId
    } of pools) {
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
  async registerOffchain({
    case_id,
    pool_id,
    source = 'demo-auto'
  }) {
    await this.registerOffchainBatch([{
      case_id,
      pool_id
    }], source);
    return this.get(case_id);
  }
  get(id) {
    const found = this.entries.get(id) ?? [...this.entries.values()].find(e => e.pool_id === id);
    return found ? structuredClone(found) : null;
  }
  isProtected() {
    return false;
  }
  chainPoolIdFor() {
    return null;
  }
  list() {
    return structuredClone([...this.entries.values()]);
  }
  async clearOffchain() {
    await this.init();
    this.entries.clear();
    await this.#persist();
  }
}
