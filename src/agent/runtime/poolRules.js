// Legal offering-state transitions for each agent action. One table, used by the Demo executor (to
// change the offchain pool), by the chain executor (to refuse a transaction that would only revert)
// and by the owner-CLI plan builder, so a Demo run and a Live run agree on what is allowed.
//
// The rules mirror hardhat/contracts/RWAOfferingPool.sol. If a rule here is wrong the contract is
// still the final authority: the chain executor also runs a staticCall before it sends anything.

/** RWAOfferingPool.OfferingState, in the contract's enum order (index = on-chain value). */
export const CHAIN_STATE_NAMES = Object.freeze([
  'Created', 'Priced', 'Open', 'Subscribed', 'Funded', 'InTransit', 'Repriced',
  'Paused', 'Frozen', 'Repaid', 'Redeemed', 'Liquidation', 'Cancelled', 'Defaulted', 'LossSettled'
]);

export const ACTIVE_STATES = Object.freeze(['Open', 'Subscribed', 'Funded', 'InTransit', 'Repriced']);
export const TERMINAL_STATES = Object.freeze(['Repaid', 'Redeemed', 'Cancelled', 'LossSettled']);
/** Liquidation is an exit-bearing state; it closes only through an approved resolution (A01). */
export const RECOVERY_STATES = Object.freeze(['Liquidation', 'Defaulted', 'Frozen']);

export function chainStateName(index) {
  const name = CHAIN_STATE_NAMES[Number(index)];
  if (!name) throw new RangeError(`Unknown on-chain offering state: ${String(index)}`);
  return name;
}

const isActive = (state) => ACTIVE_STATES.includes(state);
// Defaulted and Frozen keep the investors' claim alive: verified recovery and settlement must
// remain recordable there (A02/A03). Liquidation records recovery through its own entry point.
const isSettleable = (state) => isActive(state) || state === 'Defaulted' || state === 'Frozen';

/**
 * @param {string} action  an agent action
 * @param {{state:string, subscribed?:number, paymentProof?:boolean, arrivalProof?:boolean, stateBeforePause?:string}} pool
 * @returns {{ok:true, from:string, to:string, changesState:boolean} | {ok:false, code:string, message:string}}
 */
export function planTransition(action, pool) {
  const from = pool.state;
  const ok = (to, changesState = to !== from) => ({ ok: true, from, to, changesState });
  const no = (message, code = 'illegal_transition') => ({ ok: false, code, message: `${action} is not allowed from ${from}: ${message}` });
  const subscribed = Number(pool.subscribed ?? 0) > 0;

  switch (action) {
    case 'OPEN':
    case 'OPEN_WITH_WARNING':
      return isActive(from) ? ok(from, false) : no('the offering is not active');
    case 'REPRICE':
      return isActive(from) ? ok(from, false) : no('the offering is not active');
    case 'PAUSE':
      return isActive(from) ? ok('Paused') : no('only an active offering can be paused');
    case 'RESUME':
      if (from !== 'Paused') return no('only a paused offering can be resumed', 'not_paused');
      return ok(isActive(pool.stateBeforePause) ? pool.stateBeforePause : 'Open');
    case 'FREEZE':
      return isActive(from) || from === 'Paused' ? ok('Frozen') : no('only an active or paused offering can be frozen');
    case 'LIQUIDATE':
      return isActive(from) || from === 'Paused' || from === 'Frozen' ? ok('Liquidation') : no('the offering is not in a liquidatable state');
    case 'CANCEL':
      if (subscribed) return no('it already has subscribers', 'has_subscribers');
      return ['Open', 'Repriced', 'Paused', 'Frozen', 'Liquidation'].includes(from)
        ? ok('Cancelled') : no('only an unsubscribed open, repriced, paused, frozen or liquidating offering can be cancelled');
    case 'MARK_IN_TRANSIT':
      return from === 'Funded' || from === 'Subscribed' ? ok('InTransit') : no('the offering is not funded');
    case 'RECORD_PAYMENT':
      if (!isSettleable(from)) return no('the offering is not in a settleable state');
      if (!subscribed) return no('nobody subscribed, so there is nothing to repay', 'no_subscribers');
      if (pool.paymentProof) return no('a payment proof is already recorded', 'already_recorded');
      return ok(from, false);
    case 'RECORD_ADDITIONAL_PAYMENT':
      if (!isSettleable(from)) return no('the offering is not in a settleable state');
      if (!subscribed) return no('nobody subscribed, so there is nothing to repay', 'no_subscribers');
      if (!pool.paymentProof) return no('the first payment must be recorded before an additional recovery', 'payment_missing');
      return ok(from, false);
    case 'RECORD_ARRIVAL':
      if (!isSettleable(from)) return no('the offering is not in a settleable state');
      if (!subscribed) return no('nobody subscribed, so there is nothing to repay', 'no_subscribers');
      if (pool.arrivalProof) return no('an arrival proof is already recorded', 'already_recorded');
      return ok(from, false);
    case 'SETTLE':
      if (!isSettleable(from)) return no('the offering is not in a settleable state');
      if (!subscribed) return no('nobody subscribed, so there is nothing to repay', 'no_subscribers');
      if (!pool.paymentProof || !pool.arrivalProof) return no('both the payment proof and the arrival proof are required first', 'proofs_missing');
      if (pool.repaymentAmountAtomic === undefined || pool.targetRedemptionValueAtomic === undefined) return no('debt and recovery must be reconciled first', 'debt_unverified');
      if (BigInt(pool.repaymentAmountAtomic) < BigInt(pool.targetDistributionAtomic ?? BigInt(pool.subscribed) * BigInt(pool.targetRedemptionValueAtomic))) return no('partial recovery does not discharge the outstanding debt', 'outstanding_debt');
      return ok('Repaid');
    case 'MARK_DEFAULT':
      if (!isActive(from) && from !== 'Paused' && from !== 'Frozen') return no('the offering is not in a defaultable state');
      if (!subscribed) return no('nobody subscribed, so there is no debt to default', 'no_subscribers');
      if (!pool.overdue) return no('the debt has not reached maturity', 'not_overdue');
      return ok('Defaulted');
    case 'SETTLE_LOSS':
      if (from !== 'Defaulted') return no('only a defaulted offering can record a loss settlement');
      if (!subscribed) return no('nobody subscribed, so there is no loss to allocate', 'no_subscribers');
      return ok('LossSettled');
    case 'RESOLVE_LIQUIDATION':
      if (from !== 'Liquidation' && !(pool.controlVersion === 2 && from === 'Defaulted')) return no('the offering is not liquidating');
      if (!subscribed) return ok('Cancelled');
      return ok(BigInt(pool.recoveredAtomic ?? 0) >= BigInt(pool.outstandingAtomic ?? 0) ? 'Repaid' : 'LossSettled');
    case 'UNFREEZE':
      if (from !== 'Frozen') return no('the offering is not frozen');
      return ok(pool.stateBeforePause && isActive(pool.stateBeforePause) ? pool.stateBeforePause : 'Open');
    case 'DISBURSE':
      if (from !== 'Funded' && from !== 'InTransit') return no('only funded or in-transit offering can disburse');
      if (pool.controlVersion === 2 && (!pool.drawSourcesValid || pool.chainTimestamp == null || pool.disbursementDeadline == null || pool.maturityAt == null
        || BigInt(pool.chainTimestamp) >= BigInt(pool.disbursementDeadline) || BigInt(pool.chainTimestamp) >= BigInt(pool.maturityAt))) return no('draw sources or time bounds do not allow new risk');
      return ok(from, false);
    case 'REFUND':
      if (!['Open','Subscribed','Repriced','Paused','Frozen','Cancelled','Liquidation'].includes(from)) return no('not refundable');
      if (!subscribed && from !== 'Cancelled') return no('no subscribers to refund');
      return ok(from, false);
    case 'FINALIZE_FUNDING':
      if (!['Open', 'Subscribed', 'Repriced'].includes(from)) return no('not open');
      if (!pool.deadlinePassed || !pool.minimumRaised) return no('funding terms are not satisfied');
      return ok('Funded');
    case 'DEDUCT_FEE':
      if (pool.controlVersion === 2) return no('the controlled candidate has zero fees');
      if (!['Repaid', 'LossSettled'].includes(from) || pool.claimsStarted) return no('fees are locked');
      return ok(from, false);
    case 'CLAIM':
      if (from !== 'Repaid' && from !== 'LossSettled') return no('not claimable');
      return ok(from, false);
    case 'WARNING':
    case 'HOLD_FOR_REVIEW':
    case 'REJECT':
      return ok(from, false);
    default:
      return no('unknown action', 'unknown_action');
  }
}
