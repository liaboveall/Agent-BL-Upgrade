import { currentWalletSession, subscribeOffering, claimPosition, loadEthers } from './web3.js';
import { rightsSessionToken } from './rights-session.js';
export async function controlledRequest(route, body) {
  const token = rightsSessionToken();
  const response = await fetch(`/api/controlled/${route}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', ...(token ? { 'x-rights-session': token } : {}) } });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error ?? value.message ?? 'Controlled financing unavailable'), { code: value.code });
  return value;
}
export function controlledIntentOptions(config, onIntent, assertCurrent, disclosureHash) {
  const prepare = (route) => async (body) => { const { intent } = await controlledRequest(route, { ...body, ...(route === 'subscription-intents' ? { reviewed_disclosure_hash: disclosureHash } : {}) }); onIntent(intent); return intent; };
  return { getConfig: async () => config, getSession: currentWalletSession, assertCurrent,
    prepareIntent: prepare('subscription-intents'), prepareClaim: prepare('claim-intents'),
    attachIntent: async (id, txHash) => (await controlledRequest(`intents/${id}/transaction`, { tx_hash: txHash })).intent,
    beforeBroadcast: async (intent) => { const { intent: checkpoint } = await controlledRequest(`intents/${intent.intent_id}/broadcast`, {}); onIntent(checkpoint); return checkpoint; } };
}
export async function acknowledgeControlledTerms(offer, status, assertCurrent, revalidate = async () => {}) {
  const session = currentWalletSession(); if (!session?.signer) throw new Error('Connect an EVM wallet');
  const { Contract } = await loadEthers();
  const controller = new Contract(status.controller, ['function capitalPool() view returns (address)', 'function acknowledgeTerms(uint256,bytes32,uint256,uint64)'], session.signer);
  const network = await session.signer.provider.getNetwork();
  if (Number(network.chainId) !== status.config.chainIdDecimal || (await controller.capitalPool()).toLowerCase() !== status.config.contracts.RWAOfferingPool.toLowerCase()) throw new Error('Controlled deployment or wallet network changed');
  assertCurrent();
  const args = [offer.pool_id, offer.terms_hash, offer.quote_version, offer.subscription_deadline];
  await controller.acknowledgeTerms.staticCall(...args); await revalidate(); assertCurrent();
  const tx = await controller.acknowledgeTerms(...args); await tx.wait(status.config.confirmations ?? 1);
  return { txHash: tx.hash };
}
export async function subscribeControlled(offer, shares, status, options) {
  return subscribeOffering({ shares, chain: { chain_id: status.config.chainIdDecimal,
    contract: status.config.contracts.RWAOfferingPool, pool_id: offer.pool_id, price_e6: offer.issue_price_atomic,
    settlement_asset: offer.settlement_asset, quote_version: offer.quote_version } }, options);
}
export const claimControlled = (position, options) => claimPosition(position, options);
export async function refundControlled(position, config, options) {
  const session = currentWalletSession(), { Contract } = await loadEthers();
  if (!session?.signer || session.address.toLowerCase() !== position.investor.toLowerCase()) throw new Error('Wallet changed');
  const pi = position.protocol_instance;
  if (!position.reconciled || Number(pi.chain_id) !== config.chainIdDecimal || pi.pool_address.toLowerCase() !== config.contracts.RWAOfferingPool.toLowerCase()) throw new Error('Position deployment changed');
  options.assertCurrent();
  const { intent: prepared } = await controlledRequest('refund-intents', { wallet: session.address, chain_pool_id: position.chain_pool_id });
  let intent = prepared; options.onIntent?.(intent);
  const pool = new Contract(pi.pool_address, ['function refundInvestor(uint256,address)', 'event InvestorRefunded(uint256 indexed poolId,address indexed investor,address indexed asset,uint256 amountAtomic)'], session.signer);
  if (intent.calldata.toLowerCase() !== pool.interface.encodeFunctionData('refundInvestor', [position.chain_pool_id, session.address]).toLowerCase()) throw new Error('Refund intent changed');
  const network = await session.signer.provider.getNetwork(); if (Number(network.chainId) !== config.chainIdDecimal) throw new Error('Wallet network changed');
  await pool.refundInvestor.staticCall(position.chain_pool_id, session.address);
  intent = await options.beforeBroadcast(intent); options.assertCurrent();
  const tx = await pool.refundInvestor(position.chain_pool_id, session.address, { nonce: intent.broadcast_nonce });
  try {
    await options.attachIntent(intent.intent_id, tx.hash); const receipt = await tx.wait(config.confirmations ?? 1);
    const event = receipt.logs.filter((log) => log.address.toLowerCase() === pi.pool_address.toLowerCase()).map((log) => { try { return pool.interface.parseLog(log); } catch { return null; } })
      .find((log) => log?.name === 'InvestorRefunded' && BigInt(log.args.poolId) === BigInt(position.chain_pool_id) && log.args.investor.toLowerCase() === session.address.toLowerCase()
        && log.args.asset.toLowerCase() === intent.asset.toLowerCase() && String(log.args.amountAtomic) === intent.amount_atomic);
    if (receipt.status !== 1 || !event || (await options.attachIntent(intent.intent_id, tx.hash)).status !== 'confirmed') throw new Error('Refund receipt requires reconciliation');
    return { txHash: tx.hash };
  } catch { throw Object.assign(new Error('Refund submitted; reconcile the original transaction before another operation'), { code: 'RECONCILIATION_REQUIRED', txHash: tx.hash }); }
}
