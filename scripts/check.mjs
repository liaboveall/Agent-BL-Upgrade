import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadApplicationConfig } from '../src/chain/loadApplicationConfig.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { assertPricingQuote } from '../src/core/pricingSchema.js';
import { assertTradeCase } from '../src/core/schema.js';
import { runHarnessScenarios } from '../src/core/scenarioRunner.js';
import { verifyVendor } from './vendor-frontend.mjs';
import { validateKnowledgeBase } from '../src/rag/knowledgeBase.js';
import { MCP_TOOLS_MANIFEST, MCP_TOOL_HANDLERS } from '../src/mcp/mcpServer.js';
import { releaseSourceSnapshot, releaseSourceByteIssues } from './lib/release-source.mjs';
import { FROZEN_ARTIFACTS } from '../src/rights/chain.js';
import { verifyDisclosure } from '../src/rights/disclosure.js';

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
// The image must carry every frozen inventory the server verifies superseded instances against.
const dockerfile = await fs.readFile('Dockerfile', 'utf8');
for (const file of Object.values(FROZEN_ARTIFACTS)) {
  assert.ok(dockerfile.includes(`scripts/config/${file}`), `Dockerfile does not copy scripts/config/${file}`);
  await fs.access(`scripts/config/${file}`);
}
// The image builds the dashboard from a partial tree: every server module it bundles, directly or through another
// one, must be copied into the Dockerfile's web stage, or only the Docker build finds out.
const webStage = dockerfile.split(/^FROM /mu).find((stage) => /\bAS web\b/u.test(stage.split('\n')[0])) ?? '';
const copied = [...webStage.matchAll(/^COPY (src\/\S+) /gmu)].map((match) => match[1].replace(/\/$/u, ''));
const relativeImports = async (file) => [...(await fs.readFile(file, 'utf8')).matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gu)]
  .map((match) => path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
const bundled = new Set(), pendingModules = [];
for (const entry of await fs.readdir('web/src', { recursive: true })) {
  if (/\.jsx?$/u.test(entry)) pendingModules.push(...(await relativeImports(path.posix.join('web/src', entry.replaceAll('\\', '/')))).filter((target) => target.startsWith('src/')));
}
while (pendingModules.length) {
  const file = pendingModules.pop();
  if (bundled.has(file)) continue;
  bundled.add(file);
  pendingModules.push(...(await relativeImports(file)).filter((target) => target.startsWith('src/')));
}
assert.ok(bundled.size > 0, 'No server module found in the dashboard imports; the scan is broken');
for (const file of bundled) assert.ok(copied.some((source) => file === source || file.startsWith(`${source}/`)), `Dockerfile web stage does not copy ${file}, which the dashboard bundles`);
// Shipped public terms are served when no vault is present, so each one must recompute to its file name.
for (const name of (await fs.readdir('data/disclosures')).filter((entry) => entry.endsWith('.json'))) {
  const pack = JSON.parse(await fs.readFile(`data/disclosures/${name}`, 'utf8'));
  assert.ok(verifyDisclosure(pack) && `${pack.disclosure_hash.toLowerCase()}.json` === name, `Shipped disclosure ${name} does not verify`);
}
const retired = JSON.parse(await fs.readFile('scripts/config/retired-runtime-paths.json', 'utf8'));
for (const file of retired.paths) assert.equal(await fs.access(file).then(() => true, () => false), false, 'Retired file reappeared: ' + file);
const snapshot = await releaseSourceSnapshot();
assert.ok(snapshot.file_count > 0);
assert.deepEqual(await releaseSourceByteIssues(snapshot), [], 'Source bytes differ from the LF checkout required by .gitattributes; normalize the listed files before recording release evidence');
console.log('check passed: controlled v5 configuration, current pricing, MCP tools, container inventories, shipped terms, retired entry isolation and source inventory');
