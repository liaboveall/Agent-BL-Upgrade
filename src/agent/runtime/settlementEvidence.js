// One USDC receipt may fund one mapped lifecycle. Claims survive queue failures and restarts.
import { createWriteQueue, readJson, writeJsonAtomic } from '../../lib/jsonStore.js';
import { SettlementError, samePaymentEvidence } from '../pipelines/settlementPipeline.js';

export class SettlementEvidenceStore {
  constructor({ file = null } = {}) {
    this.file = file; this.records = new Map(); this.enqueue = createWriteQueue(); this.initialized = false;
  }
  async init() {
    if (this.initialized) return this;
    if (this.file) {
      const saved = await readJson(this.file, null);
      for (const item of saved?.claims ?? []) this.records.set(item.key, item);
    }
    this.initialized = true; return this;
  }
  list() { return structuredClone([...this.records.values()]); }
  find(proof, caseId, poolId) {
    return this.list().find((item) => item.event.case_id === caseId && item.event.chain_pool_id === Number(poolId)
      && item.event.data.payment_proof === String(proof).toLowerCase()) ?? null;
  }
  async claim(event) {
    await this.init();
    return this.enqueue(async () => {
      const key = `1439:${event.data.payment_proof.toLowerCase()}`;
      const old = this.records.get(key);
      if (old) {
        if (old.event.case_id !== event.case_id || old.event.chain_pool_id !== event.chain_pool_id
          || old.event.data.repayment_amount_atomic !== event.data.repayment_amount_atomic
          || old.event.runtime_generation !== event.runtime_generation
          || !samePaymentEvidence(old.event.data.payment_verification, event.data.payment_verification)) {
          throw new SettlementError('payment_already_claimed', 'This payment is already bound to another pool, amount, runtime or receipt; reconcile the existing claim', 409);
        }
        return structuredClone(old.event);
      }
      const record = { key, event: structuredClone(event) };
      const next = [...this.records.values(), record];
      if (this.file) await writeJsonAtomic(this.file, { version: 1, claims: next });
      this.records.set(key, record);
      return structuredClone(record.event);
    });
  }
}
