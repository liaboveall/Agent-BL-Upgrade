import path from 'node:path';
import { LedgerWriter } from '../ledger/writer.js';
import { readJson, writeJsonAtomic } from '../lib/jsonStore.js';
import { runtimePath } from '../runtimePaths.js';
import { rightsKey, seal, unseal } from '../rights/vault.js';
import { hashSnapshot } from '../agent/decisionLogger.js';

const AAD = 'agentbl-x402-client-recovery-v1';
/** A signed authorization is durable before a client sends it. Restarts reuse that exact
 * authorization, including after expiry, rather than generating another payment nonce. */
export class ClientPaymentJournal {
  constructor({ directory = runtimePath('x402-client-recovery'), key = rightsKey(process.env) } = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw Object.assign(new Error('Live client payments require a separately managed AGENTBL_RIGHTS_KEY for recovery'), { code: 'X402_RECOVERY_KEY_REQUIRED' });
    this.directory = directory; this.key = key; this.writer = new LedgerWriter(directory);
  }
  run(identity, createHeader, send) {
    return this.writer.exclusive(async () => {
      const file = path.join(this.directory, 'payments.json'), marker = path.join(this.directory, 'initialized.json');
      const encrypted = await readJson(file), initialized = await readJson(marker);
      if (!encrypted && initialized) throw Object.assign(new Error('Restore client payment recovery history before another purchase'), { code: 'X402_RECOVERY_HISTORY_MISSING' });
      const state = encrypted ? unseal(this.key, encrypted, AAD) : { schema: AAD, entries: {} };
      if (state.schema !== AAD) throw new Error('Unsupported client payment recovery schema');
      const id = hashSnapshot(identity), previous = state.entries[id];
      if (!previous && Object.values(state.entries).some((item) => !item.completed && item.identity.url === identity.url && item.identity.payer === identity.payer)) throw Object.assign(new Error('Reconcile the previous service payment before another authorization'), { code: 'X402_RECONCILIATION_REQUIRED' });
      const persist = async () => {
        await writeJsonAtomic(file, seal(this.key, state, AAD), { durable: true });
        await writeJsonAtomic(marker, { schema: AAD }, { durable: true });
      };
      const entry = previous ?? { identity, header: await createHeader(), completed: false };
      if (!previous) { state.entries[id] = entry; await persist(); }
      const response = await send(entry.header);
      if (response.ok) {
        const report = await response.clone().json().catch(() => null);
        entry.completed = true; entry.report_id = report?.report_envelope?.report_id ?? null; await persist();
      }
      return { response, replayed: Boolean(previous) };
    });
  }
}
