// Documentation that quotes addresses and commands goes stale silently. These checks tie the README
// and the deployment guide to the files that are the source of truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8');
const readJson = (...segments) => JSON.parse(read(...segments));

const chainConfig = readJson('public', 'chain-config.json');
const testnet = chainConfig.networks['injective-testnet'];
const addresses = (text) => [...text.matchAll(/0x[0-9a-fA-F]{40}\b/gu)].map((match) => match[0].toLowerCase());

test('the README lists exactly the deployed contract addresses from chain-config.json', () => {
  const documented = new Set(addresses(read('README.md')));
  const configured = new Map(Object.entries(testnet.contracts).map(([name, address]) => [address.toLowerCase(), name]));

  for (const [address, name] of configured) {
    assert.ok(documented.has(address), `README.md does not list ${name} (${address})`);
  }
  for (const address of documented) {
    assert.ok(configured.has(address), `README.md lists ${address}, which is not in public/chain-config.json`);
  }
});

test('every `npm run <script>` in the README and deployment guide exists', () => {
  const scripts = new Set([
    ...Object.keys(readJson('package.json').scripts),
    ...Object.keys(readJson('hardhat', 'package.json').scripts)
  ]);
  for (const file of [['README.md'], ['docs', 'DEPLOYMENT.md']]) {
    const text = read(...file);
    for (const match of text.matchAll(/npm (?:--prefix \S+ )?run ([A-Za-z0-9:_-]+)/gu)) {
      assert.ok(scripts.has(match[1]), `${file.join('/')} mentions \`npm run ${match[1]}\`, but no package defines it`);
    }
  }
});

test('the README mentions the commands the release preflight expects', () => {
  const readme = read('README.md');
  for (const needle of ['smoke:x402', 'x402:intel', 'verify:wave-b', 'mcp:stdio']) {
    assert.ok(readme.includes(needle), `README.md should mention ${needle}`);
  }
});

test('.env.example documents every variable the server reads and never ships a real key', () => {
  const example = read('.env.example');
  const documented = new Set([...example.matchAll(/^#?\s*([A-Za-z][A-Za-z0-9_]*)=/gmu)].map((match) => match[1]));
  for (const name of [
    'PORT', 'HOST', 'TRUST_PROXY', 'DEMO_MODE', 'AGENTBL_ADMIN_TOKEN', 'AGENTBL_MAX_BODY_BYTES', 'AGENTBL_RUNTIME_DIR',
    'LLM_MODEL', 'LLM_PROXY_ENABLED', 'LLM_MAX_TOKENS_CAP', 'LLM_REASONING_EFFORT', 'X402_MODE', 'X402_FACILITATOR_URL', 'X402_PAY_TO', 'X402_PUBLIC_BASE_URL',
    'AGENT_API_RATE_LIMIT_PER_MIN', 'AGENT_API_MAX_CONCURRENCY', 'AGENTBL_MCP_API_URL', 'AGENTBL_PUBLIC_BASE_URL', 'MCP_HUMAN_APPROVAL_TOKEN',
    'PAYMENT_ATTESTOR_PRIVATE_KEY', 'PRICING_UPDATER_PRIVATE_KEY', 'SIGNER_KEYS_STRICT', 'DEPLOYER_PRIVATE_KEY',
    // Agent runtime (docs/agent-implementation-plan.md §4.7); every variable src/agent/runtime/config.js reads
    // and the rest of the runtime relies on today.
    'AGENT_ENABLED', 'AGENT_AUTONOMY', 'AGENT_ALLOW_UNATTENDED_IRREVERSIBLE', 'AGENT_PROTECTED_CHAIN_POOLS',
    'AGENT_MONITOR_INTERVAL_SEC', 'AGENT_MAX_PRICE_MOVE_BPS', 'AGENT_COOLDOWN_SEC', 'AGENT_MAX_ACTIONS_PER_POOL_PER_DAY',
    'AGENT_APPROVAL_TTL_SEC', 'AGENT_CHAIN_CONFIRMATIONS', 'AGENT_CHAIN_WATCHER_ENABLED', 'AGENT_CHAIN_POLL_SEC', 'AGENT_CHAIN_START_BLOCK',
    'AGENT_SETTLEMENT_RECIPIENT', 'AGENT_MAX_DECISIONS', 'AGENT_RETENTION_DAYS', 'AGENT_EXECUTOR_PRIVATE_KEY',
    'AGENT_ANCHOR_ENABLED', 'AGENT_ANCHOR_INTERVAL_SEC', 'AGENT_ANCHOR_MIN_BATCH',
    'AGENT_ANCHOR_DEPLOY_PLAN', 'AGENT_ANCHOR_DEPLOY_CONFIRM',
    'AGENT_RISK_CLEAR_TICKS', 'AGENT_INSURANCE_WARN_DAYS', 'AGENT_SCENARIO_SPEED', 'AGENT_UPLOAD_MAX_BYTES', 'AGENT_VALUATION_LLM', 'AGENT_VISION_ENABLED', 'AGENT_DOCUMENT_LLM',
    'COPILOT_SESSION_TTL_SEC', 'COPILOT_MAX_SESSIONS', 'COMPLIANCE_SCREENING_URL', 'COMPLIANCE_SCREENING_TIMEOUT_MS'
  ]) {
    assert.ok(documented.has(name), `.env.example should document ${name}`);
  }
  // Names that the code never reads were once documented (X402_PAY_TO_ADDRESS, X402_USDC_ADDRESS).
  for (const stale of ['X402_PAY_TO_ADDRESS', 'X402_USDC_ADDRESS']) {
    assert.ok(!documented.has(stale), `.env.example documents ${stale}, which nothing reads`);
  }
  // Every assignment that is not commented out must be blank (or a public URL), never a secret.
  for (const line of example.split(/\r?\n/u)) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    const [, name, value] = match;
    if (/(KEY|TOKEN|SECRET|PASSWORD)$/iu.test(name)) assert.equal(value.trim(), '', `${name} must be blank in .env.example`);
  }
});

test('every AGENT_* variable the runtime reads is documented in .env.example', () => {
  const example = read('.env.example');
  const documented = new Set([...example.matchAll(/^#?\s*([A-Za-z][A-Za-z0-9_]*)=/gmu)].map((match) => match[1]));
  const sources = [
    read('src', 'agent', 'runtime', 'config.js'),
    read('src', 'chain', 'signerKeys.js')
  ].join('\n');
  // `env.AGENT_X` reads in config.js, and the `env: 'AGENT_X_PRIVATE_KEY'` entries of signerKeys.js
  // (role names such as AGENT_EXECUTOR are not environment variables).
  const readByRuntime = new Set([...sources.matchAll(/(?:\benv\.|\benv: ')(AGENT_[A-Z0-9_]+)/gu)].map((match) => match[1]));
  assert.ok(readByRuntime.size >= 12, `expected the runtime to read at least 12 AGENT_* variables, found ${readByRuntime.size}`);
  for (const name of readByRuntime) {
    assert.ok(documented.has(name), `${name} is read by the runtime but not documented in .env.example`);
  }
});
