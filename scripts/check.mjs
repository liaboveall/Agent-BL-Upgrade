import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { loadApplicationConfig } from '../src/chain/loadApplicationConfig.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { assertPricingQuote } from '../src/core/pricingSchema.js';
import { assertTradeCase } from '../src/core/schema.js';
import { runHarnessScenarios } from '../src/core/scenarioRunner.js';
import { verifyVendor } from './vendor-frontend.mjs';
import { validateKnowledgeBase } from '../src/rag/knowledgeBase.js';
import { MCP_TOOLS_MANIFEST, MCP_TOOL_HANDLERS } from '../src/mcp/mcpServer.js';
import { releaseSourceSnapshot } from './lib/release-source.mjs';

const config = loadApplicationConfig();
assert.equal(config.protocolVersion, 5);
assert.equal(config.accessModel, 'compliance-gated');
const rights = JSON.parse(await fs.readFile('public/rights-instance.json', 'utf8'));
assert.equal(config.chainIdDecimal, rights.chain_id);
for (const [name, address] of Object.entries(rights.contracts)) assert.equal(config.contracts[name], address);
assert.equal(config.deployments.RWAOfferingPoolV5.blockNumber, rights.deployment_block);
assert.deepEqual(verifyVendor(), [], 'Vendored dependencies differ from their manifest');
assert.deepEqual(validateKnowledgeBase(), []);
for (const tool of MCP_TOOLS_MANIFEST) assert.ok(MCP_TOOL_HANDLERS[tool.name] && tool.description && tool.inputSchema);
assert.equal(MCP_TOOLS_MANIFEST.length, new Set(MCP_TOOLS_MANIFEST.map((t) => t.name)).size);
assert.ok(!MCP_TOOL_HANDLERS.push_pricing_to_oracle);
const files = ['data/demo-case.json', ...(await fs.readdir('data/cases')).filter((name) => name.endsWith('.case.json')).map((name) => 'data/cases/' + name)];
for (const file of files) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (file === 'data/demo-case.json') assertTradeCase(data);
  assertPricingQuote(quoteFromCase(data), data);
}
assert.ok((await runHarnessScenarios()).length >= 5);
const retired = JSON.parse(await fs.readFile('docs/evidence/legacy-retirement-2026-10-18/retired-files.json', 'utf8'));
for (const file of retired.files) assert.equal(await fs.access(file.path).then(() => true, () => false), false, 'Retired file reappeared: ' + file.path);
const snapshot = await releaseSourceSnapshot();
assert.ok(snapshot.file_count > 0);
console.log('check passed: controlled v5 configuration, current pricing, MCP tools, archive isolation and source inventory');
