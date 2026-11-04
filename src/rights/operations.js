// Every role transaction the workspace can prepare, with the contract it is sent to and the function it calls.
// The server encodes plans from this table (src/rights/chain.js) and the browser refuses a plan that does not match it
// before the wallet sees it (web/src/lib/rights.js), so the two can no longer disagree about where an operation goes.
// It imports nothing, so the browser bundle can use it as it is.
//
// `target` names a contract of the verified instance: `controller` (RightsController), `registry` (CommittedEBLRegistry)
// or `pool` (RWAOfferingPoolV5). A lifecycle operation is RightsController.executeLifecycle(bytes) whose single argument
// is the call to the pool function named in `lifecycle`. Selectors are pinned and checked against every compiled ABI
// that can still prepare the operation (tests/rightsOperations.test.js): they are the same in v2, v3 and v4 for each
// operation those versions allow.
const lifecycle = (method, selector) => Object.freeze({ target: 'controller', method: 'executeLifecycle', selector: '0x43692577',
  lifecycle: Object.freeze({ method, selector }) });
const call = (target, method, selector) => Object.freeze({ target, method, selector });

export const RIGHTS_OPERATIONS = Object.freeze({
  register_title: call('registry', 'registerTitle', '0x295f5fb0'),
  pledge: call('registry', 'pledge', '0x04a289dc'),
  create_offering: call('controller', 'createControlledOffering', '0x46a84234'),
  set_eligibility: call('controller', 'setEligibility', '0x830c13de'),
  refresh_screening: call('controller', 'refreshScreening', '0xa5055fd3'),
  acknowledge_terms: call('controller', 'acknowledgeTerms', '0x104ef52b'),
  disburse: call('controller', 'disburse', '0x654156d9'),
  notify_resolution: call('controller', 'notifyResolution', '0x15db9b38'),
  review_resolution: call('controller', 'reviewResolution', '0xd0a12851'),
  finalize_resolution: call('controller', 'finalizeResolution', '0xf5489b7e'),
  start_exit: call('controller', 'startExit', '0x06f3a401'),
  dispute_resolution: call('controller', 'disputeResolution', '0x03b70036'),
  mark_in_transit: lifecycle('markInTransit', '0xa7d777cd'),
  mark_default: lifecycle('markDefault', '0xe1d927c8'),
  record_arrival: lifecycle('recordCargoArrival', '0xfe8d46d4'),
  record_payment: lifecycle('recordImporterPayment', '0xb1b5dd49'),
  settle: lifecycle('settle', '0x9a9c29f6'),
  cancel_offering: lifecycle('cancelOffering', '0xb659139c'),
  // Called on the pool itself: anyone may repay, close a raise that met its minimum once subscriptions end, or retry
  // releasing a title whose release failed.
  repay: call('pool', 'repay', '0xd8aed145'),
  finalize_funding: call('pool', 'finalizeFunding', '0xfb0f05b7'),
  retry_collateral_release: call('pool', 'retryCollateralRelease', '0x6f6de25b')
});

const SELECTOR = /^0x[0-9a-f]{8}/u;

/**
 * Whether `calldata` calls the function the table names for `operation`. For a lifecycle operation the inner call is
 * checked too; `decodeBytes(hex)` decodes the ABI-encoded `bytes` argument (ethers' AbiCoder in both callers), and a
 * value it cannot decode does not match.
 */
export function rightsCallMatches(operation, calldata, decodeBytes) {
  const spec = Object.hasOwn(RIGHTS_OPERATIONS, operation) ? RIGHTS_OPERATIONS[operation] : null;
  const data = String(calldata ?? '').toLowerCase();
  if (!spec || !SELECTOR.test(data) || data.slice(0, 10) !== spec.selector) return false;
  if (!spec.lifecycle) return true;
  let inner;
  try { inner = String(decodeBytes(`0x${data.slice(10)}`)).toLowerCase(); } catch { return false; }
  return SELECTOR.test(inner) && inner.slice(0, 10) === spec.lifecycle.selector;
}

/** The address an operation must be sent to, from the instance's verified controller, registry and pool. */
export function rightsTarget(operation, { controller, registry, pool }) {
  const spec = Object.hasOwn(RIGHTS_OPERATIONS, operation) ? RIGHTS_OPERATIONS[operation] : null;
  return spec ? { controller, registry, pool }[spec.target] ?? null : null;
}
