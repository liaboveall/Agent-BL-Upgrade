import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = path.join(import.meta.dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8');
const readJson = (...segments) => JSON.parse(read(...segments));
test('current documentation points to controlled configuration and an immutable historical archive',()=>{
 const text=read('README.md');assert.ok(text.includes('application-config.json'));assert.ok(text.includes('rights-instance.json'));assert.ok(text.includes('docs/archive/README.md'));assert.ok(!text.includes('verify:wave-b'));
});
test('documented current npm commands exist',()=>{
 const scripts=new Set([...Object.keys(readJson('package.json').scripts),...Object.keys(readJson('hardhat','package.json').scripts)]);
 for(const file of ['README.md','docs/deployment-current.md'])for(const match of read(file).matchAll(/npm (?:--prefix \S+ )?run ([A-Za-z0-9:_-]+)/gu))assert.ok(scripts.has(match[1]),match[1]);
});
test('.env.example documents every variable the server reads and never ships a real key', () => {
  const example = read('.env.example');
  const documented = new Set([...example.matchAll(/^#?\s*([A-Za-z][A-Za-z0-9_]*)=/gmu)].map((match) => match[1]));
  for (const name of [
    'PORT', 'HOST', 'TRUST_PROXY', 'DEMO_MODE', 'AGENTBL_ADMIN_TOKEN', 'AGENTBL_MAX_BODY_BYTES', 'AGENTBL_RUNTIME_DIR',
    'LLM_MODEL', 'LLM_PROXY_ENABLED', 'LLM_MAX_TOKENS_CAP', 'LLM_REASONING_EFFORT', 'X402_MODE', 'X402_FACILITATOR_URL', 'X402_PAY_TO', 'X402_PUBLIC_BASE_URL', 'X402_CONFIRMATIONS',
    'AGENT_API_RATE_LIMIT_PER_MIN', 'AGENT_API_MAX_CONCURRENCY', 'AGENTBL_MCP_API_URL', 'AGENTBL_PUBLIC_BASE_URL', 'MCP_HUMAN_APPROVAL_TOKEN',
    'PAYMENT_ATTESTOR_PRIVATE_KEY', 'AGENT_ANCHOR_PRIVATE_KEY', 'SIGNER_KEYS_STRICT', 'DEPLOYER_PRIVATE_KEY',
    // Agent runtime (docs/agent-implementation-plan.md §4.7); every variable src/agent/runtime/config.js reads
    // and the rest of the runtime relies on today.
    'AGENT_ENABLED', 'AGENT_AUTONOMY', 'AGENT_ALLOW_UNATTENDED_IRREVERSIBLE',
    'AGENT_MONITOR_INTERVAL_SEC', 'AGENT_MAX_PRICE_MOVE_BPS', 'AGENT_COOLDOWN_SEC', 'AGENT_MAX_ACTIONS_PER_POOL_PER_DAY',
    'AGENT_APPROVAL_TTL_SEC', 'AGENT_CHAIN_CONFIRMATIONS',
    'AGENTBL_BROWSER_PORT', 'AGENTBL_CHROMIUM_PATH', 'AGENT_MAX_DECISIONS', 'AGENT_RETENTION_DAYS',
    'AGENT_ANCHOR_ENABLED', 'AGENT_ANCHOR_INTERVAL_SEC', 'AGENT_ANCHOR_MIN_BATCH',
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
