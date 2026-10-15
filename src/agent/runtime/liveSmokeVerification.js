// Read-only receipt verification against RWAOfferingPool's actual pricing semantics.
// PAUSE/RESUME commit a quote in the oracle but leave the offering price unchanged.
import { toChainPricingArgs } from '../../core/oracle.js';
import { oracleDecisionId, PRICING_ACTION_FOR } from './executors/chainExecutor.js';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const active = (state) => [2, 3, 4, 5, 6].includes(Number(state));

export async function readSmokeChain(context, config, decision, { historical = false } = {}) {
  const { provider, pool, oracle } = context;
  const chainId = Number(await provider.send('eth_chainId', []));
  if (chainId !== Number(config.chainIdDecimal)) throw new Error('RPC chain mismatch');
  const view = async (blockTag) => {
    const options = blockTag === undefined ? {} : { blockTag };
    const [state, offering, stopped] = await Promise.all([pool.stateOf(2, options), pool.offerings(2, options), pool.emergencyStopped(options)]);
    if (!offering.exists || stopped) throw new Error('Pool #2 is unavailable or emergency stopped');
    return { chain_id: chainId, state: Number(state), issue_price_e6: String(offering.issuePrice), emergency_stopped: false };
  };
  if (!decision) return view();
  if (Number(decision.chain_pool_id) !== 2 || !['REPRICE', 'PAUSE', 'RESUME'].includes(decision.proposed_action)) throw new Error('Unexpected smoke command');
  const [receipt, tx, latest] = await Promise.all([provider.getTransactionReceipt(decision.execution.tx_hash),
    provider.getTransaction(decision.execution.tx_hash), provider.getBlockNumber()]);
  if (!receipt || !tx) throw new Error('Smoke transaction is unconfirmed');
  const args = toChainPricingArgs({ ...decision.proposal.params.quote, pricing_action: PRICING_ACTION_FOR[decision.proposed_action] }, { pool_id: 2 });
  const [before, after, canonical, current, processed] = await Promise.all([view(receipt.blockNumber - 1), view(receipt.blockNumber),
    provider.getBlock(receipt.blockNumber), historical ? null : view(), oracle.isDecisionProcessed(await oracleDecisionId(args))]);
  const events = receipt.logs.flatMap((log) => {
    const contract = same(log.address, config.contracts.RiskPricingOracle) ? oracle
      : same(log.address, config.contracts.RWAOfferingPool) ? pool : null;
    if (!contract) return [];
    try { const parsed = contract.interface.parseLog(log); return parsed ? [parsed] : []; } catch { return []; }
  });
  const pricing = events.find((event) => event.name === 'PricingUpdated');
  const expectedArgs = [args.pool_id, args.issue_price_e6, args.risk_level, args.pricing_action, args.evidence_hash, args.quote_hash];
  let calldata = false;
  try { const decoded = oracle.interface.decodeFunctionData('updatePricing', tx.data); calldata = expectedArgs.every((v, i) => same(v, decoded[i])); } catch { /* invalid calldata */ }
  const exactPricing = pricing && expectedArgs.every((v, i) => same(v, pricing.args[i])) && same(pricing.args[6], tx.from);
  const transition = events.find((event) => event.name === 'OfferingStateChanged' && same(event.args[0], 2)
    && same(event.args[1], before.state) && same(event.args[2], after.state) && same(event.args[3], args.pricing_action));
  let effects;
  if (decision.proposed_action === 'REPRICE') {
    const repriced = events.find((event) => event.name === 'OfferingRepriced' && [2, before.issue_price_e6, args.issue_price_e6, args.evidence_hash, args.quote_hash]
      .every((v, i) => same(v, event.args[i])));
    effects = active(before.state) && after.state === 6 && BigInt(args.issue_price_e6) < BigInt(before.issue_price_e6)
      && after.issue_price_e6 === String(args.issue_price_e6) && Boolean(repriced) && (before.state === 6 || Boolean(transition));
  } else if (decision.proposed_action === 'PAUSE') {
    effects = active(before.state) && after.state === 7 && after.issue_price_e6 === before.issue_price_e6 && Boolean(transition)
      && events.some((event) => event.name === 'OfferingPaused' && same(event.args[0], 2) && same(event.args[1], args.evidence_hash));
  } else {
    effects = before.state === 7 && active(after.state) && after.issue_price_e6 === before.issue_price_e6 && Boolean(transition)
      && events.some((event) => event.name === 'OfferingResumed' && [2, after.state, args.evidence_hash].every((v, i) => same(v, event.args[i])));
  }
  return { ...after, quote_issue_price_e6: String(args.issue_price_e6), before, historical,
    transaction_block: receipt.blockNumber, calldata_exact: calldata, oracle_processed: processed,
    verified: receipt.status === 1 && latest >= receipt.blockNumber && same(canonical?.hash, receipt.blockHash)
      && Number(tx.chainId) === chainId && same(tx.to, config.contracts.RiskPricingOracle) && Boolean(exactPricing) && calldata && processed && effects
      && (historical || current.state === after.state && current.issue_price_e6 === after.issue_price_e6) };
}
