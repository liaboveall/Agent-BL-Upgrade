import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { calculateRisk } from '../src/core/riskEngine.js';
import { runHarnessScenarios } from '../src/core/scenarioRunner.js';
import { assertRiskReport, assertTradeCase } from '../src/core/schema.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { assertPricingQuote, PAYOUT_SPEEDS } from '../src/core/pricingSchema.js';
import chainConfigLib from './lib/chain-config.cjs';
import { verifyVendor } from './vendor-frontend.mjs';

const requiredFiles = [
  'README.md',
  'docs/background.md',
  'docs/PRD.md',
  'docs/acceptance.md',
  'docs/award-roadmap.md',
  'docs/tasks.md',
  'docs/wave-b.md',
  'docs/evidence/wave-b-gate.json',
  'docs/evidence/wave-b-protocol.json',
  'docs/evidence/injective-mcp-smoke.json',
  'public/chain-config.json',
  'data/demo-case.json',
  'data/scenarios/low-risk-approved.json',
  'data/scenarios/warning-margin-call.json',
  'data/scenarios/critical-liquidation.json',
  'data/scenarios/freeze-pool.json',
  'data/scenarios/continue-with-warning.json',
  'src/app/server.js',
  'src/core/riskEngine.js',
  'src/core/scenarioRunner.js',
  'src/core/schema.js',
  'src/core/workflow.js',
  'src/rag/knowledgeBase.js',
  'src/rag/search.js',
  'src/rag/judgeQA.js',
  'src/mcp/mcpServer.js',
  'src/mcp/standalone-server.js',
  'src/mcp/resources.js',
  'src/mcp/security.js',
  'src/mcp/injectiveAdapter.js',
  'src/mcp/tools.js',
  'src/skill/pricingAnalyst.js',
  'src/skill/demoOperator.js',
  'scripts/lib/chain-config.cjs',
  'scripts/migrate-chain-config.mjs',
  'scripts/eval-agent.mjs',
  'scripts/agent-demo-check.mjs',
  'src/agent/evaluation/runner.js',
  'src/agent/evaluation/goldDataset.js',
  'tests/agentEvaluation.test.js',
  'tests/agentReliability.test.js',
  'tests/riskEngine.test.js',
  'tests/scenarioRunner.test.js',
  'tests/chainConfig.test.js',
  'tests/web3Wallets.test.js',
  'tests/smoke.test.js'
];

for (const file of requiredFiles) {
  await fs.access(file);
}

const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
for (const script of [
  'postinstall', 'dev', 'test', 'check', 'demo', 'smoke', 'scenarios', 'mcp',
  'mcp:stdio', 'deploy:protocol', 'verify:wave-b', 'smoke:mcp:injective',
  'migrate:chain-config', 'eval:agent'
]) {
  assert.ok(pkg.scripts[script], `Missing package script: ${script}`);
}

const chainRegistry = JSON.parse(await fs.readFile('public/chain-config.json', 'utf8'));
chainConfigLib.assertRegistry(chainRegistry);
assert.equal(chainRegistry.schema, 'agentbl-chain-config-v2');
assert.equal(chainRegistry.defaultNetwork, 'injective-testnet');
assert.ok(chainRegistry.networks['injective-testnet']);
assert.ok(chainRegistry.networks['injective-mainnet']);
assert.equal(chainRegistry.networks['injective-testnet'].accessModel, 'permissionless');
assert.equal(chainRegistry.networks['injective-mainnet'].accessModel, 'compliance-gated');

// Self-hosted browser modules must match their manifest (no silent edits to vendored code).
assert.deepEqual(verifyVendor(), [], 'public/vendor is out of sync with public/vendor/manifest.json');

const data = JSON.parse(await fs.readFile('data/demo-case.json', 'utf8'));
assertTradeCase(data);
const report = calculateRisk(data);
assertRiskReport(report, data);

// BE-1: the demo case also carries the new AI-pricing-model fields, so the same
// seed drives the legacy RiskReport engine AND the new PricingQuote engine (the
// default case behind POST /api/pricing/quote and /api/offering/simulate).
const financing = data.financing ?? {};
assert.ok(Number.isFinite(financing.requested_cash_usd), 'demo-case financing.requested_cash_usd must be a number');
assert.ok(PAYOUT_SPEEDS.includes(financing.payout_speed), `demo-case financing.payout_speed must be one of: ${PAYOUT_SPEEDS.join(', ')}`);
assert.equal(financing.target_redemption_value_usd, 1, 'demo-case financing.target_redemption_value_usd must be 1');
const demoQuote = quoteFromCase(data);
assertPricingQuote(demoQuote, data);

// Every curated case must price cleanly: an invalid financing.payout_speed in one
// fixture (a legacy "SAFE") used to 500 the world-risk endpoint for that case only.
for (const name of (await fs.readdir('data/cases')).filter((file) => file.endsWith('.case.json')).sort()) {
  const fixture = JSON.parse(await fs.readFile(`data/cases/${name}`, 'utf8'));
  const speed = fixture.financing?.payout_speed;
  assert.ok(speed === undefined || PAYOUT_SPEEDS.includes(speed),
    `data/cases/${name}: financing.payout_speed "${speed}" must be one of: ${PAYOUT_SPEEDS.join(', ')}`);
  assertPricingQuote(quoteFromCase(fixture), fixture);
}

const scenarioResults = await runHarnessScenarios();
assert.ok(scenarioResults.length >= 5, 'Expected demo case plus at least five scenario fixtures');
assert.ok(scenarioResults.some((scenario) => scenario.contract_action === 'APPROVE_FINANCING'));
assert.ok(scenarioResults.some((scenario) => scenario.contract_action === 'TRIGGER_MARGIN_CALL'));
assert.ok(scenarioResults.some((scenario) => scenario.contract_action === 'TRIGGER_LIQUIDATION'));
assert.ok(scenarioResults.some((scenario) => scenario.contract_action === 'FREEZE_POOL'));
assert.ok(scenarioResults.some((scenario) => scenario.contract_action === 'CONTINUE_WITH_WARNING'));

// Validate RAG knowledge base
const { validateKnowledgeBase } = await import('../src/rag/knowledgeBase.js');
const kbErrors = validateKnowledgeBase();
assert.equal(kbErrors.length, 0, `Knowledge base validation errors: ${kbErrors.join('; ')}`);

// Validate MCP manifest
const { MCP_TOOLS_MANIFEST, MCP_TOOL_HANDLERS } = await import('../src/mcp/mcpServer.js');
const { MCP_RESOURCES } = await import('../src/mcp/resources.js');
assert.equal(MCP_TOOLS_MANIFEST.length, 9, 'MCP manifest must have exactly 9 tools');
assert.deepEqual(MCP_RESOURCES.map((resource) => resource.uri).sort(), [
  'agentbl://cases/catalog',
  'agentbl://contracts/deployments',
  'agentbl://risk/methodology'
]);
for (const tool of MCP_TOOLS_MANIFEST) {
  assert.ok(MCP_TOOL_HANDLERS[tool.name], `Missing handler for MCP tool: ${tool.name}`);
  assert.ok(tool.name, 'Tool must have a name');
  assert.ok(tool.description, `Tool ${tool.name} must have a description`);
  assert.ok(tool.inputSchema, `Tool ${tool.name} must have an inputSchema`);
}

console.log('check passed: files, scripts, seed data, chain registry, schemas, knowledge base, MCP manifest and scenario harness are valid.');
