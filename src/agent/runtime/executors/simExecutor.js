// Demo executor: applies an agent action to the OFFCHAIN pool mirror held by the server. Nothing is
// sent to any network, so the result never contains a transaction hash or an explorer link; it carries
// a `demo:` reference and mode: 'demo'.

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
    controlVersion: pool.controlVersion ?? (pool.simulationPolicy === 'hypothetical_repricing' ? 0 : 4),
    fundingFinalized: pool.fundingFinalized === true,
    // The offchain store keeps `Open` until the pool is full; the contract reports `Subscribed` as
    // soon as anyone has subscribed, and the transition rules are written against the contract.
    state: pool.status === 'Open' && pool.subscribedUsd > 0 ? 'Subscribed' : pool.status,
    subscribed: pool.subscribedShares > 0 ? pool.subscribedShares : Math.ceil(pool.subscribedUsd / (pool.quote?.final_issue_price_usd || 1)),
    targetRedemptionValueAtomic: String(Math.round((pool.redemptionValueUsd ?? pool.quote?.target_redemption_value_usd ?? 1) * 1_000_000)),
    repaymentAmountAtomic: String(Math.round((pool.settlement?.repayment_amount ?? 0) * 1_000_000)),
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
    let pool = this.store.pools.get(poolId), created = false;
    const at = this.now().toISOString();
    const params = cmd.params ?? {};
    if (['OPEN', 'OPEN_WITH_WARNING', 'REPRICE'].includes(cmd.action)
        && (params.quote?.economic_checks?.ok === false || params.quote?.data_review_required)) {
      throw new SimExecutionError('terms_not_openable', 'The final economic or data-quality constraints require review');
    }

    if (!pool && (cmd.action === 'OPEN' || cmd.action === 'OPEN_WITH_WARNING') && params.case_data && params.quote) {
      // Built aside and stored only once the action succeeds, so a refused OPEN leaves no pool behind.
      pool = createPool(poolId, params.case_data, params.quote, { createdAt: at, store: { pools: new Map() } });
      created = true;
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
    if (view.controlVersion >= 4 && ['OPEN', 'OPEN_WITH_WARNING'].includes(cmd.action) && params.quote
        && ['final_issue_price_usd', 'recommended_token_supply', 'target_redemption_value_usd'].some(field => params.quote[field] !== pool.quote?.[field])) {
      throw new SimExecutionError('immutable_terms', 'Opening an existing controlled offering cannot replace its signed price, supply or redemption target');
    }
    const before = { state: view.state, issue_price_usd: pool.quote?.final_issue_price_usd ?? null };
    const plan = planTransition(cmd.action, view);
    if (!plan.ok) throw new SimExecutionError(plan.code, plan.message);

    // Every change is computed and checked first and applied at once: a refused action leaves the pool exactly as it
    // was, so a corrected retry is judged on the real state, not on half of the failed attempt.
    const changes = {};
    switch (cmd.action) {
      case 'OPEN':
      case 'OPEN_WITH_WARNING':
        if (params.quote) Object.assign(changes, { quote: params.quote, quoteUpdatedAt: at });
        break;
      case 'REPRICE':
        if (!params.quote) throw new SimExecutionError('quote_required', 'REPRICE needs the re-priced quote');
        Object.assign(changes, { quote: params.quote, quoteUpdatedAt: at, quoteVersion: (pool.quoteVersion ?? 1) + 1 });
        break;
      case 'PAUSE':
        changes.statusBeforePause = pool.status;
        break;
      case 'RECORD_PAYMENT': {
        const proof = String(params.payment_proof ?? '').slice(0, PROOF_MAX), amount = Number(params.repayment_amount);
        if (!proof || !Number.isFinite(amount) || !(amount > 0)) {
          throw new SimExecutionError('proof_required', 'RECORD_PAYMENT needs payment_proof and a positive repayment_amount');
        }
        changes.settlement = { ...pool.settlement, payment_proof: proof, repayment_amount: amount, payment_recorded_at: at };
        break;
      }
      case 'RECORD_ARRIVAL': {
        const proof = String(params.arrival_proof ?? '').slice(0, PROOF_MAX);
        if (!proof) throw new SimExecutionError('proof_required', 'RECORD_ARRIVAL needs arrival_proof');
        changes.settlement = { ...pool.settlement, arrival_proof: proof, arrival_recorded_at: at };
        break;
      }
      case 'SETTLE':
        changes.settlement = { ...pool.settlement, settled_at: at };
        break;
      case 'MARK_IN_TRANSIT':
        changes.departure_proof = String(params.departure_proof ?? '').slice(0, PROOF_MAX) || null;
        break;
      case 'WARNING':
        changes.warnings = [...(pool.warnings ?? []), { at, decision_id: cmd.decision_id, warning: params.warning ?? 'WARNING' }].slice(-20);
        break;
      default:
        break;
    }
    if (plan.changesState) changes.status = plan.to;
    // From here the agent's decision, not a later market re-quote, owns this pool's state and price.
    if (plan.changesState || ['OPEN', 'OPEN_WITH_WARNING', 'REPRICE'].includes(cmd.action)) changes.statusSource = 'agent';
    Object.assign(pool, changes);
    if (created) this.store.pools.set(poolId, pool);

    const result = {
      success: true,
      mode: 'demo',
      simulation_policy: pool.simulationPolicy ?? 'controlled_terms',
      note: pool.simulationPolicy === 'hypothetical_repricing'
        ? 'Hypothetical research scenario. Repricing and simulated lifecycle changes do not represent executable v4 instructions; signed v4 terms require a new offering to change price.'
        : 'Controlled terms simulation; contract preflight and wallet approval are still required for Live execution.',
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
