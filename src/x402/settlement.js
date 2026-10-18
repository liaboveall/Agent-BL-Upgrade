import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createFacilitatorRequest } from '@injectivelabs/x402/protocol';
import { SettleResponseSchema, VerifyResponseSchema } from '@injectivelabs/x402/schemas';
import { createWriteQueue, writeFileAtomic } from '../lib/jsonStore.js';
import { x402Network, x402PayTo, x402RpcUrl, x402Usdc } from './config.js';
import { loadApplicationConfig } from '../chain/loadApplicationConfig.js';
import { resolveSignerKey, signerKeyRequirement } from '../chain/signerKeys.js';
import { IndependentPaymentVerifier } from './independentVerifier.js';
import { LedgerWriter } from '../ledger/writer.js';
import { rightsKey, seal, unseal } from '../rights/vault.js';

export const SETTLEMENT_STATES = Object.freeze({
  CHALLENGED: 'CHALLENGED',
  SIGNED: 'SIGNED',
  SETTLING: 'SETTLING',
  RECONCILING: 'RECONCILING',
  SETTLED: 'SETTLED',
  UNLOCKED: 'UNLOCKED',
  FAILED: 'FAILED'
});

const TRANSITIONS = Object.freeze({
  CHALLENGED: new Set(['SIGNED', 'FAILED']),
  SIGNED: new Set(['SETTLING', 'SETTLED', 'RECONCILING', 'FAILED']),
  SETTLING: new Set(['SETTLED', 'RECONCILING', 'FAILED']),
  RECONCILING: new Set(['SETTLED']),
  SETTLED: new Set(['UNLOCKED', 'RECONCILING']),
  UNLOCKED: new Set(['RECONCILING']),
  FAILED: new Set()
});

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/u;

export class PaymentSettlementError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'PaymentSettlementError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.paymentId = options.paymentId ?? null;
    this.cause = options.cause;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, canonicalize(value[key])]));
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function paymentIdFor(paymentPayload, paymentRequirements) {
  const identity = {
    x402Version: paymentPayload?.x402Version,
    network: paymentRequirements?.network,
    asset: paymentRequirements?.asset?.toLowerCase?.(),
    payer: paymentPayload?.payload?.authorization?.from?.toLowerCase?.(),
    nonce: paymentPayload?.payload?.authorization?.nonce?.toLowerCase?.()
  };
  return `pay_${crypto.createHash('sha256').update(stableStringify(identity)).digest('hex')}`;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function nowIso(clock) {
  return clock().toISOString();
}

export class JsonReceiptStore {
  constructor(options = {}) {
    this.filePath = options.filePath === null ? null : options.filePath;
    this.records = new Map();
    this.initialized = false;
    this.enqueueWrite = createWriteQueue();
    this.writer = this.filePath ? new LedgerWriter(`${this.filePath}.writer`) : null;
  }

  async init() {
    if (this.initialized) return this;
    if (this.filePath) {
      try {
        const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        if (!Array.isArray(parsed) && ![1, 2].includes(parsed.version)) throw new Error('Unsupported x402 receipt store version');
        const records = Array.isArray(parsed) ? parsed : parsed.records;
        if (!Array.isArray(records)) throw new Error('x402 receipt store must contain a records array');
        for (const record of records) {
          if (!record?.payment_id || typeof record.payment_id !== 'string') {
            throw new Error('x402 receipt record is missing payment_id');
          }
          if (this.records.has(record.payment_id)) throw new Error('Duplicate payment identity in receipt history');
          if (record.network && record.asset && record.payer && record.nonce && [...this.records.values()].some((other) =>
            other.network === record.network && other.asset?.toLowerCase() === record.asset.toLowerCase()
            && other.payer?.toLowerCase() === record.payer.toLowerCase() && other.nonce?.toLowerCase() === record.nonce.toLowerCase())) throw new Error('Ambiguous historical authorization; reconcile before charging');
          this.records.set(record.payment_id, record);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (await fs.stat(`${this.filePath}.initialized`).then(() => true, () => false)) throw new Error('Initialized payment history is missing; restore before charging', { cause: error });
      }
    }
    this.initialized = true;
    return this;
  }

  async persist() {
    if (!this.filePath) return;
    const target = this.filePath;
    const body = `${JSON.stringify({ version: 2, identity: 'chain_asset_payer_nonce', records: [...this.records.values()] }, null, 2)}\n`;
    await this.enqueueWrite(async () => {
      await writeFileAtomic(target, body, { durable: true });
      await writeFileAtomic(`${target}.initialized`, 'agentbl-x402-receipts-v1\n', { durable: true });
    });
  }

  async exclusive(task) {
    const run = async () => { this.initialized = false; this.records.clear(); await this.init(); return task(); };
    if (this.writer) return this.writer.exclusive(run);
    this.enqueueTransaction ??= createWriteQueue();
    return this.enqueueTransaction(task);
  }

  async get(paymentId) {
    await this.init();
    return clone(this.records.get(paymentId) ?? null);
  }

  async upsert(record) {
    await this.init();
    this.records.set(record.payment_id, clone(record));
    await this.persist();
    return clone(record);
  }

  async list() {
    await this.init();
    return clone([...this.records.values()]);
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function defaultDelay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FacilitatorAdapter {
  constructor(options = {}) {
    if (!options.facilitatorUrl) throw new TypeError('facilitatorUrl is required');
    this.facilitatorUrl = options.facilitatorUrl.replace(/\/$/u, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 100;
    this.delay = options.delay ?? defaultDelay;
  }

  async request(endpoint, innerRequest, schema) {
    const requestBody = createFacilitatorRequest(innerRequest);
    const attempts = endpoint === 'settle' ? 1 : this.maxAttempts;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.facilitatorUrl}/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          const error = new PaymentSettlementError(
            `facilitator_${endpoint}_http_error`,
            `Facilitator ${endpoint} returned HTTP ${response.status}`,
            { retryable }
          );
          if (!retryable || attempt === attempts) throw error;
          lastError = error;
        } else {
          let json;
          try {
            json = await response.json();
          } catch (cause) {
            throw new PaymentSettlementError(
              `facilitator_${endpoint}_invalid_json`,
              `Facilitator ${endpoint} did not return JSON`,
              { cause }
            );
          }
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            throw new PaymentSettlementError(
              `facilitator_${endpoint}_invalid_response`,
              `Facilitator ${endpoint} response failed schema validation: ${parsed.error.issues[0]?.message ?? 'invalid response'}`
            );
          }
          return { response: parsed.data, attempts: attempt };
        }
      } catch (error) {
        const normalized = error instanceof PaymentSettlementError
          ? error
          : new PaymentSettlementError(
            `facilitator_${endpoint}_unavailable`,
            `Facilitator ${endpoint} request failed: ${error.message}`,
            { retryable: true, cause: error }
          );
        if (!normalized.retryable || attempt === attempts) throw normalized;
        lastError = normalized;
      } finally {
        clearTimeout(timer);
      }
      await this.delay(this.baseDelayMs * (2 ** (attempt - 1)));
    }
    throw lastError;
  }

  verify(innerRequest) {
    return this.request('verify', innerRequest, VerifyResponseSchema);
  }

  settle(innerRequest) {
    return this.request('settle', innerRequest, SettleResponseSchema);
  }
}

function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.has(to)) {
    throw new PaymentSettlementError('invalid_settlement_transition', `Invalid settlement transition: ${from} -> ${to}`);
  }
}

function transition(record, state, clock, patch = {}) {
  assertTransition(record.state, state);
  const timestamp = nowIso(clock);
  return {
    ...record,
    ...clone(patch),
    state,
    updated_at: timestamp,
    history: [...record.history, { state, at: timestamp }]
  };
}

function createRecord({ paymentId, paymentPayload, paymentRequirements, resource, mode, clock }) {
  const timestamp = nowIso(clock);
  return {
    payment_id: paymentId,
    idempotency_key: paymentId,
    state: SETTLEMENT_STATES.CHALLENGED,
    mode,
    onchain: false,
    resource,
    authorization: clone(paymentPayload.payload.authorization),
    requirements: clone(paymentRequirements),
    network: paymentRequirements.network,
    asset: paymentRequirements.asset,
    amount: paymentRequirements.amount,
    pay_to: paymentRequirements.payTo,
    payer: paymentPayload.payload.authorization.from,
    nonce: paymentPayload.payload.authorization.nonce,
    transaction: null,
    verify_attempts: 0,
    settle_attempts: 0,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
    history: [{ state: SETTLEMENT_STATES.CHALLENGED, at: timestamp }],
    unlock: null
  };
}

function sameResource(left, right) {
  return String(left ?? '') === String(right ?? '');
}

export class X402SettlementService {
  constructor(options = {}) {
    this.mode = options.mode ?? 'demo';
    if (!['demo', 'live'].includes(this.mode)) throw new TypeError('mode must be demo or live');
    this.clock = options.clock ?? (() => new Date());
    this.canSettle = options.canSettle ?? (() => true);
    this.store = options.store ?? new JsonReceiptStore({ filePath: options.receiptStorePath ?? null });
    this.adapter = options.adapter ?? (this.mode === 'live'
      ? new FacilitatorAdapter({
        facilitatorUrl: options.facilitatorUrl,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        maxAttempts: options.maxAttempts,
        baseDelayMs: options.baseDelayMs,
        delay: options.delay
      })
      : null);
    this.inflight = new Map();
    this.verifier = options.verifier ?? (this.mode === 'live' ? new IndependentPaymentVerifier({ rpcUrl: options.rpcUrl ?? x402RpcUrl(), confirmations: options.confirmations ?? 2 }) : null);
    this.deliveryKey = options.deliveryKey ?? rightsKey(options.env ?? process.env);
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    const initialize = async () => {
    await this.store.init();
    const records = await this.store.list();
    for (const record of records) {
      if (record.state !== SETTLEMENT_STATES.SETTLING) continue;
      const failed = transition(record, SETTLEMENT_STATES.RECONCILING, this.clock, {
        error: {
          code: 'settlement_reconciliation_required',
          message: 'Process restarted during settlement; on-chain reconciliation is required before unlock',
          retryable: false
        }
      });
      await this.store.upsert(failed);
    }
    this.initialized = true;
    };
    await (this.store.exclusive ? this.store.exclusive(initialize) : initialize());
    return this;
  }

  async process({ paymentPayload, paymentRequirements, resource }) {
    await this.init();
    const paymentId = paymentIdFor(paymentPayload, paymentRequirements);
    const running = this.inflight.get(paymentId);
    const binding = stableStringify({ resource, authorization: paymentPayload.payload.authorization, paymentRequirements });
    if (running) {
      if (running.binding !== binding) throw new PaymentSettlementError('payment_already_bound', 'Concurrent authorization use has different request terms', { paymentId });
      return running.operation;
    }
    const task = () => this.#processLocked({ paymentId, paymentPayload, paymentRequirements, resource });
    const operation = (this.store.exclusive ? this.store.exclusive(task) : task())
      .finally(() => this.inflight.delete(paymentId));
    this.inflight.set(paymentId, { binding, operation });
    return operation;
  }

  async #processLocked({ paymentId, paymentPayload, paymentRequirements, resource }) {
    let existing = await this.store.get(paymentId);
    if (!existing) {
      const auth = paymentPayload.payload.authorization;
      existing = (await this.store.list()).find((record) => record.network === paymentRequirements.network
        && record.asset?.toLowerCase() === paymentRequirements.asset.toLowerCase() && record.payer?.toLowerCase() === auth.from.toLowerCase()
        && record.nonce?.toLowerCase() === auth.nonce.toLowerCase());
      if (existing) paymentId = existing.payment_id;
    }
    const input = { paymentPayload, paymentRequirements };
    if (existing) {
      if (existing.mode && existing.mode !== this.mode || existing.authorization && stableStringify(existing.authorization) !== stableStringify(paymentPayload.payload.authorization)
        || existing.requirements && stableStringify(existing.requirements) !== stableStringify(paymentRequirements)) throw new PaymentSettlementError('payment_authorization_reused', 'Authorization is already bound to different terms', { paymentId });
      if (!sameResource(existing.resource, resource)) {
        throw new PaymentSettlementError(
          'payment_already_bound',
          'This payment authorization is already bound to a different resource',
          { paymentId }
        );
      }
      if ([SETTLEMENT_STATES.SETTLED, SETTLEMENT_STATES.UNLOCKED].includes(existing.state)) {
        if (this.mode === 'live') {
          try { await this.verifier.verify(input, existing.transaction); }
          catch (error) {
            if (error?.code === 'payment_authorization_invalid') throw new PaymentSettlementError('payment_authorization_invalid', 'A valid original authorization is required', { paymentId, cause: error });
            await this.store.upsert(transition(existing, SETTLEMENT_STATES.RECONCILING, this.clock, { onchain: false,
              independent_verification_current: false, error: { code: 'payment_reverification_required' } }));
            throw new PaymentSettlementError('payment_reverification_required', 'Canonical payment confirmation must be restored', { paymentId });
          }
        }
        return { record: existing, replayed: true };
      }
      if ([SETTLEMENT_STATES.RECONCILING, SETTLEMENT_STATES.SETTLING].includes(existing.state)) return this.#reconcile(existing, input);
      if (existing.state === SETTLEMENT_STATES.FAILED) {
        throw new PaymentSettlementError(
          existing.error?.code ?? 'previous_settlement_failed',
          existing.error?.message ?? 'Previous settlement attempt failed',
          { retryable: existing.error?.retryable ?? false, paymentId }
        );
      }
    }

    if (this.mode === 'live' && !this.canSettle()) {
      throw new PaymentSettlementError('operations_not_ready', 'New charges are paused pending operational reconciliation');
    }
    let record = existing ?? createRecord({
      paymentId,
      paymentPayload,
      paymentRequirements,
      resource,
      mode: this.mode,
      clock: this.clock
    });
    if (!existing) await this.store.upsert(record);
    if (record.state === SETTLEMENT_STATES.CHALLENGED) {
      record = transition(record, SETTLEMENT_STATES.SIGNED, this.clock);
      await this.store.upsert(record);
    }

    if (this.mode === 'demo') {
      record = transition(record, SETTLEMENT_STATES.SETTLED, this.clock, {
        settlement: 'simulated',
        onchain: false,
        transaction: null,
        verified_at: nowIso(this.clock),
        settled_at: nowIso(this.clock)
      });
      await this.store.upsert(record);
      return { record, replayed: false };
    }

    const innerRequest = { paymentPayload, paymentRequirements };
    let stage = 'independent_preflight';
    try {
      const checkpoint = await this.verifier.prepare(input);
      record = { ...record, checkpoint }; await this.store.upsert(record);
      if (checkpoint.authorization_used) {
        record = transition(record, SETTLEMENT_STATES.RECONCILING, this.clock); await this.store.upsert(record);
        return await this.#reconcile(record, input);
      }
      if (BigInt(paymentPayload.payload.authorization.validBefore) <= BigInt(Math.floor(this.clock().getTime() / 1000))) throw new PaymentSettlementError('payment_expired', 'Unspent payment authorization has expired');
      stage = 'facilitator_verify';
      const verified = await this.adapter.verify(innerRequest);
      record = { ...record, verify_attempts: verified.attempts, updated_at: nowIso(this.clock) };
      await this.store.upsert(record);
      if (!verified.response.isValid) {
        throw new PaymentSettlementError(
          verified.response.invalidReason ?? 'payment_verification_failed',
          verified.response.invalidMessage ?? 'Facilitator rejected the payment'
        );
      }

      record = transition(record, SETTLEMENT_STATES.SETTLING, this.clock, {
        verified_at: nowIso(this.clock)
      });
      await this.store.upsert(record);
      const settled = await this.adapter.settle(innerRequest);
      record = { ...record, settle_attempts: settled.attempts, updated_at: nowIso(this.clock) };
      await this.store.upsert(record);
      const response = settled.response;
      if (TX_HASH_RE.test(response.transaction ?? '')) { record = { ...record, transaction: response.transaction.toLowerCase() }; await this.store.upsert(record); }
      if (!response.success) {
        throw new PaymentSettlementError(
          response.errorReason ?? 'payment_settlement_failed',
          response.errorMessage ?? 'Facilitator failed to settle the payment'
        );
      }
      if (!TX_HASH_RE.test(response.transaction)) {
        throw new PaymentSettlementError('settlement_tx_invalid', 'Settlement response is missing a valid transaction hash');
      }
      if (response.network !== paymentRequirements.network) {
        throw new PaymentSettlementError('settlement_network_mismatch', 'Settlement response network does not match the payment requirement');
      }
      if (response.payer?.toLowerCase() !== paymentPayload.payload.authorization.from.toLowerCase()) {
        throw new PaymentSettlementError('settlement_payer_mismatch', 'Settlement response payer does not match the signed authorization');
      }
      const independent = await this.verifier.verify(input, response.transaction);
      if (independent?.verified !== true) throw new PaymentSettlementError('payment_independent_verification_failed', 'Independent payment verification failed');
      if ((await this.store.list()).some((entry) => entry.payment_id !== paymentId && entry.transaction?.toLowerCase() === response.transaction.toLowerCase())) throw new PaymentSettlementError('payment_transaction_reused', 'Payment transaction is already bound to another authorization');
      record = transition(record, SETTLEMENT_STATES.SETTLED, this.clock, {
        independent_verification: independent,
        settlement: 'onchain',
        onchain: true,
        transaction: response.transaction,
        settled_at: nowIso(this.clock),
        error: null
      });
      await this.store.upsert(record);
      return { record, replayed: false };
    } catch (error) {
      const normalized = error instanceof PaymentSettlementError
        ? error
        : new PaymentSettlementError('payment_settlement_failed', 'Payment verification or settlement requires reconciliation', { cause: error });
      const latest = await this.store.get(paymentId) ?? record;
      const invalid = ['payment_authorization_invalid', 'payment_chain_or_terms_mismatch', 'payment_asset_missing', 'payment_asset_domain_mismatch'];
      if (latest.state === SETTLEMENT_STATES.SIGNED && (stage === 'independent_preflight' && !invalid.includes(error?.code)
        || normalized.retryable)) {
        await this.store.upsert({ ...latest, error: { code: normalized.code, retryable: true }, updated_at: nowIso(this.clock) });
        normalized.retryable = true; normalized.paymentId = paymentId; throw normalized;
      }
      if (![SETTLEMENT_STATES.FAILED, SETTLEMENT_STATES.RECONCILING].includes(latest.state)) {
        const failed = transition(latest, latest.state === SETTLEMENT_STATES.SETTLING ? SETTLEMENT_STATES.RECONCILING : SETTLEMENT_STATES.FAILED, this.clock, {
          error: { code: normalized.code, message: normalized.message, retryable: normalized.retryable },
          failed_at: nowIso(this.clock)
        });
        await this.store.upsert(failed);
      }
      normalized.paymentId = paymentId;
      throw normalized;
    }
  }

  async #reconcile(record, input) {
    try {
      let transaction = record.transaction, independent = null;
      if (transaction) { try { independent = await this.verifier.verify(input, transaction); } catch {} }
      if (!independent) transaction = await this.verifier.locate(input, record.checkpoint);
      if (!transaction) throw new Error('Payment not located');
      independent ??= await this.verifier.verify(input, transaction);
      if (independent?.verified !== true) throw new Error('Payment not independently verified');
      if ((await this.store.list()).some((entry) => entry.payment_id !== record.payment_id && entry.transaction?.toLowerCase() === transaction.toLowerCase())) throw new Error('Payment transaction already bound');
      const settled = transition(record, SETTLEMENT_STATES.SETTLED, this.clock, { transaction, onchain: true, settlement: 'onchain',
        independent_verification: independent, verification_history: [...(record.verification_history ?? []), ...(record.independent_verification ? [record.independent_verification] : [])],
        settled_at: record.settled_at ?? nowIso(this.clock), error: null });
      await this.store.upsert(settled); return { record: settled, replayed: true };
    } catch {
      throw new PaymentSettlementError('settlement_reconciliation_required', 'Payment outcome requires read-only reconciliation; do not create another authorization', { paymentId: record.payment_id });
    }
  }

  async markUnlocked(paymentId, metadata = {}) {
    await this.init();
    const unlock = async () => {
    const record = await this.store.get(paymentId);
    if (!record) throw new PaymentSettlementError('payment_not_found', `Unknown payment: ${paymentId}`, { paymentId });
    if (record.state === SETTLEMENT_STATES.UNLOCKED) return record;
    if (record.state !== SETTLEMENT_STATES.SETTLED) {
      throw new PaymentSettlementError('payment_not_settled', `Cannot unlock a payment in state ${record.state}`, { paymentId });
    }
    const unlocked = transition(record, SETTLEMENT_STATES.UNLOCKED, this.clock, {
      unlocked_at: nowIso(this.clock),
      unlock: clone(metadata)
    });
    await this.store.upsert(unlocked);
    return unlocked;
    };
    return this.store.exclusive ? this.store.exclusive(unlock) : unlock();
  }

  async deliver(paymentId, build) {
    await this.init();
    if (!this.deliveryKey) throw new PaymentSettlementError('payment_delivery_key_required', 'A separately managed evidence key is required for recoverable paid reports');
    const task = async () => {
      let record = await this.store.get(paymentId);
      if (!record || ![SETTLEMENT_STATES.SETTLED, SETTLEMENT_STATES.UNLOCKED].includes(record.state)) throw new PaymentSettlementError('payment_not_settled', 'Canonical payment is required before delivery');
      if (record.delivered_body) return unseal(this.deliveryKey, record.delivered_body, `${paymentId}:delivered-v1`);
      const prepared = record.prepared_delivery ? unseal(this.deliveryKey, record.prepared_delivery, `${paymentId}:prepared-v1`) : null;
      const body = await build(prepared, async (nextPrepared) => {
        record = { ...record, prepared_delivery: seal(this.deliveryKey, nextPrepared, `${paymentId}:prepared-v1`) }; await this.store.upsert(record);
      });
      record = { ...record, delivered_body: seal(this.deliveryKey, body, `${paymentId}:delivered-v1`),
        delivered_report_id: body.report_envelope?.report_id ?? null, delivered_at: nowIso(this.clock) }; await this.store.upsert(record);
      return body;
    };
    return this.store.exclusive ? this.store.exclusive(task) : task();
  }

  async get(paymentId) {
    await this.init();
    return this.store.get(paymentId);
  }
  async readDeliveredReport(paymentPayload, reportId) {
    await this.init();
    const load = async () => (await this.store.list()).find((record) => record.delivered_report_id === reportId);
    const known = await (this.store.exclusive ? this.store.exclusive(load) : load());
    if (!known?.requirements || paymentIdFor(paymentPayload, known.requirements) !== paymentIdFor({ x402Version: 2, payload: { authorization: known.authorization } }, known.requirements)) throw new PaymentSettlementError('paid_report_not_found', 'Paid report is unavailable for this authorization');
    const result = await this.process({ paymentPayload, paymentRequirements: known.requirements, resource: known.resource });
    if (!this.deliveryKey) throw new PaymentSettlementError('payment_delivery_key_required', 'Restore the authorized paid report key');
    return unseal(this.deliveryKey, result.record.delivered_body, `${result.record.payment_id}:delivered-v1`);
  }
}

// PaymentOracle compatibility layer used by the paid-report UI and smoke CLI.
// It supplements the facilitator-backed state machine above with an immutable
// audit record after a report payment has settled.
let compatibilityProvider;
let compatibilityWallet;
let compatibilityOracle;
let oracleOverride = null;

/** Test hook: use this PaymentOracle-like object instead of the lazily created contract. */
export function setPaymentOracleOverride(oracle) {
  oracleOverride = oracle ?? null;
}

function loadPaymentOracleConfig() {
  try {
    return loadApplicationConfig();
  } catch {
    return null;
  }
}

async function getPaymentOracleContract() {
  if (oracleOverride) return oracleOverride;
  if (compatibilityOracle) return compatibilityOracle;
  const config = loadPaymentOracleConfig();
  const address = config?.contracts?.PaymentOracle ?? config?.paymentOracle?.address;
  const abi = config?.paymentOracle?.abi;
  // Dedicated PAYMENT_ATTESTOR key; DEPLOYER_PRIVATE_KEY (the contract owner) is a deprecated fallback.
  const signer = resolveSignerKey('PAYMENT_ATTESTOR');
  if (!address || !abi || !signer) return null;

  const { ethers } = await import('ethers');
  compatibilityProvider ??= new ethers.JsonRpcProvider(x402RpcUrl());
  compatibilityWallet ??= new ethers.Wallet(signer.privateKey, compatibilityProvider);
  compatibilityOracle ??= new ethers.Contract(address, abi, compatibilityWallet);
  return compatibilityOracle;
}

function compatibilityReceipt({ serviceId, amountUSDC, paymentRef, timestamp }) {
  return {
    network: x402Network(),
    token: x402Usdc(),
    payTo: x402PayTo(),
    amountUSDC,
    amountMicrousd: Math.floor(amountUSDC * 1_000_000),
    serviceId,
    paymentRef,
    timestamp
  };
}

export function generatePaymentReceipt({ serviceId, amountUSDC, paymentRef }) {
  const timestamp = new Date().toISOString();
  const nonce = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const payload = stableStringify({ serviceId, amountUSDC, paymentRef, timestamp, nonce });
  const txHash = `0x${crypto.createHash('sha256').update(payload).digest('hex')}`;
  return {
    txHash,
    receipt: compatibilityReceipt({
      serviceId,
      amountUSDC,
      paymentRef: paymentRef || txHash,
      timestamp
    })
  };
}

export function buildPaymentEvidence({ requestId, payer, serviceId, amountUSDC, paymentRef, responseData }) {
  const responseHash = responseData
    ? `0x${crypto.createHash('sha256').update(stableStringify(responseData)).digest('hex')}`
    : `0x${'00'.repeat(32)}`;
  return {
    requestId: requestId || (Math.floor(Date.now() / 1000) % 1_000_000),
    payer: payer || '0x0000000000000000000000000000000000000000',
    serviceId,
    amountMicrousd: Math.floor(amountUSDC * 1_000_000),
    paymentRef: paymentRef || `x402:${serviceId}:${Date.now()}`,
    responseHash
  };
}

/** Whole USDC amount -> atomic units, rounded (floor() lost a unit for values like 0.0029). */
export function usdcToAtomic(amountUSDC, decimals = 6) {
  return BigInt(Math.round(Number(amountUSDC) * 10 ** decimals));
}

function simulatedPaymentEvidence({ serviceId, amountUSDC, evidence }) {
  const generated = generatePaymentReceipt({ serviceId, amountUSDC, paymentRef: evidence.paymentRef });
  return {
    ok: true,
    payment: {
      txHash: generated.txHash,
      receipt: generated.receipt,
      evidence,
      onChainEvent: null,
      live: false,
      onchain: false,
      mode: 'demo'
    }
  };
}

/**
 * Bind a settled payment to the report it unlocked.
 *
 * Demo mode returns a clearly-labelled simulated receipt. Live mode ALWAYS attests
 * on-chain (PaymentOracle.attestPayment) and never degrades to a simulated receipt:
 * a missing envelope or signer is an error, not a silent downgrade. Re-submitting an
 * already-attested payment is a no-op, so a request that failed after the attestation
 * was mined can be retried without reverting on DuplicatePaymentTransaction.
 *
 * `oracle` lets callers/tests supply the PaymentOracle contract instead of the
 * lazily-created default.
 */
export async function recordPaymentEvidence({
  serviceId,
  amountUSDC,
  responseData,
  payer,
  reportEnvelope,
  paymentTxHash,
  asset,
  independentVerification,
  oracle: injectedOracle
}) {
  const evidence = buildPaymentEvidence({ serviceId, amountUSDC, responseData, payer });
  const demoMode = process.env.DEMO_MODE !== 'false';
  if (demoMode) return simulatedPaymentEvidence({ serviceId, amountUSDC, evidence });

  if (!reportEnvelope) {
    throw new PaymentSettlementError(
      'paid_report_required',
      'Live PaymentOracle attestation requires a canonical PaidReportEnvelope'
    );
  }
  try {
    const { assertPaidReportEnvelope } = await import('./paidReport.js');
    assertPaidReportEnvelope(reportEnvelope);
    const originalPaymentTx = paymentTxHash ?? reportEnvelope.payment_tx;
    if (!TX_HASH_RE.test(originalPaymentTx)) {
      throw new PaymentSettlementError(
        'payment_tx_invalid',
        'Live PaymentOracle attestation requires the original 32-byte settlement transaction hash'
      );
    }
    const resolvedPayer = payer || reportEnvelope.payer;
    if (resolvedPayer.toLowerCase() !== reportEnvelope.payer.toLowerCase()) {
      throw new PaymentSettlementError('payment_payer_mismatch', 'Attested payer must match PaidReportEnvelope.payer');
    }
    if (usdcToAtomic(amountUSDC).toString() !== reportEnvelope.amount || asset && asset.toLowerCase() !== reportEnvelope.asset.toLowerCase()) throw new PaymentSettlementError('payment_terms_mismatch', 'Attestation amount and asset must match the verified paid report');
    const proof = independentVerification;
    if (proof?.verified !== true || proof.transaction_hash?.toLowerCase() !== originalPaymentTx.toLowerCase()
      || proof.network !== reportEnvelope.network || proof.asset?.toLowerCase() !== reportEnvelope.asset.toLowerCase()
      || proof.payer?.toLowerCase() !== reportEnvelope.payer.toLowerCase() || proof.payee?.toLowerCase() !== reportEnvelope.payee.toLowerCase()
      || proof.amount_atomic !== reportEnvelope.amount || !TX_HASH_RE.test(proof.block_hash ?? '') || !(proof.confirmations >= 1)) {
      throw new PaymentSettlementError('payment_independent_verification_required', 'Canonical independent payment verification is required before attestation');
    }
    const oracle = injectedOracle ?? await getPaymentOracleContract();
    if (!oracle) throw new PaymentSettlementError('payment_oracle_unavailable', `Live mode requires ${signerKeyRequirement('PAYMENT_ATTESTOR')} and a deployed PaymentOracle`);

    const receiptId = `0x${reportEnvelope.report_id.slice(4)}`;
    const caseIdHash = `0x${crypto.createHash('sha256').update(reportEnvelope.case_id).digest('hex')}`;
    const amountAtomic = BigInt(reportEnvelope.amount);
    const paymentAsset = asset ?? reportEnvelope.asset;
    const config = loadPaymentOracleConfig();
    const explorerBase = config?.explorerBase ?? 'https://testnet.blockscout.injective.network';
    const timestamp = new Date().toISOString();

    const livePayment = {
      txHash: originalPaymentTx,
      paymentTxHash: originalPaymentTx,
      receipt: compatibilityReceipt({ serviceId, amountUSDC, paymentRef: originalPaymentTx, timestamp }),
      evidence,
      receiptId,
      reportHash: reportEnvelope.report_hash,
      caseIdHash,
      onChainEvent: 'PaymentAttested',
      live: true,
      onchain: true
    };

    if (typeof oracle.paymentTransactionAttested === 'function'
      && await oracle.paymentTransactionAttested(originalPaymentTx)) {
      return { ok: true, payment: { ...livePayment, attestation: 'already_recorded', attestationTxHash: null } };
    }

    const transaction = await oracle.attestPayment(
      receiptId,
      reportEnvelope.report_hash,
      caseIdHash,
      originalPaymentTx,
      resolvedPayer,
      paymentAsset,
      amountAtomic
    );
    const mined = await transaction.wait();
    return {
      ok: true,
      payment: {
        ...livePayment,
        attestation: 'recorded',
        attestationTxHash: mined.hash,
        attestationBlockNumber: mined.blockNumber,
        attestationExplorerUrl: `${explorerBase}/tx/${mined.hash}`
      }
    };
  } catch (error) {
    // A malformed envelope is its own failure, not a chain-write failure.
    if (error instanceof PaymentSettlementError || error?.code === 'paid_report_invalid') throw error;
    const known = /DuplicateReceipt|DuplicatePaymentTransaction/u.exec(String(error.message))?.[0];
    throw new PaymentSettlementError('payment_oracle_write_failed', `PaymentOracle write failed${known ? `: ${known}` : ''}; reconcile the original payment`, { cause: error });
  }
}
