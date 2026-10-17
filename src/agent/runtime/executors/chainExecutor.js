// Live executor (docs/agent-implementation-plan.md WP1.4). Sends an APPROVED action to the testnet
// contracts and reports what the chain says happened, never what we hoped would happen.
//
// Which key signs what (D2):
//   PRICING_UPDATER  -> RiskPricingOracle.updatePricing: REPRICE, PAUSE, RESUME, FREEZE, LIQUIDATE.
//   AGENT_EXECUTOR   -> OPTIONAL. Only when that key is configured does the server itself send
//                       markInTransit / recordImporterPayment / recordCargoArrival / settle.
//   everything else  -> an operator signs with the owner key through `npm run agent:approve`.
//
// Safety: a read-only precheck (state, emergency stop, replay) and a staticCall run before any
// transaction is sent; one transaction per signer at a time (nonce order); a result is only
// "success" once a receipt with the expected events is in. There is no simulated fallback here.

import { toChainPricingArgs } from '../../../core/oracle.js';
import { chainStateName, planTransition } from '../poolRules.js';
import { buildSettlementPlan, SETTLEMENT_ACTIONS, SETTLEMENT_SCHEMA } from '../../pipelines/settlementPipeline.js';

/** agent action -> RiskPricingOracle pricing action */
export const PRICING_ACTION_FOR = Object.freeze({
  OPEN: 'OPEN_OFFERING',
  OPEN_WITH_WARNING: 'OPEN_WITH_WARNING',
  REPRICE: 'REPRICE_DOWN',
  PAUSE: 'PAUSE_OFFERING',
  RESUME: 'RESUME_OFFERING',
  FREEZE: 'FREEZE_POOL',
  LIQUIDATE: 'TRIGGER_LIQUIDATION'
});

/** agent action -> RWAOfferingPool method that needs the executor role */
export const EXECUTOR_METHOD_FOR = Object.freeze({
  MARK_IN_TRANSIT: 'markInTransit',
  RECORD_PAYMENT: 'recordImporterPayment',
  RECORD_ARRIVAL: 'recordCargoArrival',
  SETTLE: 'settle'
});

/** Events that must appear in the receipt (any one of an inner array is enough). */
const EXPECTED_EVENTS = Object.freeze({
  OPEN: ['PricingUpdated'],
  OPEN_WITH_WARNING: ['PricingUpdated'],
  REPRICE: ['PricingUpdated', ['OfferingRepriced', 'OfferingStateChanged']],
  PAUSE: ['PricingUpdated', 'OfferingPaused'],
  RESUME: ['PricingUpdated', 'OfferingResumed'],
  FREEZE: ['PricingUpdated', 'OfferingStateChanged'],
  LIQUIDATE: ['PricingUpdated', 'OfferingStateChanged'],
  MARK_IN_TRANSIT: ['DepartureRecorded'],
  RECORD_PAYMENT: ['SettlementProofRecorded'],
  RECORD_ARRIVAL: ['SettlementProofRecorded'],
  SETTLE: ['OfferingSettled']
});

export class ChainExecutionError extends Error {
  constructor(code, message, { retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ChainExecutionError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** The transaction was broadcast but not confirmed in time. The decision stays EXECUTING. */
export class ExecutionPendingError extends Error {
  constructor(txHash, message = 'Transaction submitted but not confirmed yet') {
    super(message);
    this.name = 'ExecutionPendingError';
    this.code = 'execution_pending';
    this.tx_hash = txHash;
  }
}

/** Only failures that identify an unavailable RPC are retryable before broadcast. */
export function isTransientRpcError(error) {
  return ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'rpc_unavailable'].includes(error?.code);
}

/** Free-text proofs ("bol-123", a tx hash from elsewhere) become bytes32; a 32-byte hex stays as is. */
export async function proofToBytes32(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new ChainExecutionError('proof_required', 'A proof value is required');
  if (/^0x[0-9a-fA-F]{64}$/u.test(text)) return text.toLowerCase();
  const { keccak256, toUtf8Bytes } = await import('ethers');
  return keccak256(toUtf8Bytes(text));
}

/** The decisionId RiskPricingOracle derives for replay protection. */
export async function oracleDecisionId({ pool_id, issue_price_e6, pricing_action, evidence_hash, quote_hash }) {
  const { AbiCoder, keccak256 } = await import('ethers');
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'uint256', 'uint8', 'bytes32', 'bytes32'],
    [pool_id, issue_price_e6, pricing_action, evidence_hash, quote_hash]
  ));
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function eventNames(contracts, receipt) {
  const names = [];
  for (const log of receipt.logs ?? []) {
    for (const contract of contracts) {
      if (!same(log.address, contract?.target)) continue;
      try {
        const parsed = contract?.interface?.parseLog(log);
        if (parsed) { names.push(parsed.name); break; }
      } catch {
        // Not an event of this contract.
      }
    }
  }
  return names;
}

function missingEvents(action, names) {
  const wanted = EXPECTED_EVENTS[action] ?? [];
  return wanted.filter((entry) => (Array.isArray(entry) ? !entry.some((n) => names.includes(n)) : !names.includes(entry)))
    .map((entry) => (Array.isArray(entry) ? entry.join('|') : entry));
}

export class ChainExecutor {
  /**
   * @param {object} options
   * @param {() => Promise<object>} options.getContext  resolves { provider, oracle, pool, executorPool?, explorerBase,
   *   signers: { PRICING_UPDATER: string, AGENT_EXECUTOR?: string } }. `oracle` and `executorPool` are connected to their signers.
   * @param {number} [options.confirmations=1]
   * @param {number} [options.txTimeoutMs=120000]
   * @param {number} [options.eventScanBlocks=50000]  how far back to look for the event of an already processed decision
   */
  constructor({ getContext, confirmations = 1, txTimeoutMs = 120_000, eventScanBlocks = 50_000 } = {}) {
    if (typeof getContext !== 'function') throw new TypeError('ChainExecutor requires getContext()');
    this.getContext = getContext;
    this.confirmations = confirmations;
    this.txTimeoutMs = txTimeoutMs;
    this.eventScanBlocks = eventScanBlocks;
    this.mode = 'chain';
    this.queues = new Map(); // signer address -> promise tail (one tx in flight per signer)
  }

  /** Can this action be sent by the server itself, or does an operator have to sign it? */
  async canExecute(action) {
    if (PRICING_ACTION_FOR[action]) return true;
    if (EXECUTOR_METHOD_FOR[action]) return Boolean((await this.getContext()).executorPool);
    return false;
  }

  async findByIdempotencyKey() {
    // Reconciliation is by the decision's on-chain replay id and by tx hash (findTransaction); there is
    // no server-side idempotency table for chain actions.
    return null;
  }

  /** Read-only recovery when a send failed before its hash was recorded. Never broadcasts. */
  async reconcileCommand(cmd) {
    if (!PRICING_ACTION_FOR[cmd.action] || !cmd.params?.quote || !cmd.chain_pool_id) return null;
    const ctx = await this.getContext();
    const args = toChainPricingArgs({ ...cmd.params.quote, pricing_action: PRICING_ACTION_FOR[cmd.action] }, { pool_id: cmd.chain_pool_id });
    if (!await ctx.oracle.isDecisionProcessed(await oracleDecisionId(args))) return null;
    return this.#reconcileProcessed(cmd, ctx, cmd.chain_pool_id, args);
  }

  async execute(cmd) {
    if (!cmd?.decision_id || !cmd.idempotency_key) throw new TypeError('command needs decision_id and idempotency_key');
    const chainPoolId = Number(cmd.chain_pool_id);
    if (!Number.isSafeInteger(chainPoolId) || chainPoolId < 1) {
      throw new ChainExecutionError('no_chain_pool', 'This pool has no on-chain pool id mapped; nothing can be executed on-chain');
    }
    try {
      const ctx = await this.getContext();
      if (PRICING_ACTION_FOR[cmd.action]) return await this.#runPricing(cmd, chainPoolId, ctx);
      if (EXECUTOR_METHOD_FOR[cmd.action]) return await this.#runExecutorMethod(cmd, chainPoolId, ctx);
      throw new ChainExecutionError('unsupported_action', `${cmd.action} cannot be executed by the server`);
    } catch (error) {
      if (isTransientRpcError(error)) throw new ChainExecutionError('rpc_unavailable', 'RPC unavailable before broadcast', { retryable: true, cause: error });
      throw error;
    }
  }

  /** Resolve a previously submitted transaction: null while pending, a success result once confirmed. */
  async findTransaction(txHash, action, cmd) {
    if (!cmd || cmd.action !== action) throw new ChainExecutionError('command_required', 'Receipt recovery requires the original approved command');
    const ctx = await this.getContext();
    const receipt = await ctx.provider.getTransactionReceipt(txHash);
    if (!receipt) return null;
    const names = await this.#verifyReceipt({ cmd, ctx, txHash, receipt });
    if (!names) return null;
    return this.#success({ ctx, action, receipt, txHash, names, signerRole: PRICING_ACTION_FOR[action] ? 'PRICING_UPDATER' : 'AGENT_EXECUTOR', recovered: true });
  }

  // ---- pricing path (PRICING_UPDATER via RiskPricingOracle) ----

  async #runPricing(cmd, chainPoolId, ctx) {
    const pricingAction = PRICING_ACTION_FOR[cmd.action];
    const quote = cmd.params?.quote;
    if (!quote) throw new ChainExecutionError('quote_required', `${cmd.action} needs the quote it is based on`);
    if (['OPEN', 'OPEN_WITH_WARNING', 'REPRICE'].includes(cmd.action)
        && (quote.economic_checks?.ok === false || quote.data_review_required
          || quote.data_quality?.status === 'live' && Date.parse(quote.data_quality.expires_at) <= Date.now())) {
      throw new ChainExecutionError('terms_not_openable', 'Current economic and data-quality constraints do not permit new issuance terms');
    }
    const args = toChainPricingArgs({ ...quote, pricing_action: pricingAction }, { pool_id: chainPoolId });

    // Check replay protection before state preconditions: a mined PAUSE/REPRICE changed those already.
    const decisionId = await oracleDecisionId(args);
    if (await ctx.oracle.isDecisionProcessed(decisionId)) {
      return this.#reconcileProcessed(cmd, ctx, chainPoolId, args);
    }

    const state = await this.#readPool(ctx, chainPoolId);
    if (state.emergencyStopped) throw new ChainExecutionError('emergency_stopped', 'The pool contract is in emergency stop; no pricing action can be applied');
    const plan = planTransition(cmd.action, state);
    if (!plan.ok) {
      if (plan.code === 'not_paused' && cmd.action === 'RESUME') return this.#skipped(cmd, `already ${state.state}`);
      if (cmd.action === 'PAUSE' && state.state === 'Paused') return this.#skipped(cmd, 'already Paused');
      throw new ChainExecutionError(plan.code, plan.message);
    }
    if (cmd.action === 'REPRICE') {
      const version = await ctx.pool.protocolVersion?.().catch(() => 0) ?? 0;
      if (Number(version) < 3 && (state.subscribed > 0 || !['Open', 'Repriced'].includes(state.state))) {
        throw new ChainExecutionError('protocol_migration_required', 'The legacy pool cannot preserve this lifecycle during repricing; review the v3 migration');
      }
      if (args.issue_price_e6 >= state.issuePriceE6) {
        throw new ChainExecutionError('reprice_not_down', `REPRICE_DOWN must lower the price (on-chain ${state.issuePriceE6}, proposed ${args.issue_price_e6})`);
      }
      if (state.targetRedemptionE6 && args.issue_price_e6 > state.targetRedemptionE6) {
        throw new ChainExecutionError('price_above_target', 'The proposed price is above the redemption value');
      }
    }

    const send = () => ctx.oracle.updatePricing(
      args.pool_id, args.issue_price_e6, args.risk_level, args.pricing_action, args.evidence_hash, args.quote_hash
    );
    await this.#preflight(() => ctx.oracle.updatePricing.staticCall(
      args.pool_id, args.issue_price_e6, args.risk_level, args.pricing_action, args.evidence_hash, args.quote_hash
    ));
    return this.#submit({ cmd, ctx, signer: ctx.signers?.PRICING_UPDATER ?? 'PRICING_UPDATER', signerRole: 'PRICING_UPDATER', send });
  }

  async #reconcileProcessed(cmd, ctx, chainPoolId, args) {
    // The oracle already applied exactly this decision (e.g. we crashed after the broadcast). Find its
    // transaction instead of sending a second one that would revert with "decision replay".
    let found = null;
    try {
      const latest = await ctx.provider.getBlockNumber();
      const logs = await ctx.oracle.queryFilter(ctx.oracle.filters.PricingUpdated(chainPoolId), Math.max(0, latest - this.eventScanBlocks), latest);
      found = logs.find((log) => String(log.args?.evidenceHash).toLowerCase() === args.evidence_hash
        && String(log.args?.quoteHash).toLowerCase() === args.quote_hash
        && Number(log.args?.action) === args.pricing_action
        && Number(log.args?.poolId) === Number(args.pool_id)
        && Number(log.args?.issuePrice) === Number(args.issue_price_e6));
    } catch {
      // RPC log limits: fall through to "processed, transaction not located".
    }
    if (!found) {
      throw new ChainExecutionError('broadcast_uncertain', 'The oracle processed this decision but its confirmed transaction could not be located; operator reconciliation is required');
    }
    const confirmed = await this.findTransaction(found.transactionHash, cmd.action, cmd);
    if (!confirmed) throw new ExecutionPendingError(found.transactionHash, 'Replay protection confirms processing but the receipt is not available yet');
    return confirmed;
  }

  // ---- executor-role path (only with the optional AGENT_EXECUTOR key) ----

  async #runExecutorMethod(cmd, chainPoolId, ctx) {
    if (!ctx.executorPool) {
      throw new ChainExecutionError('owner_signature_required', `${cmd.action} needs the executor role; an operator signs it with npm run agent:approve`);
    }
    const state = await this.#readPool(ctx, chainPoolId);
    if (state.emergencyStopped) throw new ChainExecutionError('emergency_stopped', 'The pool contract is in emergency stop');
    const plan = planTransition(cmd.action, state);
    if (!plan.ok) throw new ChainExecutionError(plan.code, plan.message);

    const params = cmd.params ?? {};
    const method = EXECUTOR_METHOD_FOR[cmd.action];
    let args = [chainPoolId];
    if (cmd.action === 'MARK_IN_TRANSIT') args.push(await proofToBytes32(params.departure_proof));
    const settlementPlan = async () => {
      const planned = await buildSettlementPlan({ action: cmd.action, chain_pool_id: chainPoolId, params,
        chainConfig: ctx.chainConfig, context: ctx, recipient: ctx.settlementRecipient, expectedPayer: ctx.settlementPayer, confirmations: this.confirmations });
      if (cmd.settlement_plan && JSON.stringify(planned.steps) !== JSON.stringify(cmd.settlement_plan.steps)) {
        throw new ChainExecutionError('settlement_plan_changed', 'Current settlement proofs differ from the approved plan');
      }
      return planned;
    };
    if (SETTLEMENT_ACTIONS.includes(cmd.action)) args = (await settlementPlan()).steps[0].args;

    await this.#preflight(() => ctx.executorPool[method].staticCall(...args));
    return this.#submit({
      cmd, ctx, signer: ctx.signers?.AGENT_EXECUTOR ?? 'AGENT_EXECUTOR', signerRole: 'AGENT_EXECUTOR',
      send: async () => {
        if (SETTLEMENT_ACTIONS.includes(cmd.action)) await settlementPlan();
        return ctx.executorPool[method](...args);
      }
    });
  }

  // ---- shared ----

  async #readPool(ctx, chainPoolId) {
    const [stateIndex, emergencyStopped, offering, proofs] = await Promise.all([
      ctx.pool.stateOf(chainPoolId),
      ctx.pool.emergencyStopped(),
      ctx.pool.offerings(chainPoolId),
      ctx.pool.settlementProofs ? ctx.pool.settlementProofs(chainPoolId).catch(() => null) : null
    ]);
    const zero = /^0x0*$/u;
    const paymentProof = proofs ? !zero.test(String(proofs.paymentProof ?? proofs[0] ?? '0x0')) : false;
    const arrivalProof = proofs ? !zero.test(String(proofs.arrivalProof ?? proofs[1] ?? '0x0')) : false;
    return {
      state: chainStateName(stateIndex),
      emergencyStopped: Boolean(emergencyStopped),
      subscribed: Number(offering?.subscribed ?? 0),
      issuePriceE6: Number(offering?.issuePrice ?? 0),
      targetRedemptionE6: Number(offering?.targetRedemptionValue ?? 0),
      targetRedemptionValueAtomic: offering?.targetRedemptionValue === undefined ? undefined : String(offering.targetRedemptionValue),
      repaymentAmountAtomic: offering?.repaymentAmount === undefined ? undefined : String(offering.repaymentAmount),
      paymentProof,
      arrivalProof,
      stateBeforePause: undefined
    };
  }

  async #preflight(staticCall) {
    try {
      await staticCall();
    } catch (error) {
      if (isTransientRpcError(error)) throw error;
      const reason = error?.reason ?? error?.shortMessage ?? error?.message ?? 'reverted';
      throw new ChainExecutionError('would_revert', `The contract would reject this transaction: ${reason}`, { cause: error });
    }
  }

  #skipped(cmd, reason) {
    return {
      success: true, mode: 'chain', skipped: true, reference: null, tx_hash: null, explorer_url: null,
      signer_role: null, attempts: 0, note: `Nothing to do: ${reason}`
    };
  }

  /** Shared with decision anchoring; both features use the existing pricing key. */
  withSigner(signer, task) {
    const key = String(signer);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    this.queues.set(key, run.catch(() => {}));
    return run;
  }

  /** One transaction in flight per signer, so nonces are used in order. */
  async #submit({ cmd, ctx, signer, signerRole, send }) {
    return this.withSigner(signer, async () => {
      await cmd.assertCurrent?.();
      let tx;
      try { tx = await send(); }
      catch (error) {
        if (error?.code === 'NONCE_EXPIRED') throw new ChainExecutionError('nonce_conflict', 'Nonce was already mined; retry with a fresh provider nonce', { retryable: true, cause: error });
        if (isTransientRpcError(error)) throw new ChainExecutionError('broadcast_uncertain', 'RPC failed while sending; reconcile before another submission', { cause: error });
        throw error;
      }
      // Persist the hash before waiting: if we crash now the next run reconciles by hash.
      try { await cmd.onSubmitted?.({ tx_hash: tx.hash, signer_role: signerRole }); }
      catch { throw new ExecutionPendingError(tx.hash, 'Broadcast succeeded but recording the submission failed; reconcile by hash'); }
      let receipt;
      let timer;
      try {
        receipt = await Promise.race([
          tx.wait(this.confirmations),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new ExecutionPendingError(tx.hash)), this.txTimeoutMs); })
        ]);
      } catch (error) {
        if (error instanceof ExecutionPendingError) throw error;
        if (error?.code === 'CALL_EXCEPTION' && error.receipt?.status === 0) {
          throw new ChainExecutionError('tx_reverted', `Transaction ${tx.hash} reverted`, { cause: error });
        }
        // A failed receipt lookup does not prove that the transaction failed, and must never re-send it.
        throw new ExecutionPendingError(tx.hash, 'Receipt unavailable after broadcast; reconcile by hash');
      } finally {
        clearTimeout(timer);
      }
      if (!receipt || receipt.status !== 1) {
        throw new ChainExecutionError('tx_reverted', `Transaction ${tx.hash} was mined but reverted`);
      }
      let names;
      try { names = await this.#verifyReceipt({ cmd, ctx, txHash: tx.hash, receipt }); }
      catch (error) {
        if (isTransientRpcError(error)) throw new ExecutionPendingError(tx.hash, 'Receipt verification is unavailable after broadcast; reconcile without resubmission');
        throw error;
      }
      if (!names) throw new ExecutionPendingError(tx.hash, 'Transaction has not reached the required canonical confirmations');
      return this.#success({ ctx, action: cmd.action, receipt, txHash: tx.hash, names, signerRole });
    });
  }

  /** First receipts and restart recovery establish the same exact, canonical execution. */
  async #verifyReceipt({ cmd, ctx, txHash, receipt }) {
    if (receipt.status !== 1) throw new ChainExecutionError('tx_reverted', `Transaction ${txHash} reverted`);
    const pricing = Boolean(PRICING_ACTION_FOR[cmd.action]);
    const contract = pricing ? ctx.oracle : ctx.pool;
    const signer = ctx.signers?.[pricing ? 'PRICING_UPDATER' : 'AGENT_EXECUTOR'];
    let method, args;
    if (pricing) {
      const value = toChainPricingArgs({ ...cmd.params?.quote, pricing_action: PRICING_ACTION_FOR[cmd.action] }, { pool_id: cmd.chain_pool_id });
      method = 'updatePricing';
      args = [value.pool_id, value.issue_price_e6, value.risk_level, value.pricing_action, value.evidence_hash, value.quote_hash];
    } else {
      method = EXECUTOR_METHOD_FOR[cmd.action];
      if (cmd.action === 'MARK_IN_TRANSIT') args = [cmd.chain_pool_id, await proofToBytes32(cmd.params?.departure_proof)];
      else {
        const step = cmd.settlement_plan?.steps?.[0];
        if (cmd.settlement_plan?.schema !== SETTLEMENT_SCHEMA || step?.method !== method
          || !same(step.address, contract?.target) || Number(step.args?.[0]) !== Number(cmd.chain_pool_id)) {
          throw new ChainExecutionError('settlement_plan_required', 'Receipt recovery requires the approved settlement transaction plan');
        }
        args = step.args;
      }
    }
    const expectedData = contract.interface.encodeFunctionData(method, args);
    const tx = await ctx.provider.getTransaction(txHash);
    const chainId = Number(ctx.chainConfig?.chainIdDecimal ?? 1439);
    if (!tx || !same(tx.hash, txHash) || !same(receipt.hash ?? receipt.transactionHash, txHash)
      || !same(tx.to, contract.target) || !same(receipt.to, contract.target)
      || !same(tx.from, signer) || !same(receipt.from, signer) || !same(tx.data, expectedData)
      || BigInt(tx.value ?? 0) !== 0n || Number(tx.chainId) !== chainId
      || Number(await ctx.provider.send('eth_chainId', [])) !== chainId) {
      throw new ChainExecutionError('tx_verification_failed', 'Transaction differs from the approved contract, signer, network or exact calldata');
    }
    if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 1 || !/^0x[0-9a-f]{64}$/iu.test(receipt.blockHash ?? '')) {
      throw new ChainExecutionError('invalid_receipt_block', 'Transaction receipt has no valid mined block');
    }
    const [block, head] = await Promise.all([ctx.provider.getBlock(receipt.blockNumber), ctx.provider.getBlockNumber()]);
    if (!block || !same(block.hash, receipt.blockHash)) throw new ChainExecutionError('tx_reorged', 'Transaction receipt is no longer in its canonical block');
    if (!Number.isSafeInteger(head) || head < receipt.blockNumber) throw new ChainExecutionError('invalid_receipt_block', 'Confirmed chain head is unavailable or behind the receipt');
    if (head - receipt.blockNumber + 1 < this.confirmations) return null;
    return eventNames([ctx.oracle, ctx.pool, ctx.executorPool].filter(Boolean), receipt);
  }

  #success({ ctx, action, receipt, txHash, names, signerRole, recovered = false }) {
    const missing = missingEvents(action, names);
    if (missing.length) {
      throw new ChainExecutionError('events_missing', `Transaction ${txHash} was mined but the expected event(s) are missing: ${missing.join(', ')}`);
    }
    const base = String(ctx.explorerBase ?? '').replace(/\/$/u, '');
    return {
      success: true,
      mode: 'chain',
      recovered,
      reference: txHash,
      tx_hash: txHash,
      explorer_url: base ? `${base}/tx/${txHash}` : null,
      block_number: receipt.blockNumber ?? null,
      confirmed_events: names,
      signer_role: signerRole,
      attempts: 1
    };
  }
}

/**
 * Build the live context from chain-config.json and the environment. Resolves the contracts and the
 * signer for each role; a role without a key is simply left out. Never logs or returns a private key.
 */
export async function createChainContext({ chainConfig, env = process.env, resolveKey, fetchTimeoutMs = 20_000, readOnly = false } = {}) {
  const { ethers } = await import('ethers');
  const { resolveSignerKey } = await import('../../../chain/signerKeys.js');
  const resolve = resolveKey ?? ((role) => resolveSignerKey(role, env));
  const network = chainConfig;
  const rpcUrl = env.INJECTIVE_RPC_URL ?? network.rpcUrls?.[0];
  const provider = new ethers.JsonRpcProvider(rpcUrl, Number(network.chainIdDecimal ?? 1439), { staticNetwork: true });
  provider._getConnection().timeout = fetchTimeoutMs;
  const abi = (name) => {
    const entry = network.abis?.[name];
    if (!Array.isArray(entry) || !entry.length) throw new Error(`${name} ABI missing from the chain config`);
    return entry;
  };
  const addr = (name) => {
    const value = network.contracts?.[name];
    if (!value) throw new Error(`${name} is not deployed on ${network.network}`);
    return value;
  };

  const oracleRead = new ethers.Contract(addr('RiskPricingOracle'), abi('RiskPricingOracle'), provider);
  const pool = new ethers.Contract(addr('RWAOfferingPool'), [...abi('RWAOfferingPool'), 'function protocolVersion() view returns (uint256)'], provider);
  const registry = new ethers.Contract(addr('EBLRegistry'), abi('EBLRegistry'), provider);
  const context = { provider, pool, registry, explorerBase: network.explorerBase, signers: {}, oracle: oracleRead,
    chainConfig: network, settlementPayer: String(env.AGENT_SETTLEMENT_PAYER ?? '').trim(),
    settlementRecipient: String(env.AGENT_SETTLEMENT_RECIPIENT ?? '').trim() };

  // The watcher has its own provider-only context. Do not even resolve signer keys on this path.
  if (readOnly) return context;

  // The agent never signs with the contract OWNER key (D2/D3). A role whose key is only the deprecated
  // owner-key fallback is treated as "not configured": its actions go to an operator instead.
  const pricing = resolve('PRICING_UPDATER');
  if (pricing?.dedicated) {
    const wallet = new ethers.Wallet(pricing.privateKey, provider);
    context.oracle = oracleRead.connect(wallet);
    context.signers.PRICING_UPDATER = wallet.address;
    if (network.contracts?.AgentDecisionLog) {
      const { AGENT_LOG_ABI } = await import('../anchorChain.js');
      context.decisionLog = new ethers.Contract(network.contracts.AgentDecisionLog, AGENT_LOG_ABI, wallet);
    }
  }
  const executor = resolve('AGENT_EXECUTOR');
  if (executor?.dedicated) {
    const wallet = new ethers.Wallet(executor.privateKey, provider);
    context.executorPool = pool.connect(wallet);
    context.signers.AGENT_EXECUTOR = wallet.address;
  }
  return context;
}
