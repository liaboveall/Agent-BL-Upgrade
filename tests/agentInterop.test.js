import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createInteropRoutes } from '../src/app/interopRoutes.js';
import { describeError, sendJson } from '../src/app/http.js';
import { createPricingDelegate, delegatePricingJsonSchema } from '../src/interop/delegation.js';
import { createAgentCard, agentCardSchema } from '../src/interop/agentCard.js';
import { httpOrigin, checkInteropInput } from '../src/interop/validation.js';
import { discoveryCatalog, paidRouteMap, bazaarExtension } from '../src/x402/discovery.js';
import { buildPaymentRequired, buildPaymentRequiredResponse } from '../src/x402/server.js';
import { loadX402Config, X402_SERVICES } from '../src/x402/config.js';
import { createPaidReportEnvelope } from '../src/x402/paidReport.js';
import { PaidReportCache } from '../src/x402/reportStore.js';
import { hashSnapshot } from '../src/agent/decisionLogger.js';
import { assertPricingQuote } from '../src/core/pricingSchema.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { callTool } from '../src/mcp/mcpServer.js';
import { callAgentBackend } from '../src/mcp/agentClient.js';
import { publicAgentPolicy } from '../src/mcp/agentTools.js';
import { CopilotService } from '../src/copilot/service.js';
import { readMcpResource } from '../src/mcp/resources.js';
import { phase5Runtime, riskDecision, copper } from './helpers/phase5.js';
import { listen, requestJson } from './helpers/http.js';

const at = Date.parse('2026-10-15T00:00:00Z');
const makeDelegate = (extra = {}) => createPricingDelegate({ loadCase: async (id) => id === copper.case_id ? structuredClone(copper) : null,
  env: {}, now: () => at, ...extra });
const event = { type: 'CARGO_DEPARTED', case_id: copper.case_id, event_id: 'phase6-operator', data: {} };
const rpc = (body = { case_id: copper.case_id }) => ({ jsonrpc: '2.0', id: 'request-1', method: 'SendMessage',
  params: { message: { messageId: 'external-message-1', role: 'ROLE_USER', parts: [{ data: body, mediaType: 'application/json' }] } } });
const headers = { 'A2A-Version': '1.0' };

async function routes(t, { env = {}, mode = 'demo', delegate = makeDelegate() } = {}) {
  const handle = createInteropRoutes({ context: { delegate }, env, runtimeMode: () => ({ mode }) });
  const app = await listen(http.createServer(async (req, res) => {
    try {
      if (!await handle(req, res, new URL(req.url, 'http://localhost'))) sendJson(res, 404, { code: 'not_found' });
    } catch (error) { const mapped = describeError(error); sendJson(res, mapped.status, { code: mapped.code }); }
  }));
  t.after(() => app.close()); return app;
}

test('delegated quotations match the canonical engine at every payout speed, without touching a runtime', async () => {
  const delegate = makeDelegate();
  for (const speed of ['FAST', 'BALANCED', 'LOW_COST']) {
    const input = { case_id: copper.case_id, payout_speed: speed, request_id: 'quote-42' };
    const before = JSON.stringify(input);
    const byId = await delegate(input);
    const inline = await delegate({ case_data: copper, payout_speed: speed });
    assert.equal(JSON.stringify(input), before);
    assertPricingQuote(byId.quote);
    assert.deepEqual(byId.quote, JSON.parse(JSON.stringify(quoteFromCase(copper, { payout_speed: speed }))));
    assert.deepEqual(byId.quote, inline.quote);
    assert.equal(byId.input_hash, hashSnapshot(copper));
    assert.equal(byId.result_hash, hashSnapshot({ quote: byId.quote, assessment: byId.assessment }));
    assert.deepEqual(byId.payment_evidence, []);
    assert.deepEqual(byId.authorization, { quotation_only: true, payment_executed: false, offering_created: false, chain_action_executed: false });
    assert.equal(byId.stateless, true); assert.equal(byId.indicative_only, true);
    assert.equal(byId.assessment.registry_verified, false);
    assert.equal(byId.request_id, 'quote-42');
  }
});

test('delegation preserves document mismatch and demo compliance blocks instead of granting execution', async () => {
  const mismatch = structuredClone(copper); mismatch.commercial_invoice.quantity_mt = 1;
  const result = await makeDelegate()({ case_data: mismatch });
  assert.equal(result.assessment.status, 'HOLD_FOR_REVIEW');
  assert.equal(result.assessment.verification.has_critical, true);
  assert.equal(result.chain_action_executed, false);
  const blocked = structuredClone(copper); blocked.bill_of_lading.shipper = 'Demo Screening Entity';
  // The real versioned local list supplies the blocked name; no claimed live sanctions provider.
  const { COMPLIANCE_DATA } = await import('../src/agent/compliance/data.js');
  blocked.bill_of_lading.shipper = COMPLIANCE_DATA.list.entities[0].name;
  const assessed = await makeDelegate()({ case_data: blocked });
  assert.equal(assessed.assessment.compliance.source, 'bundled-demo');
  assert.equal(assessed.assessment.compliance.status, 'BLOCK');
  assert.equal(assessed.assessment.status, 'REJECT');
  assert.equal(assessed.authorization.chain_action_executed, false);
});

test('delegation rejects ambiguous source selection, missing cases, unsupported fields and unsafe numbers', async () => {
  const delegate = makeDelegate();
  for (const input of [{}, { case_id: copper.case_id, case_data: copper }, { case_id: '../private' },
    { case_id: copper.case_id, approved: true }, { case_id: copper.case_id, purchase: true },
    { case_id: copper.case_id, paid_report_ids: ['untrusted'] }, { case_data: { ...copper, financing: { requested_cash_usd: -1 } } },
    { case_data: { ...copper, cargo: { quantity_mt: Infinity } } }]) await assert.rejects(delegate(input));
  await assert.rejects(delegate({ case_id: 'UNKNOWN-CASE' }), { code: 'case_not_found' });
  assert.equal(delegatePricingJsonSchema.oneOf.length, 2);
});

test('only unexpired, case-bound server-delivered reports become neutral quote provenance', async () => {
  const cache = new PaidReportCache({ filePath: null, now: () => at });
  const envelope = createPaidReportEnvelope({ kind: 'risk-intelligence', case_id: copper.case_id,
    payer: `0x${'11'.repeat(20)}`, payee: `0x${'22'.repeat(20)}`, asset: `0x${'33'.repeat(20)}`, network: 'eip155:1439',
    amount: '1000', payment_tx: `demo://receipt/${'44'.repeat(32)}`, data_snapshot: { risk_level: 'LOW' },
    model_provider: 'deterministic-test', evidence_hash: `0x${'55'.repeat(32)}` }, { now: new Date(at), ttlSeconds: 300 });
  await cache.save({ envelope, report: { payment: { live: false } } });
  const delegate = makeDelegate({ readReport: (id) => cache.read(id) });
  const free = await delegate({ case_id: copper.case_id });
  const paid = await delegate({ case_id: copper.case_id, paid_report_ids: [envelope.report_id, envelope.report_id] });
  for (const key of ['risk_score_bps', 'risk_level', 'risk_discount_bps', 'pricing_action', 'final_issue_price_usd', 'quote_hash']) {
    assert.deepEqual(paid.quote[key], free.quote[key], key);
  }
  assert.notEqual(paid.quote.evidence_hash, free.quote.evidence_hash);
  assert.equal(paid.payment_evidence.length, 1);
  assert.equal(paid.payment_evidence[0].mode, 'demo');
  assert.equal(paid.payment_evidence[0].onchain_reverified, false);
  assert.equal(paid.quote.paid_report_evidence[0].payment_tx, envelope.payment_tx);
  assertPricingQuote(paid.quote);
  const crossCase = structuredClone(copper); crossCase.case_id = 'CASE-OTHER';
  await assert.rejects(delegate({ case_data: crossCase, paid_report_ids: [envelope.report_id] }), /does not match/u);
  const tampered = structuredClone(envelope); tampered.data_snapshot.risk_level = 'CRITICAL';
  await cache.save({ envelope: tampered, report: { payment: { live: true } } });
  await assert.rejects(delegate({ case_id: copper.case_id, paid_report_ids: [envelope.report_id] }), /report_hash/u);
  await assert.rejects(delegate({ case_id: copper.case_id, paid_report_ids: [`rpt_${'99'.repeat(32)}`] }), { code: 'paid_report_not_cached' });
  const expired = makeDelegate({ now: () => at + 300_000, readReport: async () => ({ envelope }) });
  await assert.rejects(expired({ case_id: copper.case_id, paid_report_ids: [envelope.report_id] }), /expired/u);
});

test('pricing concurrency is bounded and recovers after a failed lookup', async () => {
  let release;
  const delegate = makeDelegate({ env: { AGENT_API_MAX_CONCURRENCY: '1' }, loadCase: () => new Promise((resolve) => { release = resolve; }) });
  const first = delegate({ case_id: copper.case_id });
  await assert.rejects(delegate({ case_id: copper.case_id }), { code: 'delegation_busy' });
  release(null); await assert.rejects(first, { code: 'case_not_found' });
  const next = delegate({ case_id: copper.case_id }); release(copper);
  assert.equal((await next).quote.case_id, copper.case_id);
});

test('MCP dry-run is side-effect free and invalid approval cannot change the queue', async (t) => {
  const { service, store } = await phase5Runtime(t);
  const context = { getService: () => service, env: { MCP_HUMAN_APPROVAL_TOKEN: 'operator-test-token' } };
  const before = { counts: structuredClone(service.bus.status().counts), decisions: service.logger.records.length, activities: store.agentActivities.length };
  const preview = await callTool('submit_agent_event', { event: { ...event, source: 'chain-watcher' } }, context);
  assert.equal(preview.result.dry_run, true); assert.equal(preview.result.submitted, false);
  assert.equal(preview.result.event.source, 'admin');
  for (const flags of [{}, { approved: true }, { approved: true, approval_token: 'wrong' }, { approved: false, approval_token: 'operator-test-token' }]) {
    await assert.rejects(callTool('submit_agent_event', { event, dry_run: false, ...flags }, context));
  }
  await assert.rejects(callTool('submit_agent_event', { event, dry_run: 'false' }, context), { code: 'invalid_interop_request' });
  assert.deepEqual({ counts: service.bus.status().counts, decisions: service.logger.records.length, activities: store.agentActivities.length }, before);
  const accepted = await callTool('submit_agent_event', { event, dry_run: false, approved: true, approval_token: 'operator-test-token' }, context);
  await service.waitFor(accepted.result.idempotency_key);
  assert.equal(accepted.result.submitted, true);
  const replay = await callTool('submit_agent_event', { event, dry_run: false, approved: true, approval_token: 'operator-test-token' }, context);
  assert.equal(replay.result.duplicate, true);
});

test('MCP operator events retain Live restrictions even with a valid host token', async () => {
  let submitted = false;
  const context = { env: { MCP_HUMAN_APPROVAL_TOKEN: 'operator-test-token' },
    getService: () => ({ getMode: () => 'live', now: () => new Date(at), submitEvent: () => { submitted = true; } }) };
  await assert.rejects(callTool('submit_agent_event', { event: { ...event, type: 'WORLD_RISK_UPDATED', data: { events: [] } },
    dry_run: false, approved: true, approval_token: 'operator-test-token' }, context), { code: 'event_not_allowed_in_live' });
  assert.equal(submitted, false);
});

test('MCP reads, policy and recent resources reflect real decisions without replaying or exposing private snapshots', async (t) => {
  const { service } = await phase5Runtime(t);
  const saved = await riskDecision(service);
  const context = { getService: () => service };
  const listed = (await callTool('list_agent_decisions', { case_id: copper.case_id, limit: 1 }, context)).result;
  assert.equal(listed.decisions.length, 1); assert.equal(listed.decisions[0].decision_id, saved.decision_id);
  const explained = (await callTool('explain_decision', { decision_id: saved.decision_id }, context)).result;
  assert.equal(explained.decision.policy.verdict, saved.policy.verdict);
  assert.equal(explained.recomputed, false);
  assert.equal(explained.decision.replay, undefined);
  await assert.rejects(callTool('explain_decision', { decision_id: 'missing' }, context), { code: 'decision_not_found' });
  const policy = await publicAgentPolicy(service);
  assert.deepEqual(policy.protected_chain_pools, [2]); assert.equal(policy.external_events.approval_required, true);
  assert.equal(policy.thresholds.max_price_move_bps, service.config.maxPriceMoveBps);
  assert.ok(!JSON.stringify(policy).includes('PRIVATE_KEY'));
  const resource = JSON.parse((await readMcpResource('agentbl://agent/decisions/recent', context)).contents[0].text);
  assert.equal(resource.decisions[0].decision_id, saved.decision_id);
  assert.equal(service.logger.records.length, 1);
  for (const invalid of [{ limit: 0 }, { limit: 201 }, { cursor: '../secret' }, { action: 'APPROVE' }]) {
    await assert.rejects(callTool('list_agent_decisions', invalid, context), { code: 'invalid_interop_request' });
  }
  await assert.rejects(callTool('constructor'), /Unknown tool/u);
});

test('stateless MCP recommendations preserve hard filters, never create sessions or execute actions', async (t) => {
  const { service, store } = await phase5Runtime(t);
  const copilot = new CopilotService({ getPools: async () => [...store.pools.values()], getDecisions: async () => [], env: {}, llmConfigured: () => false, now: () => at });
  const context = { getService: () => service, recommend: (input) => copilot.query(input) };
  const before = structuredClone([...store.pools]);
  const result = (await callTool('recommend_trade_assets', { message: 'copper', locale: 'en' }, context)).result;
  assert.equal(result.stateless, true); assert.equal(result.action_executed, false);
  assert.ok(result.recommendations.some((item) => item.pool_id === copper.case_id));
  assert.equal(result.context, undefined); assert.equal(copilot.sessions.size, 0);
  const excluded = (await callTool('recommend_trade_assets', { message: '低风险', locale: 'zh' }, context)).result;
  assert.equal(excluded.recommendations.length, 0);
  await callTool('recommend_trade_assets', { message: 'subscribe copper', locale: 'en' }, context);
  assert.deepEqual([...store.pools], before);
  assert.equal(copilot.sessions.size, 0);
  await assert.rejects(callTool('recommend_trade_assets', { message: 'copper', session_id: 'fake' }, context), { code: 'invalid_interop_request' });
});

test('Agent Card uses the verified A2A 1.0 required fields, advertises one implemented skill and no unsupported transports', async (t) => {
  const app = await routes(t);
  const primary = await requestJson(app.base, 'GET', '/.well-known/agent-card.json', undefined, { Host: 'attacker.invalid' });
  const legacy = await requestJson(app.base, 'GET', '/.well-known/agent.json');
  assert.equal(primary.status, 200); assert.deepEqual(primary.data, legacy.data);
  const card = agentCardSchema.parse(primary.data);
  for (const field of ['name', 'description', 'supportedInterfaces', 'version', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) assert.ok(Object.hasOwn(card, field));
  for (const old of ['url', 'protocolVersion', 'preferredTransport', 'additionalInterfaces']) assert.equal(card[old], undefined);
  assert.deepEqual(card.supportedInterfaces, [{ url: `http://localhost:${app.port}/api/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
  assert.equal(card.capabilities.streaming, false); assert.equal(card.capabilities.pushNotifications, false);
  assert.deepEqual(card.skills.map((skill) => skill.id), ['delegate_pricing']);
  assert.equal(card.capabilities.extensions[0].params.mcp.tools.length, 15);
  assert.equal(card.capabilities.extensions[0].params.paidServices.length, 4);
  assert.equal(primary.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${app.base}/.well-known/agent-card.json`, { method: 'HEAD' })).status, 200);
  assert.equal((await requestJson(app.base, 'POST', '/.well-known/agent.json', {})).status, 405);
  const schema = (await requestJson(app.base, 'GET', '/api/interop/schemas/delegate-pricing')).data;
  assert.equal(schema.oneOf.length, 2); assert.equal(schema.additionalProperties, false);
});

test('public origins reject credentials and cleartext remote URLs, and never trust Host or forwarded headers', async (t) => {
  for (const value of ['ftp://example.com', 'http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?key=secret', 'https://example.com/#fragment']) {
    assert.throws(() => httpOrigin(value, 'test'), { code: 'invalid_public_origin' });
  }
  const app = await routes(t, { env: { AGENTBL_PUBLIC_BASE_URL: 'https://pricing.example.com' } });
  const card = (await requestJson(app.base, 'GET', '/.well-known/agent-card.json', undefined, { 'x-forwarded-host': 'attacker.invalid' })).data;
  assert.equal(card.supportedInterfaces[0].url, 'https://pricing.example.com/api/a2a');
  const resources = (await requestJson(app.base, 'GET', '/discovery/resources')).data.items;
  assert.ok(resources.every((item) => item.resource.startsWith('https://pricing.example.com/')));
});

test('A2A SendMessage, HTTP delegation and MCP delegation return the same canonical quotation', async (t) => {
  const delegate = makeDelegate();
  const app = await routes(t, { delegate });
  const input = { case_data: copper, payout_speed: 'FAST', request_id: 'external-agent-request' };
  const a2a = await requestJson(app.base, 'POST', '/api/a2a', rpc(input), headers);
  assert.equal(a2a.status, 200); assert.equal(a2a.data.id, 'request-1');
  assert.equal(a2a.headers.get('a2a-version'), '1.0');
  const message = a2a.data.result.message;
  assert.equal(message.role, 'ROLE_AGENT'); assert.ok(message.messageId); assert.ok(message.contextId);
  assert.equal(message.parts[0].mediaType, 'application/json');
  assert.equal(message.taskId, undefined);
  const rest = (await requestJson(app.base, 'POST', '/api/agent/delegate-pricing', input)).data;
  const mcp = (await callTool('delegate_pricing', input, { delegate, getService() { throw new Error('quotation touched runtime'); } })).result;
  const { ok, ...restBody } = rest;
  assert.equal(ok, true); assert.deepEqual(message.parts[0].data, restBody); assert.deepEqual(mcp, restBody);
  assertPricingQuote(mcp.quote);
});

test('A2A validates JSON-RPC framing, protocol negotiation, media and structured inputs before pricing', async (t) => {
  let calls = 0;
  const app = await routes(t, { delegate: () => { calls++; throw new Error('unexpected execution'); } });
  const cases = [
    ['{', headers, -32700],
    [{ ...rpc(), jsonrpc: '1.0' }, headers, -32600],
    [{ ...rpc(), id: undefined }, headers, -32600],
    [[rpc()], headers, -32600],
    [rpc(), {}, -32009],
    [rpc(), { 'A2A-Version': '0.3' }, -32009],
    [{ ...rpc(), method: 'SendStreamingMessage' }, headers, -32601],
    [{ ...rpc(), params: { message: { messageId: 'a', role: 'ROLE_AGENT', parts: [{ data: {} }] } } }, headers, -32602],
    [{ ...rpc(), params: { message: { messageId: 'a', role: 'ROLE_USER', parts: [{ url: 'http://internal/secret' }] } } }, headers, -32602],
    [{ ...rpc(), params: { ...rpc().params, configuration: { acceptedOutputModes: ['audio/mp3'] } } }, headers, -32005]
  ];
  for (const [input, h, code] of cases) {
    const response = await requestJson(app.base, 'POST', '/api/a2a', input, h);
    assert.equal(response.data.error.code, code, response.text); assert.equal(response.data.result, undefined);
  }
  assert.equal(calls, 0);
  const tooLarge = await requestJson(app.base, 'POST', '/api/a2a', JSON.stringify({ data: 'x'.repeat(1_100_000) }), headers);
  assert.equal(tooLarge.status, 413);
  assert.equal((await requestJson(app.base, 'POST', '/api/a2a', '{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await requestJson(app.base, 'GET', '/api/a2a')).status, 405);
});

test('delegation input errors remain JSON-RPC errors without reflecting internal exception messages', async (t) => {
  const app = await routes(t);
  const invalid = await requestJson(app.base, 'POST', '/api/a2a', rpc({}), headers);
  assert.equal(invalid.data.error.code, -32602); assert.equal(invalid.data.error.data.code, 'invalid_interop_request');
  const broken = await routes(t, { delegate: () => { throw new Error('private path and credentials'); } });
  const internal = await requestJson(broken.base, 'POST', '/api/a2a', rpc(), headers);
  assert.equal(internal.data.error.code, -32603);
  assert.equal(internal.data.error.message, 'Internal server error');
  assert.ok(!internal.text.includes('credentials'));
});

test('discovery and card never publish Live payment accepts while the application is Demo', async (t) => {
  const app = await routes(t);
  const response = await requestJson(app.base, 'GET', '/discovery/resources?limit=2&offset=1');
  assert.equal(response.data.pagination.total, 4); assert.equal(response.data.items.length, 2);
  for (const item of response.data.items) {
    assert.deepEqual(item.accepts, []); assert.equal(item.extensions.agentbl.paymentProtocol, 'agentbl-demo-personal-sign');
    assert.equal(item.extensions.bazaar.info.input.method, 'POST');
  }
  assert.equal(response.data.registeredWithFacilitator, false);
  assert.deepEqual((await requestJson(app.base, 'GET', '/discovery/resources?type=mcp')).data.items, []);
  for (const query of ['?limit=0', '?offset=-1', '?limit=100000', '?type=other', '?secret=ignored']) {
    assert.equal((await requestJson(app.base, 'GET', `/api/x402/discovery${query}`)).status, 400);
  }
});

test('Live discovery, card and 402 header/body derive identical exact V2 requirements from the catalog', () => {
  const env = { X402_FACILITATOR_URL: 'https://facilitator.example.com', X402_PAY_TO: `0x${'22'.repeat(20)}` };
  const config = loadX402Config(env, { mode: 'live' });
  const catalog = discoveryCatalog({ origin: 'https://pricing.example.com', env, mode: 'live' });
  const map = paidRouteMap(config);
  for (const [index, item] of catalog.items.entries()) {
    const service = X402_SERVICES[index]; const route = map[`POST ${service.endpoint}`];
    const required = buildPaymentRequired(config, route, { url: item.resource, mimeType: 'application/json' });
    assert.deepEqual(item.accepts, required.accepts);
    assert.deepEqual(item.extensions.bazaar, required.extensions.bazaar);
    assert.equal(item.accepts[0].amount, String(Math.round(service.priceUSDC * 1_000_000)));
    assert.equal(item.accepts[0].payTo, config.payTo); assert.equal(item.accepts[0].network, config.network);
    assert.equal(item.accepts[0].asset, config.asset); assert.equal(item.accepts[0].scheme, 'exact');
    assert.equal(item.extensions.bazaar.info.input.bodyType, 'json');
    const schema = item.extensions.bazaar.schema;
    assert.deepEqual(schema.required, ['input']);
    assert.deepEqual(schema.properties.input.required, ['type', 'method', 'bodyType', 'body']);
  }
  const card = createAgentCard({ origin: 'https://pricing.example.com', env, mode: 'live' });
  assert.deepEqual(card.capabilities.extensions[0].params.paidServices, catalog.items);
  const declaration = bazaarExtension('mystery-voyage');
  assert.deepEqual(declaration.schema.properties.input.properties.body.required, ['reveal_id', 'user_nonce']);
  const demo = buildPaymentRequiredResponse('premium-risk', 0.001, config.network, config.payTo);
  assert.equal(demo.extensions.agentbl.mode, 'demo'); assert.equal(demo.extensions.bazaar.info.input.method, 'POST');
  assert.throws(() => discoveryCatalog({ origin: 'https://pricing.example.com', env: {}, mode: 'live' }), /required/u);
});

test('interoperability rate limits are applied before delegated work', async (t) => {
  const app = await routes(t, { env: { AGENT_API_RATE_LIMIT_PER_MIN: '1' } });
  assert.equal((await requestJson(app.base, 'POST', '/api/agent/delegate-pricing', { case_id: copper.case_id })).status, 200);
  const limited = await requestJson(app.base, 'POST', '/api/agent/delegate-pricing', { case_id: copper.case_id });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('untrusted JSON rejects reserved keys and complexity before schema traversal', () => {
  assert.throws(() => checkInteropInput(JSON.parse('{"__proto__":{"polluted":true}}')), { code: 'invalid_interop_request' });
  let deep = {}; for (let i = 0; i < 25; i++) deep = { next: deep };
  assert.throws(() => checkInteropInput(deep), { code: 'input_complexity_limit' });
  assert.throws(() => checkInteropInput({ list: Array(20_001).fill(1) }), { code: 'input_complexity_limit' });
  assert.throws(() => checkInteropInput({ data: 'x'.repeat(1_048_576) }), { code: 'body_too_large' });
  assert.equal({}.polluted, undefined);
});

test('stdio backend adapter rejects redirects, oversized or invalid replies and reports backend loss without local fallback', async () => {
  await assert.rejects(callAgentBackend('get_agent_status', {}, { env: { AGENTBL_MCP_API_URL: 'http://remote.invalid' } }), { code: 'invalid_public_origin' });
  await assert.rejects(callAgentBackend('get_agent_status', {}, { env: {}, fetchImpl: async () => { throw new Error('connection lost'); } }), { code: 'agent_backend_unavailable' });
  for (const body of ['not-json', 'x'.repeat(4_194_305)]) {
    await assert.rejects(callAgentBackend('get_agent_status', {}, { env: {}, fetchImpl: async () => new Response(body) }), { code: 'invalid_backend_response' });
  }
  let redirect;
  const result = await callAgentBackend('get_agent_status', {}, { env: {}, fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3000/api/mcp/call'); redirect = options.redirect;
    return Response.json({ ok: true, tool: 'get_agent_status', result: { mode: 'demo' } });
  } });
  assert.equal(redirect, 'error'); assert.equal(result.result.mode, 'demo');
  await assert.rejects(callAgentBackend('get_agent_status', {}, { env: {}, fetchImpl: async () => Response.json({ ok: false, code: 'denied', error: 'Denied' }, { status: 403 }) }), { code: 'denied' });
});

test('MCP runtime tools and resources hide unexpected storage or provider exception details', async () => {
  const secretError = new Error('private host path /runtime/operator and secret=host-only-value');
  const context = { getService: () => ({ status: async () => { throw secretError; } }) };
  await assert.rejects(callTool('get_agent_status', {}, context), (error) => {
    assert.equal(error.status, 500); assert.equal(error.code, 'internal_error');
    assert.match(error.message, /Internal server error/u);
    assert.ok(!error.message.includes('host-only-value')); assert.ok(!error.message.includes('/runtime/'));
    return true;
  });
  await assert.rejects(readMcpResource('agentbl://agent/policy', context), (error) => {
    assert.equal(error.code, -32603); assert.equal(error.message, 'Agent runtime resource is unavailable'); return true;
  });
});
