// Legal offering-state transitions for each agent action. One table, used by the Demo executor (to
// change the offchain pool), by the chain executor (to refuse a transaction that would only revert)
// and by the owner-CLI plan builder, so a Demo run and a Live run agree on what is allowed.
//
// The rules mirror hardhat/contracts/RWAOfferingPool.sol. If a rule here is wrong the contract is
// still the final authority: the chain executor also runs a staticCall before it sends anything.

/** RWAOfferingPool.OfferingState, in the contract's enum order (index = on-chain value). */
export const CHAIN_STATE_NAMES = Object.freeze([
  'Created', 'Priced', 'Open', 'Subscribed', 'Funded', 'InTransit', 'Repriced',
  'Paused', 'Frozen', 'Repaid', 'Redeemed', 'Liquidation', 'Cancelled'
]);

export const ACTIVE_STATES = Object.freeze(['Open', 'Subscribed', 'Funded', 'InTransit', 'Repriced']);
export const TERMINAL_STATES = Object.freeze(['Repaid', 'Redeemed', 'Liquidation', 'Cancelled']);

export function chainStateName(index) {
  const name = CHAIN_STATE_NAMES[Number(index)];
  if (!name) throw new RangeError(`Unknown on-chain offering state: ${String(index)}`);
  return name;
}

const isActive = (state) => ACTIVE_STATES.includes(state);

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
      return isActive(from) ? ok('Repriced') : no('the offering is not active');
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
      return ['Open', 'Repriced', 'Paused'].includes(from) ? ok('Cancelled') : no('only an unsubscribed open, repriced or paused offering can be cancelled');
    case 'MARK_IN_TRANSIT':
      return from === 'Funded' || from === 'Subscribed' ? ok('InTransit') : no('the offering is not funded');
    case 'RECORD_PAYMENT':
      if (!isActive(from)) return no('the offering is not in a settleable state');
      if (!subscribed) return no('nobody subscribed, so there is nothing to repay', 'no_subscribers');
      if (pool.paymentProof) return no('a payment proof is already recorded', 'already_recorded');
      return ok(from, false);
    case 'RECORD_ARRIVAL':
      if (!isActive(from)) return no('the offering is not in a settleable state');
      if (!subscribed) return no('nobody subscribed, so there is nothing to repay', 'no_subscribers');
      if (pool.arrivalProof) return no('an arrival proof is already recorded', 'already_recorded');
      return ok(from, false);
    case 'SETTLE':
      if (!isActive(from)) return no('the offering is not in a settleable state');
      if (!subscribed) return no('nobody subscribed, so there is nothing to repay', 'no_subscribers');
      if (!pool.paymentProof || !pool.arrivalProof) return no('both the payment proof and the arrival proof are required first', 'proofs_missing');
      return ok('Repaid');
    case 'WARNING':
    case 'HOLD_FOR_REVIEW':
    case 'REJECT':
      return ok(from, false);
    default:
      return no('unknown action', 'unknown_action');
  }
}
