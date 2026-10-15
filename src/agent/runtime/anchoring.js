import { keccak256, toUtf8Bytes } from 'ethers';
import { stableStringify } from '../decisionLogger.js';
import { createWriteQueue, readJson, writeJsonAtomic } from '../../lib/jsonStore.js';
import { terminalPayload, anchorLeaf, merkleTree, verifyAnchorRecord, TERMINAL_DECISIONS, MAX_ANCHOR_BATCH } from './anchorProof.js';
import { lockAnchorStore } from './anchorStore.js';
import { Scheduler } from './scheduler.js';
import { LEGACY_AGENT_VERSION } from './agentVersion.js';

const empty = () => ({ schema: 'agentbl-anchor-store-v1', demo: { records: [], batches: [] }, live: { records: [], batches: [] } });
const versionHash = ({ version_id: _id, ...version }) => keccak256(toUtf8Bytes(stableStringify(version)));

export function validateAnchorState(state) {
  if (state?.schema !== 'agentbl-anchor-store-v1') throw new Error('Invalid anchor journal schema');
  for (const mode of ['demo', 'live']) {
    const scope = state[mode], seen = new Set();
    if (!Array.isArray(scope?.records) || !Array.isArray(scope?.batches)) throw new Error('Invalid anchor journal scope');
    scope.records.forEach((record, i) => {
      if (record.seq !== i + 1 || record.payload.seq !== record.seq || record.payload.mode !== mode || seen.has(record.payload.decision_id)
        || record.leaf !== anchorLeaf(record.payload) || record.version.version_id !== record.payload.version_id
        || versionHash(record.version) !== record.version.version_id) throw new Error('Anchor journal record integrity failure');
      seen.add(record.payload.decision_id);
    });
    let next = 1;
    scope.batches.forEach((batch, i) => {
      const records = scope.records.slice(batch.from_seq - 1, batch.to_seq);
      if (batch.batch_id !== i + 1 || batch.mode !== mode || batch.from_seq !== next || batch.count !== records.length
        || batch.count !== batch.to_seq - batch.from_seq + 1 || !batch.count || batch.count > MAX_ANCHOR_BATCH
        || records.some((record) => record.payload.version_id !== batch.version_id)
        || merkleTree(records.map((record) => record.leaf)).root !== batch.merkle_root
        || mode === 'demo' && (batch.status !== 'DEMO' || batch.tx_hash || batch.chain_id || batch.contract_address)) throw new Error('Anchor batch integrity failure');
      next = batch.to_seq + 1;
    });
  }
  return state;
}

export async function readAnchorState(file) { return validateAnchorState(await readJson(file, empty())); }

export function decisionAnchorFromState(state, id, decision = null) {
  const mode = ['live', 'demo'].find((mode) => state[mode].records.some((record) => record.payload.decision_id === id && (!decision || decision.mode === mode)));
  if (!mode) return { available: false, state: 'NOT_FINALIZED', decision_id: id, verification: { passed: false, status: 'NOT_FINALIZED', checks: [] } };
  const scope = state[mode], record = scope.records.find((record) => record.payload.decision_id === id);
  const batch = scope.batches.find((batch) => record.seq >= batch.from_seq && record.seq <= batch.to_seq) ?? null;
  const proof = batch ? merkleTree(scope.records.slice(batch.from_seq - 1, batch.to_seq).map((record) => record.leaf)).proofs[record.seq - batch.from_seq] : null;
  const result = { available: true, decision_id: id, mode, seq: record.seq, state: batch?.status ?? 'PENDING_BATCH',
    payload: record.payload, leaf: record.leaf, version: record.version, batch, proof, archived: !decision };
  return { ...structuredClone(result), verification: batch ? verifyAnchorRecord(result, decision) : { passed: false, status: 'PENDING_BATCH', checks: [] } };
}

export class DecisionAnchoring {
  constructor({ file = null, version, config, getMode = () => 'demo', getGeneration = () => 1, logger,
    now = () => new Date(), adapter = null, write = writeJsonAtomic } = {}) {
    Object.assign(this, { file, version, config, getMode, getGeneration, logger, now, adapter, write });
    this.queue = createWriteQueue(); this.state = empty(); this.initialized = false; this.lastError = null;
    this.scheduler = new Scheduler({ task: () => this.tick(), intervalMs: Math.min(15, config.anchorIntervalSec) * 1000,
      onError: () => { this.lastError = 'anchor_processing_failed'; } });
  }

  async init() {
    if (this.initialized) return;
    this.initializing ??= (async () => {
      this.unlock = await lockAnchorStore(this.file);
      try { this.state = this.file ? await readAnchorState(this.file) : this.state; this.initialized = true; }
      catch (error) { await this.unlock(); this.unlock = null; throw error; }
    })().finally(() => { this.initializing = null; });
    await this.initializing;
  }

  async #commit(next) {
    validateAnchorState(next);
    if (this.file) await this.write(this.file, next);
    this.state = next;
  }

  // Called immediately after the terminal decision is durable. Failure never rewrites an already
  // confirmed trade execution; collect() retries before retention is allowed to remove its source.
  async captureSafe(decision) {
    try { await this.capture(decision); }
    catch { this.lastError = 'anchor_capture_failed'; }
  }

  async capture(decision) {
    if (!TERMINAL_DECISIONS.includes(decision.status)) return;
    await this.init();
    return this.queue(async () => {
      const scope = this.state[decision.mode];
      if (!scope) throw new Error('Invalid decision mode');
      const existing = scope.records.find((record) => record.payload.decision_id === decision.decision_id);
      if (existing) {
        const current = terminalPayload(decision, { seq: existing.seq, versionId: existing.payload.version_id, finalizedAt: existing.payload.finalized_at });
        if (stableStringify(current) !== stableStringify(existing.payload)
          || decision.agent_version && stableStringify(decision.agent_version) !== stableStringify(existing.version)) throw new Error('Finalized decision changed; anchor journal is immutable');
        return existing.seq;
      }
      const seq = scope.records.length + 1;
      const version = decision.agent_version ?? LEGACY_AGENT_VERSION;
      const payload = terminalPayload(decision, { seq, versionId: version.version_id });
      const next = structuredClone(this.state);
      next[decision.mode].records.push({ seq, payload, leaf: anchorLeaf(payload), version });
      await this.#commit(next);
      return seq;
    });
  }

  async collect() {
    for (const decision of await this.logger.list()) await this.capture(decision);
  }

  async start() { await this.init(); await this.collect(); this.scheduler.start(); }
  async stop() {
    this.scheduler.stop(); await this.scheduler.drain();
    await this.queue(async () => { if (this.unlock) await this.unlock(); this.unlock = null; this.initialized = false; });
  }

  async resetDemo() {
    await this.init();
    await this.queue(async () => { const next = structuredClone(this.state); next.demo = empty().demo; await this.#commit(next); });
  }

  status() {
    const mode = this.getMode(), scope = this.state[mode];
    return { enabled: this.config.anchorEnabled, mode, finalized: scope.records.length, batches: scope.batches.length,
      last_seq: scope.records.length, last_batch_status: scope.batches.at(-1)?.status ?? null,
      version: this.version, last_error: this.lastError, interval_sec: this.config.anchorIntervalSec };
  }

  async get(id, decision = null) {
    await this.init();
    const result = decisionAnchorFromState(this.state, id, decision);
    if (result.state === 'ANCHORED' && result.verification.passed) {
      try {
        const verified = await this.adapter?.verify(result);
        result.verification.checks.push({ name: 'confirmed_chain_batch', passed: verified === true });
        result.verification.passed = verified === true;
        result.verification.status = verified === true ? 'PASS_CHAIN' : 'FAIL';
      } catch {
        result.verification = { ...result.verification, passed: false, status: 'CHAIN_UNAVAILABLE' };
      }
    }
    return result;
  }

  async tick() {
    await this.init();
    await this.collect();
    this.lastError = null;
    return this.queue(async () => {
      const mode = this.getMode(), generation = this.getGeneration();
      const assertCurrent = () => {
        if (this.getMode() !== mode || this.getGeneration() !== generation) throw new Error('Mode changed before anchor broadcast');
      };
      const scope = this.state[mode], last = scope.batches.at(-1);
      const remaining = scope.records.slice(last?.to_seq ?? 0);
      if (remaining.length && remaining.length >= this.config.anchorMinBatch && (!last || this.now().getTime() - Date.parse(last.created_at) >= this.config.anchorIntervalSec * 1000)) {
        const versionId = remaining[0].payload.version_id;
        const records = remaining.slice(0, Math.min(MAX_ANCHOR_BATCH, remaining.findIndex((record) => record.payload.version_id !== versionId) < 0
          ? remaining.length : remaining.findIndex((record) => record.payload.version_id !== versionId)));
        const next = structuredClone(this.state);
        next[mode].batches.push({ batch_id: scope.batches.length + 1, mode, status: mode === 'demo' ? 'DEMO' : 'LOCAL',
          from_seq: records[0].seq, to_seq: records.at(-1).seq, count: records.length, version_id: versionId,
          merkle_root: merkleTree(records.map((record) => record.leaf)).root, created_at: this.now().toISOString(), tx_hash: null });
        await this.#commit(next);
      }
      if (mode !== 'live' || !this.config.anchorEnabled || !this.adapter) return;
      const batch = this.state.live.batches.find((batch) => batch.status !== 'ANCHORED');
      if (!batch) return;
      const update = async (patch) => {
        const next = structuredClone(this.state);
        Object.assign(next.live.batches[batch.batch_id - 1], patch);
        await this.#commit(next);
        Object.assign(batch, patch);
      };
      try {
        if (batch.status === 'LOCAL') {
          const version = this.state.live.records[batch.from_seq - 1].version;
          const binding = await this.adapter.prepare(batch, version);
          assertCurrent();
          await update({ ...binding, status: 'BROADCASTING' });
          // The durable intent precedes the RPC call, even if it never returns a hash.
          const sent = await this.adapter.send(batch, assertCurrent, async (tx) => {
            await update({ status: 'SUBMITTED', tx_hash: tx.hash.toLowerCase() });
          });
          if (!/^0x[0-9a-fA-F]{64}$/u.test(sent?.hash ?? '')) throw new Error('Anchor broadcast returned no transaction hash');
          await update({ status: 'SUBMITTED', tx_hash: sent.hash.toLowerCase() });
        } else if (!batch.tx_hash) {
          const hash = await this.adapter.locate(batch);
          if (!hash) { this.lastError = 'anchor_reconciliation_required'; return; }
          await update({ status: 'SUBMITTED', tx_hash: hash });
        }
        const confirmed = await this.adapter.confirm(batch);
        if (confirmed) await update({ ...confirmed, status: 'ANCHORED' });
        this.lastError = null;
      } catch {
        this.lastError = batch.status === 'LOCAL' ? 'anchor_preflight_failed' : 'anchor_reconciliation_required';
        // No automatic re-send after the intent checkpoint, including after a failed hash write.
      }
    });
  }
}
