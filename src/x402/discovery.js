// Bazaar HTTP body declaration, checked against the x402 Foundation specification on 2026-10-15.
// This publishes resource-server metadata. It does not register anything with a facilitator.
import { loadX402Config, X402_SERVICES } from './config.js';
import { usdcToAtomic } from './settlement.js';

export function bazaarExtension(serviceId) {
  const mystery = serviceId === 'mystery-voyage';
  const bodySchema = mystery ? {
    type: 'object', properties: { reveal_id: { type: 'string', minLength: 1 },
      user_nonce: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' } }, required: ['reveal_id', 'user_nonce'], additionalProperties: false
  } : { type: 'object', properties: { case: { type: 'object', description: 'Full TradeCase; omit to use the demo fixture. case_id alone does not select a case.' } }, additionalProperties: false };
  const info = { input: { type: 'http', method: 'POST', bodyType: 'json',
    body: mystery ? { reveal_id: '<id-from-mystery-preview>', user_nonce: `0x${'11'.repeat(32)}` } : {} },
    output: { type: 'json' } };
  return {
    info,
    schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
      properties: {
        input: { type: 'object', properties: { type: { type: 'string', const: 'http' }, method: { type: 'string', enum: ['POST'] },
          bodyType: { type: 'string', enum: ['json'] }, body: bodySchema }, required: ['type', 'method', 'bodyType', 'body'], additionalProperties: false },
        output: { type: 'object', properties: { type: { type: 'string', const: 'json' } }, required: ['type'], additionalProperties: false }
      }, required: ['input'], additionalProperties: false }
  };
}

// Both the Live gateway and catalog consume these exact amounts and requirements.
export function paidRouteMap(config, services = X402_SERVICES) {
  return Object.fromEntries(services.map((service) => [`POST ${service.endpoint}`, {
    id: service.serviceId, method: 'POST', path: service.endpoint, description: service.description, mimeType: 'application/json',
    amount: usdcToAtomic(service.priceUSDC, config.assetDecimals).toString(), network: config.network,
    asset: config.asset, payTo: config.payTo, maxTimeoutSeconds: config.ttlSeconds
  }]));
}

export function paymentRequirement(config, route) {
  return { scheme: 'exact', network: config.network, amount: route.amount, asset: config.asset,
    payTo: config.payTo, maxTimeoutSeconds: config.ttlSeconds,
    extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009', chainId: config.chainId,
      verifyingContract: config.asset, primaryType: 'TransferWithAuthorization' } };
}

export function discoveryCatalog({ origin, env = process.env, mode = 'demo', config, limit = 100, offset = 0, type = 'http' }) {
  const active = config ?? loadX402Config(env, { mode });
  const routes = paidRouteMap(active);
  const items = type === 'http' ? X402_SERVICES.map((service) => ({
    resource: `${origin}${service.endpoint}`, type: 'http', x402Version: 2,
    accepts: mode === 'live' ? [paymentRequirement(active, routes[`POST ${service.endpoint}`])] : [],
    extensions: {
      bazaar: bazaarExtension(service.serviceId),
      agentbl: { serviceId: service.serviceId, mode, priceUSDC: service.priceUSDC, registeredWithFacilitator: false,
        paymentProtocol: mode === 'live' ? 'x402-v2-eip3009' : 'agentbl-demo-personal-sign',
        description: service.serviceId === 'premium-risk' ? 'Risk analysis; external feeds are optional and otherwise fixtures.'
          : service.serviceId === 'premium-valuation' ? 'Deterministic valuation; no live market feed is promised.' : service.description }
    }
  })) : [];
  return { x402Version: 2, items: items.slice(offset, offset + limit), pagination: { limit, offset, total: items.length },
    scope: 'resource-server', mode, registeredWithFacilitator: false };
}
