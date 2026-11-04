import { rightsCallMatches, rightsTarget } from '../../../src/rights/operations.js';

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** Execute only a durable server plan after the UI's explicit wallet confirmation.
 * Any uncertain send is left for receipt reconciliation; this adapter never retries.
 *
 * Before the wallet sees anything the plan must match the instance on the wallet's own network: its controller's
 * pool and registry, the contract the operation table names for it (src/rights/operations.js) and the function that
 * table pins, the wallet, the chain and the reserved nonce. `instance` ({ chainId, controller, pool }), when given, is
 * the instance the page shows; a plan for any other one is refused. */
export async function sendRightsPlan(plan, { session, attachTransaction, beforeBroadcast, instance, assertCurrent = () => {}, ethersFn = () => import('ethers') } = {}) {
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  if (plan?.scope !== 'research_test_assets_only' || plan.execution !== 'unsigned_dry_run'
    || !session?.signer || String(plan.from).toLowerCase() !== String(session.address).toLowerCase() || plan.tx_hash) fail('RIGHTS_PLAN_MISMATCH');
  if (instance && (String(instance.chainId) !== String(plan.chain_id) || instance.pool && !same(instance.pool, plan.pool)
    || instance.controller && !same(instance.controller, plan.controller))) fail('RIGHTS_INSTANCE_CHANGED');
  const { AbiCoder, Contract } = await ethersFn();
  const provider = session.signer.provider;
  const [network, address, nonce] = await Promise.all([provider.getNetwork(), session.signer.getAddress(), provider.getTransactionCount(plan.from, 'pending')]);
  if (String(network.chainId) !== String(plan.chain_id) || address.toLowerCase() !== plan.from.toLowerCase() || nonce !== plan.nonce) fail('RIGHTS_WALLET_CHANGED');
  const controller = new Contract(plan.controller, ['function capitalPool() view returns (address)', 'function registry() view returns (address)'], provider);
  const [pool, registry] = await Promise.all([controller.capitalPool(), controller.registry()]);
  const decodeBytes = (hex) => AbiCoder.defaultAbiCoder().decode(['bytes'], hex)[0];
  if (!same(pool, plan.pool) || !same(plan.to, rightsTarget(plan.operation, { controller: plan.controller, registry, pool }))
    || !rightsCallMatches(plan.operation, plan.calldata, decodeBytes)) fail('RIGHTS_PROTOCOL_CHANGED');
  const transaction = { from: plan.from, to: plan.to, data: plan.calldata, value: 0n, nonce: plan.nonce, chainId: BigInt(plan.chain_id) };
  await provider.call(transaction);
  assertCurrent();
  if (beforeBroadcast) {
    const checked = await beforeBroadcast(plan);
    if (checked.calldata !== plan.calldata || checked.to !== plan.to || checked.nonce !== plan.nonce) fail('RIGHTS_PLAN_MISMATCH');
  }
  assertCurrent();
  let sent;
  try { sent = await session.signer.sendTransaction(transaction); }
  catch (error) {
    if (error?.code === 'ACTION_REJECTED' || error?.code === 4001) throw error;
    throw Object.assign(new Error('Reconcile the saved plan and wallet transaction before sending again'), { code: 'RECONCILIATION_REQUIRED', plan_id: plan.plan_id });
  }
  try { return await attachTransaction(plan.plan_id, sent.hash); }
  catch { throw Object.assign(new Error('Transaction sent; reconcile the saved plan before continuing'), { code: 'RECONCILIATION_REQUIRED', plan_id: plan.plan_id, tx_hash: sent.hash }); }
}
