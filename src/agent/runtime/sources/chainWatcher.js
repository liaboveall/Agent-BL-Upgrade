// WP2.7: confirmed, read-only log polling. Queue each real log before committing the cursor.
// A cursor is bound to its chain/addresses/topics; a reorg requires operator reconciliation.
import crypto from 'node:crypto';
import { Interface, isAddress } from 'ethers';
import { readJson, writeJsonAtomic } from '../../../lib/jsonStore.js';
import { cargoIdentityHash, cargoIdentityHashV2 } from '../../../chain/cargoIdentity.js';
import { hashSnapshot } from '../../decisionLogger.js';
import { chainStateName } from '../poolRules.js';
import { KNOWN_LIVE_POOLS } from '../poolRegistry.js';
import { Scheduler } from '../scheduler.js';

export const WATCHED_EVENTS = Object.freeze({
  RWAOfferingPool: ['OfferingCreated', 'Subscribed', 'OfferingStateChanged', 'OfferingRepriced',
    'OfferingPaused', 'OfferingResumed', 'SettlementProofRecorded', 'OfferingSettled', 'EmergencyStopSet',
    'DepartureRecorded', 'ImporterPaymentCorrected', 'OfferingCancelled'],
  RiskPricingOracle: ['PricingUpdated'],
  AgentBLRWA: ['Tokenized', 'Repriced'],
  PaymentOracle: ['PaymentAttested']
});
const HASH = /^0x[0-9a-f]{64}$/iu;
const ZERO = `0x${'0'.repeat(64)}`;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const caseHash = (id) => `0x${crypto.createHash('sha256').update(id).digest('hex')}`;
const integer = (value, label, min = 0) => {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isSafeInteger(n) || n < min) throw new WatcherError('invalid_rpc_data', `Invalid ${label}`);
  return n;
};
const amount = (value) => {
  if (!/^[0-9]+$/u.test(String(value))) throw new WatcherError('invalid_rpc_data', 'Invalid atomic amount');
  return BigInt(value).toString();
};
// Advisory UI numbers are only produced when they retain safe integer precision. Atomic strings
// remain authoritative even when an amount is too large for a JavaScript number.
const uiNumber = (value, scale = 1) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) / scale : null;

export class WatcherError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class ChainWatcher {
  constructor({ file = null, chainConfig, getContext, confirmations = 1, pollSec = 15,
    startBlock = null, batchBlocks = 5000, timeoutMs = 20_000, maxStaleMs = null, now = () => new Date(), write = writeJsonAtomic } = {}) {
    Object.assign(this, { file, chainConfig, getContext, startBlock, now, timeoutMs, write });
    // A healthy watcher re-confirms within one (jittered) interval plus one bounded poll. Older than
    // this, the last confirmation no longer describes the chain (stopped scheduler, stuck poll).
    this.maxStaleMs = maxStaleMs ?? 2 * pollSec * 1000 + timeoutMs;
    this.confirmations = integer(confirmations, 'confirmations', 1);
    this.batchBlocks = Math.min(5000, integer(batchBlocks, 'batch size', 1));
    this.pollSec = pollSec;
    this.saved = null;
    this.initialized = false;
    this.inFlight = null;
    this.nextRetryAt = 0;
    this.failures = 0;
    this.backups = new Map();
    this.state = 'idle';
    this.error = null;
    this.lastPollAt = null;
    this.healthyAt = null;
    this.latestBlock = null;
    this.confirmedBlock = null;
    this.context = null;
    this.scheduler = new Scheduler({ task: () => this.poll(this.service), intervalMs: pollSec * 1000 });
  }

  async init() {
    if (this.initialized) return;
    // Corrupt state must never silently start a fresh cursor.
    this.saved = this.file ? await readJson(this.file, null) : null;
    this.initialized = true;
  }

  start(service) { this.service = service; this.scheduler.start(); }
  async stop() { this.scheduler.stop(); await this.scheduler.drain(); await this.inFlight; }
  forgetDemoBackups() { this.backups.clear(); }

  /**
   * True while Live has no recent caught-up confirmation. A routine poll in flight does not by
   * itself make a healthy watcher unknown; failures, catch-up and reorgs set the service flag.
   */
  confirmationStale() {
    if (this.state === 'inactive') return false;
    return this.healthyAt === null || this.now().getTime() - this.healthyAt > this.maxStaleMs;
  }

  status(mode = 'live') {
    return { enabled: true, state: mode === 'demo' ? 'inactive' : this.state,
      poll_sec: this.pollSec, confirmations: this.confirmations, batch_blocks: this.batchBlocks,
      start_block: this.saved?.start_block ?? null, next_block: this.saved?.next_block ?? null,
      last_block: this.saved?.last_block ?? null, last_block_hash: this.saved?.last_block_hash ?? null,
      latest_block: this.latestBlock, confirmed_block: this.confirmedBlock,
      lag_blocks: this.confirmedBlock === null || !this.saved ? null : Math.max(0, this.confirmedBlock - this.saved.next_block + 1),
      last_poll_at: this.lastPollAt, confirmed_at: this.healthyAt === null ? null : new Date(this.healthyAt).toISOString(),
      max_stale_sec: this.maxStaleMs / 1000, stale: this.confirmationStale(), retry_at: this.nextRetryAt ? new Date(this.nextRetryAt).toISOString() : null,
      failures: this.failures, reconciliation_required: Boolean(this.saved?.reconciliation_required),
      pools: Object.values(this.saved?.snapshots ?? {}).map((s) => ({ case_id: s.case_id, pool_id: s.pool_id,
        state: s.state, block_number: s.block_number, monitoring: s.chain_only ? 'chain-only' : 'risk-and-chain' })),
      last_error: this.error };
  }

  /** Restore the independent Demo pools when Live mirrors leave scope. The Live cursor survives. */
  suspend(service) {
    for (const [id, original] of this.backups) {
      if (original) service.store.pools.set(id, original);
      else service.store.pools.delete(id);
    }
    this.backups.clear();
    service.chainEmergencyStopped = false;
    service.chainSafetyUnknown = false;
    this.healthyAt = null;
    this.state = 'inactive';
  }

  poll(service) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#poll(service).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async #rpc(task) {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new WatcherError('rpc_timeout', 'Chain polling deadline exceeded');
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new WatcherError('rpc_timeout', 'Chain polling deadline exceeded')), remaining);
      })]);
    } finally { clearTimeout(timer); }
  }

  #notice(service, action, details = {}, caseId = undefined, txHash = undefined) {
    service.activity.append({ type: 'SYSTEM', action, mode: 'live', caseId,
      ...(txHash ? { tx_hash: txHash } : {}), details });
  }

  async #poll(service) {
    if (service.getMode() !== 'live') { this.suspend(service); return this.status('demo'); }
    const generation = service.getGeneration();
    const assertCurrent = () => {
      if (service.getMode() !== 'live' || service.getGeneration() !== generation) throw new WatcherError('mode_changed', 'Runtime changed during chain polling');
    };
    if (this.nextRetryAt > this.now().getTime()) return this.status();
    this.deadline = Date.now() + this.timeoutMs;
    try {
      await this.init(); assertCurrent();
      if (this.saved?.reconciliation_required) throw new WatcherError('reconciliation_required', 'Saved chain cursor requires operator reconciliation');
      const context = await this.#rpc(() => this.getContext()); assertCurrent();
      if (!context?.provider || !context.pool || !context.registry) throw new WatcherError('chain_unavailable', 'Read-only chain context is unavailable');
      this.context = context;
      const provider = context.provider;
      // Static-network providers can cache getNetwork(); query the endpoint itself where available.
      const network = await this.#rpc(() => provider.send ? provider.send('eth_chainId', []) : provider.getNetwork().then((n) => n.chainId));
      if (Number(network) !== Number(this.chainConfig?.chainIdDecimal)) throw new WatcherError('chain_mismatch', 'RPC network does not match the configured chain');
      const descriptors = this.#descriptors();
      const contracts = descriptors.map(({ name, address, topics }) => ({ name, address, topics }));
      // The registry supplies collateral identities/metadata even though it has no watched logs.
      const registryAddress = this.chainConfig.contracts?.EBLRegistry;
      if (!isAddress(registryAddress ?? '')) throw new WatcherError('contract_missing', 'EBLRegistry has no configured address');
      const dependencies = [...contracts, { name: 'EBLRegistry', address: registryAddress.toLowerCase() }];
      const identity = hashSnapshot({ chain_id: Number(network), contracts: dependencies,
        deployments: Object.fromEntries(dependencies.map(({ name }) => [name, this.chainConfig.deployments?.[name]])),
        start_override: this.startBlock, confirmations: this.confirmations });
      // v1 bound every deployment, so adding the independent Phase 7 log invalidated a valid cursor.
      // Accept only exact historical bindings; never guess old watched addresses or deployment data.
      const legacyIdentity = (deployments) => hashSnapshot({ chain_id: Number(network), contracts,
        deployments, start_override: this.startBlock });
      const beforeAgentLog = { ...this.chainConfig.deployments };
      delete beforeAgentLog.AgentDecisionLog;
      const migrateLegacy = this.saved?.version === 1
        && [legacyIdentity(this.chainConfig.deployments), legacyIdentity(beforeAgentLog)].includes(this.saved.identity);
      if (this.saved && (!(this.saved.version === 2 && this.saved.identity === identity || migrateLegacy)
        || !Number.isSafeInteger(this.saved.start_block) || this.saved.start_block < 0
        || !this.saved.snapshots || Array.isArray(this.saved.snapshots) || typeof this.saved.snapshots !== 'object'
        || !Number.isSafeInteger(this.saved.next_block) || this.saved.next_block < this.saved.start_block
        || this.saved.last_block !== null && (!Number.isSafeInteger(this.saved.last_block) || !HASH.test(this.saved.last_block_hash)
          || this.saved.next_block !== this.saved.last_block + 1))) {
        throw new WatcherError('cursor_config_mismatch', 'Cursor configuration changed; preserve and reconcile the saved cursor');
      }
      this.latestBlock = integer(await this.#rpc(() => provider.getBlockNumber()), 'head block');
      this.confirmedBlock = this.latestBlock - this.confirmations + 1;
      if (this.confirmedBlock < 0) { service.chainSafetyUnknown = true; this.state = 'waiting-confirmations'; return this.status(); }
      // Engage a current stop before replaying historical logs. Release only after confirmation.
      const [headStop, confirmedStop] = await this.#rpc(() => Promise.all([
        context.pool.emergencyStopped({ blockTag: this.latestBlock }),
        context.pool.emergencyStopped({ blockTag: this.confirmedBlock })
      ])); assertCurrent();
      if (typeof headStop !== 'boolean' || typeof confirmedStop !== 'boolean') throw new WatcherError('invalid_rpc_data', 'Invalid emergency stop state');
      const stopped = headStop || confirmedStop;
      // Engage a stop at once; a release waits until the whole poll (including canonicality) succeeds.
      if (stopped && !service.chainEmergencyStopped) {
        this.#notice(service, 'CHAIN_EMERGENCY_STOP_CHANGED', { stopped, block_number: this.confirmedBlock });
        service.chainEmergencyStopped = true;
      }
      // A routine poll keeps the last confirmed state: until this poll commits, the previous caught-up
      // confirmation is as current as it was between polls, and confirmationStale() bounds its age.
      // Unknown stays set after startup, a mode switch or a failure; catch-up and errors set it below.
      if (!this.saved) {
        const starts = await this.#rpc(() => Promise.all(descriptors.map(async ({ name, address }) => {
          const deployment = this.chainConfig.deployments?.[name];
          if (deployment?.blockNumber !== undefined) return integer(deployment.blockNumber, `${name} deployment block`);
          if (!HASH.test(deployment?.deployTx ?? '')) throw new WatcherError('deployment_block_missing', `${name} has no deployment block or transaction`);
          const receipt = await provider.getTransactionReceipt(deployment.deployTx);
          if (!receipt || Number(receipt.status) !== 1 || !same(receipt.contractAddress, address) || !same(receipt.hash ?? receipt.transactionHash, deployment.deployTx)) {
            throw new WatcherError('deployment_receipt_invalid', `${name} deployment receipt is unavailable or mismatched`);
          }
          const block = await provider.getBlock(receipt.blockNumber);
          if (!block?.hash || !same(block.hash, receipt.blockHash)) throw new WatcherError('deployment_receipt_invalid', 'Deployment is not canonical');
          return integer(receipt.blockNumber, `${name} deployment block`);
        })));
        const deploymentStart = Math.min(...starts);
        const start = this.startBlock === null ? deploymentStart : integer(this.startBlock, 'start block');
        // A reviewed replacement starts a new protocol epoch. Only unchanged auxiliary
        // contracts explicitly preserved in its legacy archive may predate that epoch.
        const epoch = Number(this.chainConfig.protocolVersion) >= 3 && start === this.chainConfig.watcherStartBlock;
        const skipsUnarchivedHistory = descriptors.some(({ name, address }, i) => starts[i] < start
          && !(epoch && ['AgentBLRWA', 'PaymentOracle', 'AgentDecisionLog'].includes(name)
            && this.chainConfig.legacyProtocols?.some(({ config }) => same(config?.contracts?.[name], address)
              && (Number(config?.deployments?.[name]?.blockNumber) === starts[i]
                || HASH.test(config?.deployments?.[name]?.deployTx ?? '')
                  && same(config.deployments[name].deployTx, this.chainConfig.deployments[name].deployTx)))));
        if (start > deploymentStart && skipsUnarchivedHistory) throw new WatcherError('start_block_skips_deployment', 'Start block may not skip deployed contract history');
        this.saved = { version: 2, identity, start_block: start, next_block: start, last_block: null,
          last_block_hash: null, snapshots: {}, reconciliation_required: false };
      }
      if (this.saved.last_block !== null) {
        const last = await this.#rpc(() => provider.getBlock(this.saved.last_block)); assertCurrent();
        if (!last || !same(last.hash, this.saved.last_block_hash) || this.confirmedBlock < this.saved.last_block) {
          throw new WatcherError('chain_reorg', 'Previously committed block changed; operator reconciliation is required');
        }
      }
      // v1 did not record confirmation settings. Recheck its committed block against the current
      // confirmed head and canonical chain before persisting the stricter binding in place.
      if (migrateLegacy) {
        const migrated = { ...this.saved, version: 2, identity };
        if (this.file) await this.write(this.file, migrated);
        assertCurrent(); this.saved = migrated;
      }
      await service.ensurePools(); assertCurrent();
      const from = this.saved.next_block;
      const to = Math.min(this.confirmedBlock, from + this.batchBlocks - 1);
      if (to < this.confirmedBlock) service.chainSafetyUnknown = true;
      if (to < from) {
        // Restore saved mirrors after restart, even when there are no new blocks.
        for (const snapshot of Object.values(this.saved.snapshots)) this.#mirror(service, snapshot);
        service.chainSafetyUnknown = false; this.#healthy(service, stopped); return this.status();
      }
      const endBlock = await this.#rpc(() => provider.getBlock(to));
      if (!HASH.test(endBlock?.hash ?? '')) throw new WatcherError('invalid_rpc_data', 'Confirmed block is unavailable');
      const rawLogs = await this.#rpc(() => provider.getLogs({ address: descriptors.map((d) => d.address),
        topics: [[...new Set(descriptors.flatMap((d) => d.topics))]], fromBlock: from, toBlock: to }));
      assertCurrent();
      if (!Array.isArray(rawLogs)) throw new WatcherError('invalid_rpc_data', 'Log response is not an array');
      const blockCache = new Map([[to, endBlock]]), seen = new Map(), decoded = [];
      for (const log of rawLogs) {
        const descriptor = descriptors.find((d) => same(d.address, log.address));
        if (!descriptor || !descriptor.topics.some((t) => same(t, log.topics?.[0]))) throw new WatcherError('unexpected_log', 'RPC returned a log outside the requested contract/topic set');
        const height = integer(log.blockNumber, 'log block'), index = integer(log.index ?? log.logIndex, 'log index');
        const txIndex = integer(log.transactionIndex, 'transaction index');
        if (height < from || height > to || log.removed || !HASH.test(log.blockHash ?? '') || !HASH.test(log.transactionHash ?? '')) throw new WatcherError('invalid_log', 'Unconfirmed, removed or malformed log');
        if (!blockCache.has(height)) blockCache.set(height, await this.#rpc(() => provider.getBlock(height)));
        const block = blockCache.get(height);
        if (!block || !same(block.hash, log.blockHash)) throw new WatcherError('chain_reorg', 'Log no longer belongs to the canonical block');
        let parsed;
        try { parsed = descriptor.iface.parseLog(log); } catch { throw new WatcherError('log_decode_failed', 'Watched event could not be decoded'); }
        if (!parsed) throw new WatcherError('log_decode_failed', 'Watched event could not be decoded');
        const args = Object.fromEntries(parsed.fragment.inputs.map((input, i) => [input.name,
          typeof parsed.args[i] === 'bigint' ? parsed.args[i].toString() : parsed.args[i]]));
        const record = { contract: descriptor.name, address: descriptor.address, event_name: parsed.name, args,
          block_number: height, block_hash: log.blockHash.toLowerCase(), transaction_hash: log.transactionHash.toLowerCase(),
          transaction_index: txIndex, log_index: index, occurred_at: new Date(integer(block.timestamp, 'block timestamp') * 1000).toISOString() };
        const key = `${height}:${index}`;
        if (seen.has(key)) {
          if (hashSnapshot(seen.get(key)) !== hashSnapshot(record)) throw new WatcherError('conflicting_log', 'RPC returned conflicting logs at one position');
          continue;
        }
        seen.set(key, record); decoded.push(record);
      }
      decoded.sort((a, b) => a.block_number - b.block_number || a.transaction_index - b.transaction_index || a.log_index - b.log_index);
      const ids = new Set(Object.keys(this.saved.snapshots).map(Number));
      // Bootstrapped/CLI pools may not have existed yet in the historical batch being replayed.
      if (to === this.confirmedBlock) for (const entry of service.registry.list()) {
        if (entry.chain?.contract === 'RWAOfferingPool') ids.add(entry.chain.pool_id);
      }
      for (const log of decoded) if (['RWAOfferingPool', 'RiskPricingOracle'].includes(log.contract) && log.args.poolId !== undefined) ids.add(integer(log.args.poolId, 'pool id', 1));
      const snapshots = {};
      for (const id of ids) {
        const snapshot = await this.#readPool(context, id, to, endBlock.hash); assertCurrent();
        // A known missing pool is evidence of a mapping/chain inconsistency, not an empty result.
        if (!snapshot.exists) throw new WatcherError('chain_pool_missing', 'A watched offering does not exist at the confirmed block');
        const previous = service.registry.getByChainPoolId(id);
        if (previous && previous.chain.ebl_id !== snapshot.ebl_id) throw new WatcherError('ebl_mismatch', 'Confirmed pool collateral conflicts with its mapping');
        snapshot.case_id = previous?.case_id ?? this.#caseForPool(service, snapshot);
        snapshot.chain_only = ![...service.store.pools.values()].some((p) => p.caseData?.case_id === snapshot.case_id && !p.chainOnly);
        snapshots[id] = snapshot;
      }
      // Check again before applying a batch; callbacks may await disk I/O, so check at commit too.
      await this.#assertBlock(provider, to, endBlock.hash); assertCurrent();
      for (const snapshot of Object.values(snapshots)) {
        const linked = await service.registry.discoverChain({ case_id: snapshot.case_id, chain_pool_id: snapshot.pool_id, snapshot }); assertCurrent();
        snapshot.case_id = linked.case_id; snapshot.offchain_pool_id = linked.pool_id;
        this.#mirror(service, snapshot);
      }
      for (const log of decoded) {
        const snapshot = ['RWAOfferingPool', 'RiskPricingOracle'].includes(log.contract) ? snapshots[log.args.poolId] : null;
        const caseId = snapshot?.case_id ?? this.#caseForOther(service, log);
        const type = log.event_name === 'EmergencyStopSet' ? 'EMERGENCY_STOP_CHANGED'
          : log.event_name === 'OfferingCreated' ? 'OFFERING_CREATED'
            : log.event_name === 'Subscribed' ? 'SUBSCRIPTION_RECEIVED' : 'CHAIN_STATE_CHANGED';
        const event = { event_id: `chain:${Number(network)}:${log.block_hash}:${log.log_index}`, type, case_id: caseId,
          ...(snapshot ? { pool_id: snapshot.offchain_pool_id, chain_pool_id: snapshot.pool_id } : {}),
          source: 'chain-watcher', source_mode: 'live', occurred_at: log.occurred_at,
          evidence_hash: hashSnapshot(log), data: { ...log, ...(type === 'EMERGENCY_STOP_CHANGED' ? { stopped: log.args.stopped } : {}) } };
        await service.submitEvent(event, { origin: 'chain-watcher' }); assertCurrent();
      }
      await service.bus.flush();
      await service.activity.flush();
      if (service.activity.lastPersistError) throw new WatcherError('activity_persist_failed', 'Chain activity could not be persisted');
      await this.#assertBlock(provider, to, endBlock.hash); assertCurrent();
      const next = { ...this.saved, next_block: to + 1, last_block: to, last_block_hash: endBlock.hash.toLowerCase(),
        snapshots: { ...this.saved.snapshots, ...snapshots }, emergency_stopped: stopped };
      if (this.file) await this.write(this.file, next);
      assertCurrent(); this.saved = next;
      service.chainSafetyUnknown = next.next_block <= this.confirmedBlock; this.#healthy(service, stopped);
    } catch (error) {
      if (error.code === 'mode_changed') {
        if (service.getMode() === 'demo') this.suspend(service);
        else { service.chainSafetyUnknown = true; this.nextRetryAt = 0; }
        return this.status(service.getMode());
      }
      if (service.getMode() !== 'live' || service.getGeneration() !== generation) return this.status(service.getMode());
      service.chainSafetyUnknown = true;
      this.failures += 1;
      // Never publish RPC messages or URL credentials in status/activity.
      this.error = { code: error instanceof WatcherError ? error.code : 'poll_failed',
        message: error instanceof WatcherError ? error.message : 'Chain polling failed; retrying without advancing the cursor' };
      this.nextRetryAt = this.now().getTime() + Math.min(300_000, this.pollSec * 1000 * 2 ** Math.min(this.failures - 1, 8));
      const terminal = ['chain_reorg', 'cursor_config_mismatch', 'reconciliation_required', 'ebl_mismatch'].includes(error.code);
      if (terminal && this.saved) {
        this.saved = { ...this.saved, reconciliation_required: true };
        if (this.file) await this.write(this.file, this.saved).catch(() => {});
      }
      if (this.state !== 'degraded') this.#notice(service, 'CHAIN_WATCHER_DEGRADED', this.error);
      this.state = 'degraded';
    }
    return this.status();
  }

  #healthy(service, stopped) {
    if (this.state === 'degraded') this.#notice(service, 'CHAIN_WATCHER_RECOVERED');
    if (!stopped && service.chainEmergencyStopped) {
      this.#notice(service, 'CHAIN_EMERGENCY_STOP_CHANGED', { stopped: false, block_number: this.confirmedBlock });
      service.chainEmergencyStopped = false;
    }
    this.state = this.saved.next_block <= this.confirmedBlock ? 'catching-up' : 'healthy';
    this.healthyAt = this.state === 'healthy' ? this.now().getTime() : null;
    this.failures = 0; this.error = null; this.nextRetryAt = 0; this.lastPollAt = this.now().toISOString();
  }

  #descriptors() {
    return Object.entries(WATCHED_EVENTS).map(([name, events]) => {
      const address = this.chainConfig?.contracts?.[name];
      if (!isAddress(address ?? '')) throw new WatcherError('contract_missing', `${name} has no configured address`);
      let iface, topics;
      try {
        iface = new Interface(this.chainConfig.abis?.[name] ?? []);
        topics = events.map((event) => iface.getEvent(event).topicHash);
      } catch { throw new WatcherError('abi_missing', `${name} has no complete event ABI`); }
      return { name, address: address.toLowerCase(), iface, topics };
    });
  }

  async #assertBlock(provider, number, hash) {
    const block = await this.#rpc(() => provider.getBlock(number));
    if (!block || !same(block.hash, hash)) throw new WatcherError('chain_reorg', 'Confirmed batch changed before cursor commit');
  }

  async #readPool(context, id, block, hash) {
    return this.#rpc(async () => {
      const opts = { blockTag: block };
      const offering = await context.pool.offerings(id, opts);
      if (!offering?.exists) return { exists: false };
      const eblId = integer(offering.eblId, 'collateral id', 1);
      const [state, cargoHash, metadata] = await Promise.all([context.pool.stateOf(id, opts), context.registry.cargoHashOf(eblId, opts), context.registry.metadataOf(eblId, opts)]);
      if (!HASH.test(cargoHash)) throw new WatcherError('invalid_rpc_data', 'Invalid cargo identity');
      const payment = offering.paymentProof, arrival = offering.arrivalProof;
      if (!HASH.test(payment) || !HASH.test(arrival)) throw new WatcherError('invalid_rpc_data', 'Invalid settlement proof');
      const fields = ['vessel', 'voyage', 'portOfLoading', 'portOfDischarge', 'cargo', 'quantity', 'quantityUnit', 'hsCode', 'declaredValueUsdE6', 'incoterms', 'mletr', 'eucp', 'dcsa'];
      return { exists: true, pool_id: id, ebl_id: eblId, state: chainStateName(state), cargo_hash: cargoHash.toLowerCase(),
        issue_price_atomic: amount(offering.issuePrice), token_supply_atomic: amount(offering.tokenSupply),
        target_redemption_atomic: amount(offering.targetRedemptionValue), subscribed_atomic: amount(offering.subscribed),
        repayment_amount_atomic: amount(offering.repaymentAmount), payment_proof: payment.toLowerCase(), arrival_proof: arrival.toLowerCase(),
        metadata: Object.fromEntries(fields.map((field) => [field, typeof metadata[field] === 'bigint' ? metadata[field].toString() : metadata[field]])),
        block_number: block, block_hash: hash.toLowerCase() };
    });
  }

  #caseForPool(service, snapshot) {
    const known = (this.chainConfig.knownLivePools ?? KNOWN_LIVE_POOLS)
      .find((p) => p.chain_pool_id === snapshot.pool_id && p.ebl_id === snapshot.ebl_id && same(p.cargo_hash, snapshot.cargo_hash));
    if (known) return known.case_id;
    const candidates = [...service.store.pools.values()].filter((pool) => {
      try { return pool.caseData?.bill_of_lading && same(Number(this.chainConfig.protocolVersion) >= 3
        ? cargoIdentityHashV2(pool.caseData) : cargoIdentityHash(pool.caseData), snapshot.cargo_hash); } catch { return false; }
    });
    if (candidates.length === 1 && !service.registry.get(candidates[0].caseData.case_id)?.chain) return candidates[0].caseData.case_id;
    return `chain:${this.chainConfig.chainIdDecimal}:offering:${snapshot.pool_id}`;
  }

  #caseForOther(service, log) {
    const cases = [...service.store.pools.values()].map((p) => p.caseData).filter(Boolean);
    if (log.contract === 'PaymentOracle') return cases.find((c) => same(caseHash(c.case_id), log.args.caseIdHash))?.case_id ?? 'chain:payment-attestations';
    // AgentBLRWA pool numbers belong to another contract and never address RWAOfferingPool.
    if (log.contract === 'AgentBLRWA') return cases.find((c) => c.bill_of_lading?.bl_id === log.args.blId)?.case_id ?? `chain:legacy:${log.args.poolId}`;
    return 'chain:protocol';
  }

  #mirror(service, snapshot) {
    const entry = service.registry.getByChainPoolId(snapshot.pool_id);
    if (!entry) return;
    const id = entry.pool_id, original = service.store.pools.get(id);
    if (!this.backups.has(id)) this.backups.set(id, original ? structuredClone(original) : null);
    const view = original ? structuredClone(original) : {
      poolId: id, caseData: { case_id: snapshot.case_id, bill_of_lading: { cargo: snapshot.metadata.cargo,
        vessel: snapshot.metadata.vessel, port_of_loading: snapshot.metadata.portOfLoading, port_of_discharge: snapshot.metadata.portOfDischarge } },
      quote: { risk_level: 'UNKNOWN' }, complianceStatus: 'UNKNOWN', investorEligible: false, chainOnly: true
    };
    const before = { state: view.status ?? null, issue_price_atomic: view.chainSnapshot?.issue_price_atomic ?? null,
      subscribed_atomic: view.chainSnapshot?.subscribed_atomic ?? null };
    const changed = view.chainSnapshot ? before.state !== snapshot.state || before.issue_price_atomic !== snapshot.issue_price_atomic || before.subscribed_atomic !== snapshot.subscribed_atomic
      : view.status !== snapshot.state || view.quote?.final_issue_price_usd !== uiNumber(snapshot.issue_price_atomic, 1_000_000);
    view.status = snapshot.state;
    view.chainSnapshot = structuredClone(snapshot);
    // Preserve the full offchain quote and its hash as an independently priced document. The chain
    // price is exposed separately: changing just one field would forge an internally inconsistent quote.
    view.chainIssuePriceUsd = uiNumber(snapshot.issue_price_atomic, 1_000_000);
    view.chainQuoteMismatch = view.chainIssuePriceUsd === null || view.chainIssuePriceUsd !== view.quote?.final_issue_price_usd;
    view.settlement = { ...(view.settlement ?? {}), payment_proof: snapshot.payment_proof === ZERO ? undefined : snapshot.payment_proof,
      arrival_proof: snapshot.arrival_proof === ZERO ? undefined : snapshot.arrival_proof,
      repayment_amount_atomic: snapshot.repayment_amount_atomic };
    // An owner correction invalidates the former USDC verification. Observing the new proof must
    // never attach verification or a decimal amount that belongs to a different receipt.
    if (view.settlement.payment_verification && (!same(view.settlement.payment_verification.tx_hash, snapshot.payment_proof)
      || view.settlement.payment_verification.amount_atomic !== snapshot.repayment_amount_atomic)) {
      delete view.settlement.payment_verification;
      delete view.settlement.repayment_amount;
    }
    if (snapshot.state === 'Repaid') view.settlement.settled_at = 'on-chain';
    service.store.pools.set(id, view);
    if (changed) this.#notice(service, 'RECONCILE_MISMATCH', { before, after: { state: snapshot.state,
      issue_price_atomic: snapshot.issue_price_atomic, subscribed_atomic: snapshot.subscribed_atomic },
      block_number: snapshot.block_number, block_hash: snapshot.block_hash }, snapshot.case_id);
  }
}
