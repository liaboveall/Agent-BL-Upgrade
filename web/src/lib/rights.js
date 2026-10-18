/** Execute only a durable server plan after the UI's explicit wallet confirmation.
 * Any uncertain send is left for receipt reconciliation; this adapter never retries. */
export async function sendRightsPlan(plan, { session, attachTransaction, ethersFn = () => import('ethers') } = {}) {
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  if (plan?.scope !== 'research_test_assets_only' || plan.execution !== 'unsigned_dry_run'
    || !session?.signer || String(plan.from).toLowerCase() !== String(session.address).toLowerCase() || plan.tx_hash) fail('RIGHTS_PLAN_MISMATCH');
  const { Contract } = await ethersFn();
  const provider = session.signer.provider;
  const [network, address, nonce] = await Promise.all([provider.getNetwork(), session.signer.getAddress(), provider.getTransactionCount(plan.from, 'pending')]);
  if (String(network.chainId) !== String(plan.chain_id) || address.toLowerCase() !== plan.from.toLowerCase() || nonce !== plan.nonce) fail('RIGHTS_WALLET_CHANGED');
  const controller = new Contract(plan.controller, ['function capitalPool() view returns (address)', 'function registry() view returns (address)'], provider);
  const [pool, registry] = await Promise.all([controller.capitalPool(), controller.registry()]);
  if (pool.toLowerCase() !== plan.pool.toLowerCase() || ![plan.controller, registry].some((allowed) => allowed.toLowerCase() === plan.to.toLowerCase())) fail('RIGHTS_PROTOCOL_CHANGED');
  const transaction = { from: plan.from, to: plan.to, data: plan.calldata, value: 0n, nonce: plan.nonce, chainId: BigInt(plan.chain_id) };
  await provider.call(transaction);
  let sent;
  try { sent = await session.signer.sendTransaction(transaction); }
  catch (error) {
    if (error?.code === 'ACTION_REJECTED' || error?.code === 4001) throw error;
    throw Object.assign(new Error('Reconcile the saved plan and wallet transaction before sending again'), { code: 'RECONCILIATION_REQUIRED', plan_id: plan.plan_id });
  }
  try { return await attachTransaction(plan.plan_id, sent.hash); }
  catch { throw Object.assign(new Error('Transaction sent; reconcile the saved plan before continuing'), { code: 'RECONCILIATION_REQUIRED', plan_id: plan.plan_id, tx_hash: sent.hash }); }
}
