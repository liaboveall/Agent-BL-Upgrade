// Demo executor: applies an agent action to the OFFCHAIN pool mirror held by the server. Nothing is
// sent to any network, so the result never contains a transaction hash or an explorer link; it carries
// a `demo:` reference and mode: 'demo' (docs/agent-implementation-plan.md §2.2 principle 2).

import { createPool, storeState } from '../../../app/store.js';
import { planTransition } from '../poolRules.js';

const PROOF_MAX = 300;

export class SimExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SimExecutionError';
    this.code = code;
  }
}

export function demoReference(decisionId) {
  return `demo:${String(decisionId).replace(/^decision_/u, '').slice(0, 12)}`;
}

function stateOf(pool) {
  return {
    // The offchain store keeps `Open` until the pool is full; the contract reports `Subscribed` as
    // soon as anyone has subscribed, and the transition rules are written against the contract.
    state: pool.status === 'Open' && pool.subscribedUsd > 0 ? 'Subscribed' : pool.status,
    subscribed: pool.subscribedUsd,
    paymentProof: Boolean(pool.settlement?.payment_proof),
    arrivalProof: Boolean(pool.settlement?.arrival_proof),
    stateBeforePause: pool.statusBeforePause
  };
}

export class SimExecutor {
  /**
   * @param {{store?: typeof storeState, now?: ()=>Date}} [options]
   */
  constructor({ store = storeState, now = () => new Date() } = {}) {
    this.store = store;
    this.now = now;
    this.mode = 'demo';
    this.done = new Map(); // idempotency_key -> result (this process only: Demo pools live in memory too)
  }

  async findByIdempotencyKey(key) {
    const found = this.done.get(key);
    return found ? structuredClone(found) : null;
  }

  async execute(cmd) {
    if (!cmd?.idempotency_key || !cmd.decision_id) throw new TypeError('command needs decision_id and idempotency_key');
    const earlier = this.done.get(cmd.idempotency_key);
    if (earlier) return { ...structuredClone(earlier), duplicate: true };

    const poolId = cmd.pool_id ?? cmd.case_id;
    let pool = this.store.pools.get(poolId);
    const at = this.now().toISOString();
    const params = cmd.params ?? {};

    if (!pool && (cmd.action === 'OPEN' || cmd.action === 'OPEN_WITH_WARNING') && params.case_data && params.quote) {
      pool = createPool(poolId, params.case_data, params.quote, { createdAt: at, store: this.store });
    }
    if (!pool && (cmd.action === 'HOLD_FOR_REVIEW' || cmd.action === 'REJECT')) {
      // A case that was held or rejected before any pool existed: nothing to change, the record is the result.
      const result = {
        success: true,
        mode: 'demo',
        reference: demoReference(cmd.decision_id),
        signer_role: null,
        attempts: 1,
        executed_at: at,
        effects: { pool_id: null, state_before: null, state_after: null, issue_price_before_usd: null, issue_price_after_usd: null }
      };
      this.done.set(cmd.idempotency_key, result);
      return structuredClone(result);
    }
    if (!pool) throw new SimExecutionError('pool_not_found', `No offchain pool ${String(poolId)} to apply ${cmd.action} to`);

    const view = stateOf(pool);
    const before = { state: view.state, issue_price_usd: pool.quote?.final_issue_price_usd ?? null };
    const plan = planTransition(cmd.action, view);
    if (!plan.ok) throw new SimExecutionError(plan.code, plan.message);

    switch (cmd.action) {
      case 'OPEN':
      case 'OPEN_WITH_WARNING':
        if (params.quote) { pool.quote = params.quote; pool.quoteUpdatedAt = at; }
        break;
      case 'REPRICE':
        if (!params.quote) throw new SimExecutionError('quote_required', 'REPRICE needs the re-priced quote');
        pool.quote = params.quote;
        pool.quoteUpdatedAt = at;
        break;
      case 'PAUSE':
        pool.statusBeforePause = pool.status;
        break;
      case 'RECORD_PAYMENT':
        pool.settlement = {
          ...pool.settlement,
          payment_proof: String(params.payment_proof ?? '').slice(0, PROOF_MAX),
          repayment_amount: Number(params.repayment_amount),
          payment_recorded_at: at
        };
        if (!pool.settlement.payment_proof || !(pool.settlement.repayment_amount > 0)) {
          throw new SimExecutionError('proof_required', 'RECORD_PAYMENT needs payment_proof and a positive repayment_amount');
        }
        break;
      case 'RECORD_ARRIVAL':
        pool.settlement = {
          ...pool.settlement,
          arrival_proof: String(params.arrival_proof ?? '').slice(0, PROOF_MAX),
          arrival_recorded_at: at
        };
        if (!pool.settlement.arrival_proof) throw new SimExecutionError('proof_required', 'RECORD_ARRIVAL needs arrival_proof');
        break;
      case 'SETTLE':
        pool.settlement = { ...pool.settlement, settled_at: at };
        break;
      case 'MARK_IN_TRANSIT':
        pool.departure_proof = String(params.departure_proof ?? '').slice(0, PROOF_MAX) || null;
        break;
      case 'WARNING':
        pool.warnings = [...(pool.warnings ?? []), { at, decision_id: cmd.decision_id, warning: params.warning ?? 'WARNING' }].slice(-20);
        break;
      default:
        break;
    }
    if (plan.changesState) pool.status = plan.to;

    const result = {
      success: true,
      mode: 'demo',
      reference: demoReference(cmd.decision_id),
      signer_role: null,
      attempts: 1,
      executed_at: at,
      effects: {
        pool_id: poolId,
        state_before: before.state,
        state_after: pool.status,
        issue_price_before_usd: before.issue_price_usd,
        issue_price_after_usd: pool.quote?.final_issue_price_usd ?? null
      }
    };
    this.done.set(cmd.idempotency_key, result);
    return structuredClone(result);
  }
}
