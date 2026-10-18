import path from 'node:path';
import { isAddress } from 'ethers';
import { loadRightsChain } from '../rights/chain.js';
import { readJson } from '../lib/jsonStore.js';
import { Ledger } from '../ledger/ledger.js';
import { CapitalLedgerService } from '../ledger/service.js';
import { runtimeDir } from '../runtimePaths.js';
import { PROTOCOL_V5_ABI } from '../chain/protocolV5Abi.js';
import { chainStateName } from '../agent/runtime/poolRules.js';
import { HttpError, readJsonBody, sendJson } from './http.js';

export function controlledCapitalConfig(configuration) {
  return { protocolVersion: 5, chainIdDecimal: Number(configuration.chain_id), confirmations: Number(configuration.chain_id) === 31337 ? 1 : 3, explorerBase: 'https://testnet.blockscout.injective.network',
    contracts: { RWAOfferingPool: configuration.contracts.RWAOfferingPoolV5, RWAToken: configuration.contracts.ControlledRWAToken },
    abis: { RWAOfferingPool: PROTOCOL_V5_ABI.RWAOfferingPool },
    deployments: { RWAOfferingPool: { blockNumber: configuration.deployment_block } } };
}
/** An explicit W3 instance and its own ledger. Legacy numbered pools are never reinterpreted. */
export function createControlledRoutes({ env = process.env, getMode = () => 'demo', chain: suppliedChain, configuration: suppliedConfig } = {}) {
  let context, loading;
  const load = async () => {
    if (context) return context;
    loading ??= (async () => {
      if (!suppliedConfig && !env.AGENTBL_RIGHTS_CONFIG) throw new HttpError(503, 'controlled_instance_unavailable', 'No controlled testnet instance is configured');
      const configuration = suppliedConfig ?? await readJson(env.AGENTBL_RIGHTS_CONFIG);
      if (!Number.isSafeInteger(configuration?.deployment_block) || configuration.deployment_block < 0) throw new HttpError(503, 'controlled_deployment_block_required', 'A verified deployment block is required');
      const chain = suppliedChain ?? await loadRightsChain(env.AGENTBL_RIGHTS_CONFIG); await chain.verify();
      const config = controlledCapitalConfig(configuration);
      const ledger = new Ledger({ baseDir: path.join(runtimeDir(env), `controlled-capital-${config.contracts.RWAOfferingPool.toLowerCase()}`) });
      const capital = new CapitalLedgerService({ ledger, chainConfig: config, getMode, confirmations: Number(configuration.chain_id) === 31337 ? 1 : 3,
        getContext: async () => { await chain.verify(); return { provider: chain.provider }; } });
      context = { chain, config, capital, configuration }; return context;
    })().catch((error) => { loading = null; throw error; });
    return loading;
  };
  const handle = async (request, response, url) => {
    if (!url.pathname.startsWith('/api/controlled/')) return false;
    response.setHeader('Cache-Control', 'no-store');
    const route = url.pathname.slice('/api/controlled/'.length), method = request.method;
    if (route === 'status' && method === 'GET' && !suppliedConfig && !env.AGENTBL_RIGHTS_CONFIG) {
      sendJson(response, 200, { active: false, scope: 'research_test_assets_only', business_enabled: false }); return true;
    }
    const { chain, capital, config } = await load();
    await chain.verify();
    let result;
    if (route === 'status' && method === 'GET') result = { active: true, scope: 'research_test_assets_only', business_enabled: false, mode: getMode(),
      controller: await chain.controller.getAddress(), config, terms_acceptance_required: true, eligibility_required: true };
    else if (route === 'offerings' && method === 'GET') {
      const from = Number(url.searchParams.get('from') ?? 1), limit = Number(url.searchParams.get('limit') ?? 10);
      if (!Number.isSafeInteger(from) || from < 1 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new HttpError(400, 'invalid_pagination', 'A positive cursor and limit up to 20 are required');
      const block = await chain.provider.getBlock('latest'), readAt = { blockTag: block.number };
      const next = Number(await chain.pool.nextPoolId(readAt));
      const offerings = [];
      for (let poolId = from; poolId < Math.min(next, from + limit); poolId++) {
        const [offer, termsHash, version, deadline, maturity, disbursed, recovered, terms] = await Promise.all([
          chain.pool.offerings(poolId, readAt), chain.controller.termsHash(poolId, readAt), chain.pool.quoteVersion(poolId, readAt), chain.pool.subscriptionDeadline(poolId, readAt),
          chain.pool.maturityAt(poolId, readAt), chain.pool.disbursedAtomic(poolId, readAt), chain.pool.recoveredAtomic(poolId, readAt), chain.controller.terms(poolId, readAt) ]);
        const escrow = await chain.pool.escrowed(poolId, offer.settlementAsset, readAt);
        offerings.push({ pool_id: poolId, state: chainStateName(offer.state), shares: String(offer.tokenSupply), subscribed: String(offer.subscribed),
          issue_price_atomic: String(offer.issuePrice), redemption_per_share_atomic: String(offer.targetRedemptionValue), settlement_asset: offer.settlementAsset,
          raised_atomic: String(offer.raisedAtomic), disbursed_atomic: String(disbursed), recovered_atomic: String(recovered), escrow_atomic: String(escrow),
          subscription_deadline: String(deadline), maturity: String(maturity), quote_version: String(version), terms_hash: termsHash,
          policy_hash: terms.policyHash, disclosure_hash: terms.disclosureHash, block_number: block.number,
          subscription_open: [2, 3, 6].includes(Number(offer.state)) && Number(deadline) >= block.timestamp && offer.subscribed < offer.tokenSupply });
      }
      if ((await chain.provider.getBlock(block.number))?.hash !== block.hash) throw new HttpError(503, 'chain_reconciliation_required', 'The offering snapshot was reorganized; refresh before reviewing');
      result = { offerings, next_cursor: from + limit < next ? from + limit : null, scope: 'research_test_assets_only', config };
    } else if (route === 'positions' && method === 'GET') {
      const wallet = url.searchParams.get('wallet'); if (!isAddress(wallet)) throw new HttpError(400, 'invalid_wallet', 'A valid EVM wallet is required');
      result = await capital.list(wallet);
    } else if (route === 'subscription-intents' && method === 'POST') {
      if (request.socket.server?.operations && !request.socket.server.operations.readiness().ok) throw new HttpError(503, 'operations_not_ready', 'Controlled intake is paused');
      result = { intent: await capital.prepareSubscription(await readJsonBody(request)) };
    } else if (route === 'claim-intents' && method === 'POST') result = { intent: await capital.prepareClaim(await readJsonBody(request)) };
    else if (route === 'refund-intents' && method === 'POST') result = { intent: await capital.prepareRefund(await readJsonBody(request)) };
    else if (/^intents\/[a-f0-9-]{36}\/broadcast$/u.test(route) && method === 'POST') result = { intent: await capital.checkpointBroadcast(route.split('/')[1]) };
    else if (/^intents\/[a-f0-9-]{36}\/transaction$/u.test(route) && method === 'POST') result = { intent: await capital.attach(route.split('/')[1], (await readJsonBody(request))?.tx_hash) };
    else if (/^intents\/[a-f0-9-]{36}$/u.test(route) && method === 'GET') {
      result = { intent: await capital.recoverIntent(route.split('/')[1]) };
    } else throw new HttpError(404, 'not_found', 'Unknown controlled financing route');
    sendJson(response, 200, result); return true;
  };
  handle.close = async () => { if (context && !suppliedChain) await context.chain.provider.destroy(); };
  handle.health = async () => { const { capital } = await load(); const { cursor } = await capital.sync(); return { ledger_confirmed_block: cursor?.last_block ?? null }; };
  return handle;
}
