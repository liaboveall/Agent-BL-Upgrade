import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from '../src/app/server.js';
import { resolveApplicationConfig } from '../src/chain/applicationConfig.js';
import { loadApplicationConfig } from '../src/chain/loadApplicationConfig.js';
import { createAgentService } from '../src/agent/runtime/factory.js';
import { loadAgentConfig } from '../src/agent/runtime/config.js';
import { MCP_TOOL_HANDLERS, callTool } from '../src/mcp/mcpServer.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { cargoIdentityHashV2 } from '../src/chain/cargoIdentity.js';
import { runDemoOperator } from '../src/skill/demoOperator.js';
import { listen } from './helpers/http.js';

test('retirement: old public configuration and Oracle API cannot be used', async (t) => {
  const app = await listen(createServer());
  t.after(() => app.close());
  const base = app.base;
  assert.equal((await fetch(`${base}/chain-config.json`)).status, 404);
  assert.equal((await fetch(`${base}/application-config.json`)).status, 200);
  const removed = await fetch(`${base}/api/oracle/pricing-update`, { method: 'POST', body: '{}' });
  assert.equal(removed.status, 410);
  assert.equal((await removed.json()).code, 'oracle_route_retired');
  assert.equal(MCP_TOOL_HANDLERS.push_pricing_to_oracle, undefined);
  await assert.rejects(callTool('push_pricing_to_oracle', { approved: true }), /Unknown tool/);
});

test('retirement: public config accepts controlled testnet only and binds the current title instance', async () => {
  const raw = JSON.parse(await fs.readFile('public/application-config.json', 'utf8'));
  const config = loadApplicationConfig();
  const rights = JSON.parse(await fs.readFile('public/rights-instance.json', 'utf8'));
  assert.equal(config.contracts.RWAOfferingPool, rights.contracts.RWAOfferingPoolV5);
  assert.equal(config.contracts.RWAToken, rights.contracts.ControlledRWAToken);
  assert.equal(config.protocolVersion, 5);
  assert.equal(config.accessModel, 'compliance-gated');
  assert.equal(config.contracts.RiskPricingOracle, undefined);
  assert.equal(config.contracts.AgentBLRWA, undefined);
  const changed = structuredClone(raw);
  changed.networks['injective-testnet'].chainIdDecimal = 1776;
  assert.throws(() => resolveApplicationConfig(changed), /controlled Injective testnet/);
  assert.throws(() => resolveApplicationConfig({ schema: 'agentbl-chain-config-v2' }), /current research/);
});

test('retirement: Live analysis does not read historical financing keys or execute an injected chain adapter', async (t) => {
  const data = JSON.parse(await fs.readFile('data/cases/copper-sg-shanghai.case.json', 'utf8'));
  const quote = quoteFromCase(data);
  const env = new Proxy({}, { get(target, name) {
    if (['DEPLOYER_PRIVATE_KEY', 'PRICING_UPDATER_PRIVATE_KEY', 'AGENT_EXECUTOR_PRIVATE_KEY'].includes(name)) throw new Error('Retired signing key was read');
    return target[name];
  } });
  const store = { pools: new Map([[data.case_id, { poolId: data.case_id, caseData: data, quote, status: 'Open', subscribedUsd: 0 }]]), agentActivities: [] };
  let calls = 0;
  const service = createAgentService({ env, store, getMode: () => 'live', monitors: false, config: loadAgentConfig({}),
    getChainContext: async () => { calls++; throw new Error('Retired chain context'); } });
  t.after(() => service.stop());
  await service.init();
  const result = await service.submitEvent({ type: 'WORLD_RISK_UPDATED', case_id: data.case_id, source: 'admin',
    data: { events: [{ type: 'severe_weather', severity: 'critical', region: 'East China Sea', description: 'Research storm' }] } });
  await service.waitFor(result.idempotency_key);
  assert.equal(calls, 0);
  assert.equal((await service.status()).executor, 'analysis');
  assert.deepEqual(service.registry.list(), []);
  for (const decision of (await service.listDecisions()).decisions) {
    assert.notEqual(decision.status, 'EXECUTING');
    assert.notEqual(decision.status, 'AWAITING_OWNER_SIGNATURE');
    assert.equal(decision.execution?.tx_hash, undefined);
  }
  await assert.rejects(service.attachTx('old', { tx_hash: '0x' + 'a'.repeat(64) }), { code: 'signing_route_retired' });
});

test('retirement: stable title identity still prevents case-id aliases', () => {
  const record = { case_id: 'case-a', bill_of_lading: { issuer_id: 'Carrier-A', original_bl_id: 'BL 123' } };
  assert.equal(cargoIdentityHashV2(record), cargoIdentityHashV2({ ...record, case_id: 'case-b' }));
});

test('retirement: the complete Demo helper finishes without invoking removed tools', async () => {
  const result = await runDemoOperator({ case_id: 'CASE-EBL-2026-0001' });
  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'demo');
  assert.equal(result.steps.length, 4);
  assert.ok(result.steps.every((step) => step.status === 'ok' && typeof MCP_TOOL_HANDLERS[step.tool] === 'function'));
  assert.equal(result.demo.summary.oracle_tx_hash, undefined);
  assert.equal(result.demo.summary.oracle_tx_status, undefined);
});
