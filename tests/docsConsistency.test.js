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
    'LLM_PROXY_ENABLED', 'LLM_MAX_TOKENS_CAP', 'LLM_REASONING_EFFORT', 'X402_MODE', 'X402_FACILITATOR_URL', 'X402_PAY_TO', 'X402_PUBLIC_BASE_URL',
    'PAYMENT_ATTESTOR_PRIVATE_KEY', 'PRICING_UPDATER_PRIVATE_KEY', 'SIGNER_KEYS_STRICT', 'DEPLOYER_PRIVATE_KEY'
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
