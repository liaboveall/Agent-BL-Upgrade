import path from 'node:path';
import { isAddress } from 'ethers';
import { loadRightsChain, verifyChain } from '../rights/chain.js';
import { readJson } from '../lib/jsonStore.js';
import { Ledger } from '../ledger/ledger.js';
import { CapitalLedgerService } from '../ledger/service.js';
import { runtimeDir } from '../runtimePaths.js';
import { PROTOCOL_V5_ABI } from '../chain/protocolV5Abi.js';
import { RpcReadPool, readPage } from '../rights/reads.js';
import { readOfferings } from '../rights/offerings.js';
import { HttpError, readJsonBody, sendJson } from './http.js';
import { RightsService } from '../rights/service.js';
import { financingReview } from '../rights/financingReview.js';
import { CONTROL_VERSION } from '../rights/typedData.js';
import { assertIntakeOpen, isNewIntake, requestReadiness } from '../ops/intakePolicy.js';

export function controlledCapitalConfig(configuration) {
  return { protocolVersion: 5, controlVersion: configuration.control_version, chainIdDecimal: Number(configuration.chain_id), confirmations: Number(configuration.chain_id) === 31337 ? 1 : 3, explorerBase: 'https://testnet.blockscout.injective.network',
    contracts: { RWAOfferingPool: configuration.contracts.RWAOfferingPoolV5, RWAToken: configuration.contracts.ControlledRWAToken },
    abis: { RWAOfferingPool: PROTOCOL_V5_ABI.RWAOfferingPool },
    deployments: { RWAOfferingPool: { blockNumber: configuration.deployment_block } } };
}
/** An explicit W3 instance and its own ledger. Legacy numbered pools are never reinterpreted. */
export function createControlledRoutes({ env = process.env, getMode = () => 'demo', chain: suppliedChain, configuration: suppliedConfig, getGeneration = () => 0, readPool = suppliedChain?.readPool ?? new RpcReadPool(), intakeGate = () => ({ ok: true }),
  disclosures = new RightsService({ directory: path.join(runtimeDir(env), 'rights'), env }) } = {}) {
  let context, loading;
  const load = async () => {
    if (context) return context;
    loading ??= (async () => {
      if (!suppliedConfig && !env.AGENTBL_RIGHTS_CONFIG) throw new HttpError(503, 'controlled_instance_unavailable', 'No controlled testnet instance is configured');
      const configuration = suppliedConfig ?? await readJson(env.AGENTBL_RIGHTS_CONFIG);
      if (!Number.isSafeInteger(configuration?.deployment_block) || configuration.deployment_block < 0) throw new HttpError(503, 'controlled_deployment_block_required', 'A verified deployment block is required');
      const chain = suppliedChain ?? await loadRightsChain(env.AGENTBL_RIGHTS_CONFIG); const binding = await chain.verify({ read: readPool.budget(100).read });
      const config = controlledCapitalConfig({ ...configuration, control_version: binding.control_version });
      const ledger = new Ledger({ baseDir: path.join(runtimeDir(env), `controlled-capital-${config.contracts.RWAOfferingPool.toLowerCase()}`) });
      const capital = new CapitalLedgerService({ ledger, chainConfig: config, getMode, getGeneration, readPool, confirmations: Number(configuration.chain_id) === 31337 ? 1 : 3,
        getContext: async () => { await verifyChain(chain, { read: readPool.budget(100).read }); return { provider: chain.provider }; } });
      context = { chain, config, capital, configuration }; return context;
    })().catch((error) => { loading = null; throw error; });
    return loading;
  };
  const handle = async (request, response, url) => {
    if (!url.pathname.startsWith('/api/controlled/')) return false;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'x-rights-session');
    const route = url.pathname.slice('/api/controlled/'.length), method = request.method;
    // The shared intake policy (src/ops/intakePolicy.js), also when mounted without the global guard in front.
    const readiness = requestReadiness(request, intakeGate);
    if (isNewIntake(method, url.pathname)) assertIntakeOpen(readiness(), 'Controlled intake is paused');
    if (route === 'status' && method === 'GET' && !suppliedConfig && !env.AGENTBL_RIGHTS_CONFIG) {
      sendJson(response, 200, { active: false, scope: 'research_test_assets_only', business_enabled: false }); return true;
    }
    const { chain, capital, config } = await load();
    const pagedRead = route === 'offerings' || /^offerings\/[1-9]\d*$/u.test(route);
    if (!pagedRead) await verifyChain(chain, { read: readPool.budget(100).read });
    const authorizeWallet = async (wallet, saved, broadcast = false, allowExitOnly = false) => {
      // Supplied read-only fixture adapters do not implement business sessions.
      if (typeof disclosures.principal !== 'function') return null;
      const principal = await disclosures.principal(String(request.headers['x-rights-session'] ?? ''), { allowExitOnly });
      if (principal.wallet.toLowerCase() !== String(wallet).toLowerCase() || saved?.authorization_subject && saved.authorization_subject !== principal.subject_id) throw new HttpError(404, 'controlled_intent_not_found', 'Wallet operation not found');
      if (broadcast && saved.authorization_session && saved.authorization_session !== principal.session_id) throw new HttpError(409, 'execution_context_changed', 'Session changed; review a new draft');
      return { authorization_subject: principal.subject_id, authorization_session: principal.session_id };
    };
    let result;
    if (route === 'status' && method === 'GET') result = { active: true, scope: 'research_test_assets_only', business_enabled: false, mode: getMode(),
      controller: await chain.controller.getAddress(), config, terms_acceptance_required: true, eligibility_required: true,
      // A superseded control version keeps only the exits that add no new risk (src/rights/chain.js LEGACY_OPERATIONS).
      exit_only: Number(config.controlVersion) < CONTROL_VERSION };
    else if (pagedRead && method === 'GET') {
      const query = readPage(url.searchParams);
      if (route !== 'offerings') { query.pool_id = Number(route.split('/')[1]); if (!Number.isSafeInteger(query.pool_id)) throw new HttpError(400, 'invalid_pool_id', 'A safe positive pool ID is required'); }
      result = await readOfferings(chain, config, readPool, query);
    } else if (/^offerings\/[1-9]\d*\/terms$/u.test(route) && method === 'GET') {
      // Reading terms is history: they stay readable after a role change or on a superseded instance, with `current`
      // saying why nothing new may be signed on them. Accepting and subscribing below still require current terms.
      result = await financingReview(chain, disclosures, route.split('/')[1], { requireCurrent: false });
      if (url.searchParams.get('download') === '1') response.setHeader('Content-Disposition', `attachment; filename="financing-terms-${result.pool_id}.json"`);
    } else if (route === 'positions' && method === 'GET') {
      const wallet = url.searchParams.get('wallet'); if (!isAddress(wallet)) throw new HttpError(400, 'invalid_wallet', 'A valid EVM wallet is required');
      result = await capital.list(wallet, [], readPage(url.searchParams));
    } else if (route === 'subscription-intents' && method === 'POST') {
      const body = await readJsonBody(request);
      const authorization = await authorizeWallet(body?.wallet);
      if (getMode() !== 'live') throw new HttpError(409, 'live_mode_required', 'Switch to Live before preparing a wallet transaction');
      if (!/^[1-9]\d*$/u.test(String(body?.chain_pool_id))) throw new HttpError(400, 'invalid_subscription', 'A positive pool ID is required');
      const reviewed = await financingReview(chain, disclosures, body.chain_pool_id);
      if (body.reviewed_disclosure_hash !== reviewed.disclosure_hash || String(body.expected_quote_version) !== reviewed.quote_version) {
        throw new HttpError(409, 'financing_review_required', 'Review the current complete disclosure and quote before subscription');
      }
      result = { intent: await capital.prepareSubscription({ ...body, ...authorization }, { readiness }) };
    } else if (['claim-intents', 'refund-intents'].includes(route) && method === 'POST') {
      const body = await readJsonBody(request), authorization = await authorizeWallet(body?.wallet, null, false, true);
      result = { intent: await capital[route === 'claim-intents' ? 'prepareClaim' : 'prepareRefund']({ ...body, ...authorization }) };
    }
    else if (/^intents\/[a-f0-9-]{36}\/broadcast$/u.test(route) && method === 'POST') {
      const intent = await capital.ledger.getIntent(route.split('/')[1]);
      if (!intent) throw new HttpError(404, 'controlled_intent_not_found', 'Wallet operation not found');
      await authorizeWallet(intent.investor, intent, true, ['CLAIM', 'REFUND'].includes(intent.operation));
      if (intent?.operation === 'SUBSCRIBE') {
        const reviewed = await financingReview(chain, disclosures, intent.chain_pool_id);
        if (intent.reviewed_disclosure_hash !== reviewed.disclosure_hash || intent.reviewed_quote_version !== reviewed.quote_version) throw new HttpError(409, 'financing_review_required', 'Saved review changed; do not broadcast');
      }
      result = { intent: await capital.checkpointBroadcast(route.split('/')[1], { readiness }) };
    }
    else if (/^intents\/[a-f0-9-]{36}\/transaction$/u.test(route) && method === 'POST') {
      const intent = await capital.ledger.getIntent(route.split('/')[1]);
      if (!intent) throw new HttpError(404, 'controlled_intent_not_found', 'Wallet operation not found');
      await authorizeWallet(intent.investor, intent, false, true);
      result = { intent: await capital.attach(intent.intent_id, (await readJsonBody(request))?.tx_hash) };
    }
    else if (/^intents\/[a-f0-9-]{36}\/release$/u.test(route) && method === 'POST') {
      // The wallet reported that it did not send: the service checks the chain before it lets the wallet send again.
      const intent = await capital.ledger.getIntent(route.split('/')[1]);
      if (!intent) throw new HttpError(404, 'controlled_intent_not_found', 'Wallet operation not found');
      await authorizeWallet(intent.investor, intent, false, true);
      result = { intent: await capital.releaseIntent(intent.intent_id) };
    }
    else if (route === 'intents' && method === 'GET') {
      // Lets another browser (or a cleared one) find the operation that holds this wallet's next send.
      const wallet = url.searchParams.get('wallet'); if (!isAddress(wallet)) throw new HttpError(400, 'invalid_wallet', 'A valid EVM wallet is required');
      await authorizeWallet(wallet, null, false, true);
      result = { intents: await capital.openIntents(wallet) };
    }
    else if (/^intents\/[a-f0-9-]{36}$/u.test(route) && method === 'GET') {
      const intent = await capital.ledger.getIntent(route.split('/')[1]);
      if (!intent) throw new HttpError(404, 'controlled_intent_not_found', 'Wallet operation not found');
      await authorizeWallet(intent.investor, intent, false, true);
      result = { intent: await capital.recoverIntent(intent.intent_id) };
    } else throw new HttpError(404, 'not_found', 'Unknown controlled financing route');
    sendJson(response, 200, result); return true;
  };
  handle.close = async () => { if (context && !suppliedChain) await context.chain.provider.destroy(); };
  handle.health = async () => { const { capital } = await load(); const { cursor } = await capital.sync(); return { ledger_confirmed_block: cursor?.last_block ?? null }; };
  return handle;
}
