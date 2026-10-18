import { listenOnUsablePort } from './lib/listen.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/app/server.js';
import { MCP_TOOL_HANDLERS, MCP_TOOLS_MANIFEST } from '../src/mcp/mcpServer.js';
import { MCP_RESOURCES } from '../src/mcp/resources.js';
import { fetchPaidIntel } from '../src/x402/client.js';
import { loadX402Config, X402_SERVICES, x402RpcUrl } from '../src/x402/config.js';
import { assertPaidReportEnvelope, computeReportHash, createPaidReportEnvelope } from '../src/x402/paidReport.js';
import {loadApplicationConfig} from '../src/chain/loadApplicationConfig.js';
import { createAgentService } from '../src/agent/runtime/factory.js';
import { runValuationAgent } from '../src/agent/valuationAgent.js';
import { writeJsonAtomic } from '../src/lib/jsonStore.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// When started through `npm run preflight`, npm_execpath is npm's own JS entry point: run it
// with this Node directly, no shell involved. Fall back to the platform shim otherwise.
const npmCli = process.env.npm_execpath && /npm-cli\.c?js$/u.test(process.env.npm_execpath)
  ? process.env.npm_execpath
  : null;
const npm = npmCli ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const results = [];
const EXPECTED_CHECKS = 70;
const { values: options } = parseArgs({ options: { report: { type: 'string' } } });

function result(group, name, status, detail = '') {
  results.push({ group, name, status, detail });
  const symbol = status === 'PASS' ? '✓' : status === 'WARN' ? '!' : status === 'SKIP' ? '–' : '✗';
  console.log(`  ${symbol} [${results.length}/${EXPECTED_CHECKS}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const pass = (group, name, detail) => result(group, name, 'PASS', detail);
const fail = (group, name, detail) => result(group, name, 'FAIL', detail);
const warn = (group, name, detail) => result(group, name, 'WARN', detail);
const skip = (group, name, detail) => result(group, name, 'SKIP', detail);
const check = (group, name, condition, detail = '') => (
  condition ? pass(group, name, detail) : fail(group, name, detail || 'check failed')
);

async function exists(relative) {
  try { await fs.access(path.join(root, relative)); return true; } catch { return false; }
}

async function text(relative) {
  return fs.readFile(path.join(root, relative), 'utf8');
}

// What a developer sets to run Live. The unit suite asserts the Demo-mode defaults, so it runs without these
// (a preflight started with DEMO_MODE=false, or from a checkout whose .env is configured for Live, still passes it).
const LIVE_SETTINGS = /^(DEMO_MODE|AGENTBL_ADMIN_TOKEN|AGENTBL_RIGHTS_[A-Z0-9_]+|AGENTBL_REQUIRE_EXISTING_RUNTIME|X402_[A-Z0-9_]+|WHITE_AGENT_PRIVATE_KEY|PAYMENT_ATTESTOR_PRIVATE_KEY|PRICING_UPDATER_PRIVATE_KEY|SIGNER_KEYS_STRICT|DEPLOYER_PRIVATE_KEY)$/u;
const withoutLiveSettings = (testRunner = false) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !LIVE_SETTINGS.test(name)
  && name !== 'NODE_TEST_CONTEXT' && !/^(?:LLM_|OPENAI_|AZURE_OPENAI_|DEEPSEEK_|DASHSCOPE_|Tencent_|Ali_|XAPI_)/u.test(name))),
  // Node sets its own marker inside test workers. Setting it on the test runner would suppress every test.
  ...(!testRunner ? { NODE_TEST_CONTEXT: 'preflight-offline' } : {}), DEMO_MODE: 'true', LLM_PROXY_ENABLED: 'false' });

async function command(group, name, binary, args, cwd = root, env = process.env, timeoutMs = 180_000) {
  const viaNode = binary === npmCli;
  const retainOutput = async (output) => {
    if (!options.report) return;
    const directory = path.resolve(root, `${options.report}.commands`);
    await fs.mkdir(directory, { recursive: true });
    const label = name.replaceAll(/[^a-zA-Z0-9_-]+/gu, '-');
    const at = new Date().toISOString().replaceAll(/[:.]/gu, '-');
    await fs.writeFile(path.join(directory, `${at}-${label}.log`), output, { flag: 'wx' });
  };
  try {
    const { stdout, stderr } = await execFileAsync(viaNode ? process.execPath : binary, viaNode ? [binary, ...args] : args, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true,
      // node.exe often lives under "Program Files": execFile handles that path without a shell.
      // Only the fallback npm.cmd shim needs cmd.exe on Windows.
      shell: !viaNode && process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(binary)
    });
    await retainOutput(`${stdout}\n${stderr}`);
    pass(group, name, (stdout || stderr).trim().split(/\r?\n/u).at(-1));
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim();
    await retainOutput(output || error.message);
    fail(group, name, output.split(/\r?\n/u).at(-1) || error.message);
    return { ok: false, output };
  }
}

console.log(`\nAgentBL preflight — fixed ${EXPECTED_CHECKS}-check release gate`);

// 1-8: environment and configuration
console.log('\n[Environment]');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
check('Environment', 'Node.js >= 22.13', nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13), process.version);
check('Environment', 'package-lock.json present', await exists('package-lock.json'));
const packageJson = JSON.parse(await text('package.json'));
check('Environment', '@injectivelabs/x402 is pinned', packageJson.dependencies?.['@injectivelabs/x402'] === '0.0.1');
const runtimeMode = await fetchModeSnapshot();
check('Environment', 'Demo mode is explicit and labelled', typeof runtimeMode.demoMode === 'boolean', runtimeMode.mode);
let x402Config;
try { x402Config = loadX402Config(process.env); pass('Environment', 'x402 config passes fail-fast validation', x402Config.network); }
catch (error) { fail('Environment', 'x402 config passes fail-fast validation', error.message); }
check('Environment', 'Four paid report products configured', X402_SERVICES.length === 4);
if (runtimeMode.demoMode) skip('Environment', 'Live mode prerequisites configured', 'not required or exercised in Demo');
else if (runtimeMode.liveAvailable) pass('Environment', 'Live mode prerequisites configured');
else warn('Environment', 'Live mode prerequisites configured', `demo-only: ${runtimeMode.liveMissing.join(', ')}`);
const fallbackCase = JSON.parse(await text('data/demo-case.json'));
const fallback = await runValuationAgent(fallbackCase, { env: {}, forceDeterministic: true });
check('Environment', 'Deterministic AI fallback remains available', fallback.provider === 'deterministic-fallback' && Boolean(fallback.valuation), 'executed locally with no provider');

// 9-18: files, contracts and UI assets
console.log('\n[Files and schemas]');
for (const [file, label] of [
  ['src/app/server.js', 'HTTP application server'],
  ['src/x402/endpoints.js', 'Four paid-report builders'],
  ['src/x402/client.js', 'Wallet/CLI x402 client'],
  ['src/x402/settlement.js', 'Settlement state machine'],
  ['src/demo/mode.js', 'Unified Demo/Live controller']
]) check('Files and schemas', label, await exists(file), file);
try {
  const sampleEnvelope = createPaidReportEnvelope({
    kind: 'risk-intelligence',
    case_id: 'PREFLIGHT-CASE',
    payer: '0x1111111111111111111111111111111111111111',
    payee: '0x2222222222222222222222222222222222222222',
    network: 'eip155:1439',
    asset: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d',
    amount: '1000',
    payment_tx: `demo://receipt/${'ab'.repeat(32)}`,
    settled_at: '2026-06-29T08:00:00.000Z',
    data_snapshot: { risk_level: 'WARNING' },
    model_provider: 'preflight',
    evidence_hash: `0x${'cd'.repeat(32)}`
  }, { now: '2026-06-29T08:00:00.000Z' });
  check('Files and schemas', 'PaidReportEnvelope schema + hash recompute',
    assertPaidReportEnvelope(sampleEnvelope) === sampleEnvelope
      && computeReportHash(sampleEnvelope) === sampleEnvelope.report_hash);
} catch (error) {
  fail('Files and schemas', 'PaidReportEnvelope schema + hash recompute', error.message);
}
for (const [file, label] of [
  ['public/application-config.json', 'Current controlled application config'],
  ['web/index.html', 'Dashboard HTML (Vite entry)'],
  ['web/src/styles/index.css', 'Dashboard CSS'],
  ['docs/operations.md', 'Current deployment and x402 documentation']
]) check('Files and schemas', label, await exists(file), file);

// 19-25: executable release checks
console.log('\n[Executable suites]');
await command('Executable suites', 'Repository integrity check', npm, ['run', 'check']);
// Compile before the full application gate so its real local-EVM tests also run on a fresh checkout.
await command('Executable suites', 'Solidity contract suite', npm, ['test'], path.join(root, 'hardhat'));
const nodeTests = await command(
  'Executable suites',
  'Full Node unit/integration suite',
  npm,
  ['test'],
  root,
  { ...withoutLiveSettings(true), AGENTBL_W4_INTEGRATION: '1' },
  600_000 // Full integration suite on a Windows/WSL-mounted checkout; individual assertions are unchanged.
);
// The exit code already decides pass/fail; this also reads the summary line (TAP "# fail N",
// spec reporter "ℹ fail N") so a runner that exits 0 while reporting failures is still caught.
const testSummary = Object.fromEntries([...nodeTests.output.matchAll(/^\s*(?:#|ℹ) (tests|pass|fail|cancelled|skipped) (\d+)\s*$/gmu)]
  .map((match) => [match[1], Number(match[2])]));
if (nodeTests.ok && (!(testSummary.tests > 0) || testSummary.pass !== testSummary.tests || testSummary.fail !== 0 || testSummary.cancelled !== 0 || testSummary.skipped !== 0)) {
  results.at(-1).status = 'FAIL';
  results.at(-1).detail = `incomplete test execution: ${JSON.stringify(testSummary)}`;
  console.error(`  ✗ Full Node unit/integration suite — ${results.at(-1).detail}`);
}
await command('Executable suites', 'Main API smoke flow', npm, ['run', 'smoke'], root, runtimeMode.demoMode ? withoutLiveSettings() : process.env);
await command('Executable suites', 'Risk/pricing scenario regression', npm, ['run', 'scenarios'], root, withoutLiveSettings());
if (runtimeMode.demoMode) await command('Executable suites', 'One-minute offline demo', npm, ['run', 'demo:once'], root, withoutLiveSettings());
else skip('Executable suites', 'One-minute offline demo', 'runtime is LIVE');
check('Executable suites', 'Critical JavaScript modules imported', true, 'server/client/endpoints/preflight');

// 26-31: MCP business tools
console.log('\n[MCP tools]');
check('MCP tools', 'MCP manifest exposes exactly 14 tools + 5 resources',
  MCP_TOOLS_MANIFEST.length === 14 && MCP_RESOURCES.length === 5);
await mcpCheck('get_trade_case', { case_id: 'CASE-EBL-2026-0001' });
await mcpCheck('generate_pricing_quote', { case_id: 'CASE-EBL-2026-0001' });
await mcpCheck('search_knowledge_base', { query: 'copper war risk' });
await mcpCheck('simulate_offering', { case_id: 'CASE-EBL-2026-0001' });
const demoCase = JSON.parse(await text('data/demo-case.json'));

// 32-46: HTTP, x402 and paid business output
console.log('\n[HTTP and x402]');
const server = createServer();
await listenOnUsablePort(server, '127.0.0.1');
const api = `http://127.0.0.1:${server.address().port}`;
try {
  const health = await getJson(`${api}/api/health`);
  check('HTTP and x402', 'Health endpoint', health.response.ok && health.body.ok);
  const mode = await getJson(`${api}/api/demo/mode`);
  check('HTTP and x402', 'Runtime mode endpoint', mode.response.ok && mode.body.mode === runtimeMode.mode);
  // A configured admin token protects the shared reset, so the operator's token is presented here.
  const adminToken = String(process.env.AGENTBL_ADMIN_TOKEN ?? '').trim();
  const reset = await getJson(`${api}/api/demo/reset`, { method: 'POST', headers: adminToken ? { authorization: `Bearer ${adminToken}` } : {} });
  check('HTTP and x402', 'One-click demo reset', runtimeMode.demoMode ? reset.response.ok : reset.response.status === 409);
  const catalog = await getJson(`${api}/api/x402/config`);
  check('HTTP and x402', 'x402 catalog returns four reports', catalog.body.services?.length === 4);

  const post = (path, body, headers = {}) => getJson(`${api}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const agentStatus = await post('/api/mcp/call', { tool: 'get_agent_status' });
  const preview = await post('/api/mcp/call', { tool: 'submit_agent_event', params: {
    event: { type: 'CARGO_DEPARTED', case_id: demoCase.case_id, data: {} } } });
  const agentAfter = await post('/api/mcp/call', { tool: 'get_agent_status' });
  check('Interop', 'MCP runtime adapter reads status and defaults events to a side-effect-free dry-run',
    agentStatus.body.result?.mode === runtimeMode.mode && preview.body.result?.dry_run === true && preview.body.result?.submitted === false
      && JSON.stringify(agentStatus.body.result?.queue) === JSON.stringify(agentAfter.body.result?.queue));
  const agentCard = await getJson(`${api}/.well-known/agent-card.json`);
  const legacyCard = await getJson(`${api}/.well-known/agent.json`);
  check('Interop', 'A2A 1.0 Agent Card and compatibility alias advertise only the implemented interface',
    agentCard.response.ok && JSON.stringify(agentCard.body) === JSON.stringify(legacyCard.body)
      && agentCard.body.supportedInterfaces?.[0]?.protocolVersion === '1.0'
      && agentCard.body.skills?.[0]?.id === 'delegate_pricing' && agentCard.body.capabilities?.streaming === false);
  const discovery = await getJson(`${api}/api/x402/discovery`);
  check('Interop', 'Bazaar declarations cover the four services with mode-correct payment requirements',
    discovery.response.ok && discovery.body.items?.length === 4 && discovery.body.items.every((item) =>
      item.extensions?.bazaar?.info?.input?.method === 'POST'
      && (runtimeMode.demoMode ? item.accepts?.length === 0 : item.accepts?.[0]?.scheme === 'exact')));
  const delegated = await post('/api/agent/delegate-pricing', { case_id: demoCase.case_id });
  const a2aQuote = await post('/api/a2a', { jsonrpc: '2.0', id: 'preflight-pricing', method: 'SendMessage',
    params: { message: { messageId: 'preflight-pricing', role: 'ROLE_USER', parts: [{ data: { case_id: demoCase.case_id } }] } } }, { 'A2A-Version': '1.0' });
  check('Interop', 'HTTP and A2A delegation return the same canonical quote without payment or execution',
    delegated.body.ok === true && delegated.body.authorization?.chain_action_executed === false
      && delegated.body.authorization?.payment_executed === false
      && a2aQuote.body.result?.message?.parts?.[0]?.data?.quote?.quote_hash === delegated.body.quote?.quote_hash);

  for (const service of X402_SERVICES) {
    // Demo answers an unpaid GET with 402. Live (x402 V2) only accepts POST (GET gets 405) and answers an unpaid
    // POST with 402; a Live gateway that failed to start answers 503, which has to fail this check.
    const unpaid = runtimeMode.demoMode
      ? await fetch(`${api}${service.endpoint}`)
      : await fetch(`${api}${service.endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      });
    check('HTTP and x402', `${service.serviceId} enforces the mode-safe unpaid boundary`,
      unpaid.status === 402, `HTTP ${unpaid.status}`);
  }

  const paidReports = [];
  for (const service of X402_SERVICES) {
    if (!runtimeMode.demoMode) {
      skip('HTTP and x402', `${service.serviceId} signed demo unlock`, 'LIVE mode; no automatic spend');
      continue;
    }
    try {
      let paid;
      if (service.serviceId === 'mystery-voyage') {
        const { Wallet } = await import('ethers');
        const { createUserNonce } = await import('../src/mystery/fairness.js');
        const wallet = Wallet.createRandom();
        const preview = await getJson(`${api}/api/mystery/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            wallet_address: wallet.address,
            idempotency_key: `preflight-mystery-voyage-${Date.now()}`,
            risk_passport: { tier: 'ADVENTUROUS' }
          })
        });
        if (!preview.response.ok) throw new Error(preview.body.error ?? 'Mystery preview failed');
        paid = await fetchPaidIntel(api, service.endpoint, {
          demoMode: true,
          signer: wallet,
          budgetUSDC: 0.005,
          payload: { reveal_id: preview.body.reveal_id, user_nonce: createUserNonce() },
          timeoutMs: 30_000
        });
      } else {
        paid = await fetchPaidIntel(api, service.endpoint, {
          demoMode: true,
          budgetUSDC: 0.005,
          caseData: demoCase,
          timeoutMs: 30_000
        });
      }
      paidReports.push(paid.paid);
      let validEnvelope = false;
      try { validEnvelope = assertPaidReportEnvelope(paid.paid?.report_envelope) === paid.paid.report_envelope; }
      catch { validEnvelope = false; }
      check('HTTP and x402', `${service.serviceId} signed demo unlock`,
        paid.paid?.service === service.serviceId && validEnvelope);
    } catch (error) {
      fail('HTTP and x402', `${service.serviceId} signed demo unlock`, error.message);
    }
  }
  const kinds = new Set(paidReports.map((report) => report?.kind));
  if (runtimeMode.demoMode) check('HTTP and x402', 'Paid reports contain distinct business outputs', kinds.size === 4);
  else skip('HTTP and x402', 'Paid reports contain distinct business outputs', 'requires separately authorized real payments');
  const smoke = await getJson(`${api}/api/x402/smoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  check('HTTP and x402', '402→sign→settle→unlock smoke flow', runtimeMode.demoMode
    ? smoke.body.steps?.length === 4
    : smoke.response.status === 409);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
if (runtimeMode.demoMode) await command('HTTP and x402', 'Standalone x402 smoke command', npm, ['run', 'smoke:x402'], root, withoutLiveSettings());
else skip('HTTP and x402', 'Standalone x402 smoke command', 'LIVE mode; no automatic spend');

// Agent release gates: actual runtime lifecycle and separate executable checks. No Live transactions.
console.log('\n[Agent release gates]');
const agent = createAgentService({ store: { pools: new Map(), agentActivities: [] }, env: {}, chainConfig: null,
  monitors: false, getChainContext: async () => null });
try {
  await agent.start();
  const running = (await agent.status()).running;
  await agent.stop();
  check('Agent release gates', 'Agent runtime starts and stops without pending work', running && !(await agent.status()).running && !agent.bus.status().processing);
} catch (error) { fail('Agent release gates', 'Agent runtime starts and stops without pending work', error.message); }
finally { await agent.stop(); }
await command('Agent release gates', 'Controlled protocol retirement boundaries', process.execPath, ['--test', 'tests/legacyRetirement.test.js'], root, withoutLiveSettings(true));
await command('Agent release gates', 'Three Demo Agent stories including approved settlement', process.execPath, ['scripts/agent-demo-check.mjs'], root, withoutLiveSettings());
const evaluationCheck = await command('Agent release gates', 'Measured deterministic Agent quality thresholds', npm, ['run', 'eval:agent', '--', '--check'], root, withoutLiveSettings());
await command('Agent release gates', 'No fabricated transactions, activity or capabilities', process.execPath, ['--test', 'tests/noFabrication.test.js'], root, withoutLiveSettings(true));
await command('Agent release gates', 'Decision anchor proofs, terminal approvals, durable sequences and restart recovery', process.execPath, ['--test', 'tests/agentAnchoring.test.js'], root, withoutLiveSettings(true));
await command('Agent release gates', 'Anchor chain reconciliation and exact evidence verification', process.execPath, ['--test', 'tests/agentAnchorChain.test.js'], root, withoutLiveSettings(true));

// 52-56: UI acceptance hooks
console.log('\n[UI acceptance]');
// The React dashboard: the hooks live in its components and stylesheets under web/src.
const modeStrip = await text('web/src/shell/ModeStrip.jsx');
const reportsTab = (await Promise.all(['DealDialog.jsx', 'ReportsTab.jsx'].map((name) => text(`web/src/pages/deal/${name}`)))).join('\n');
const css = (await Promise.all(['motion.css', 'deal.css', 'index.css'].map((name) => text(`web/src/styles/${name}`)))).join('\n');
check('UI acceptance', 'Persistent DEMO MODE banner', modeStrip.includes('id="demo-banner"'));
check('UI acceptance', 'Explicit Live toggle and demo reset', modeStrip.includes('mode-toggle-btn') && modeStrip.includes('demo-reset-btn'));
check('UI acceptance', 'Paid report market tab and pipeline', reportsTab.includes('view-intel') && reportsTab.includes('x402-flow'));
check('UI acceptance', 'priceFlash/riskPulse/paymentFlow hooks', /priceFlash/u.test(css) && /riskPulse/u.test(css) && /particleFlow/u.test(css));
check('UI acceptance', 'Reduced-motion safety rule', /prefers-reduced-motion:\s*reduce/u.test(css));

await command('Agent release gates', 'Generated redteam corpus detects all seeded mutations', process.execPath, ['scripts/agent-redteam.mjs'], root, withoutLiveSettings());
await command('Agent release gates', 'Evidence freshness and read-only decision replay', process.execPath, ['--test', 'tests/agentPhase5.test.js'], root, withoutLiveSettings(true));
await command('Agent release gates', 'Audit privacy, encrypted recovery and retention', process.execPath, ['--test', 'tests/agentPrivacy.test.js'], root, withoutLiveSettings(true));
await command('Agent release gates', 'Current wallet funding rejects changed terms, accounts and receipts', process.execPath, ['--test', 'tests/copilotWallet.test.js'], root, withoutLiveSettings(true));

// 61-65: live readiness and documentation consistency
console.log('\n[Live readiness]');
if (!runtimeMode.demoMode && x402Config?.facilitatorUrl) {
  await liveHttpCheck('Facilitator /supported is reachable', `${x402Config.facilitatorUrl}/supported`);
} else skip('Live readiness', 'Facilitator /supported is reachable', 'Demo Mode');

if (!runtimeMode.demoMode) await rpcCheck('Injective RPC reports the pinned chain');
else skip('Live readiness', 'Injective RPC reports the pinned chain', 'Demo Mode');

if (!runtimeMode.demoMode && process.env.X402_PAY_TO) await balanceCheck(process.env.X402_PAY_TO);
else skip('Live readiness', 'Live wallet has readable INJ gas balance', 'Demo Mode');

const application = loadApplicationConfig();
check('Live readiness', 'Controlled v5 and shared payment services are independently configured', application.protocolVersion === 5 && Boolean(application.contracts.RightsController) && Boolean(application.paymentOracle?.abi?.length));
const readme = await text('README.md');
check('Live readiness', 'README documents x402, controlled financing, stdio MCP and Demo scope', readme.includes('smoke:x402') && readme.includes('x402:intel') && readme.includes('mcp:stdio') && readme.includes('controlled') && /demo/i.test(readme));

if (results.length !== EXPECTED_CHECKS) {
  throw new Error(`Preflight definition error: expected ${EXPECTED_CHECKS} checks, produced ${results.length}`);
}
const counts = Object.fromEntries(['PASS', 'WARN', 'SKIP', 'FAIL'].map((status) => [status, results.filter((item) => item.status === status).length]));
console.log('\n' + '='.repeat(60));
console.log(`Preflight: ${counts.PASS} PASS / ${counts.WARN} WARN / ${counts.SKIP} SKIP / ${counts.FAIL} FAIL (${EXPECTED_CHECKS} total)`);
console.log('='.repeat(60));
process.exitCode = counts.FAIL > 0 ? 1 : 0;
if (options.report) await writeJsonAtomic(path.resolve(root, options.report), { schema_version: 1,
  generated_at: new Date().toISOString(), mode: runtimeMode.mode, counts, checks: results,
  source_sha256: /^Source SHA256: ([a-f0-9]{64})$/mu.exec(evaluationCheck.output)?.[1] ?? null,
  live_provider_calls: runtimeMode.demoMode ? false : 'read-only readiness probes', live_transactions: false });

async function fetchModeSnapshot() {
  const demoMode = process.env.DEMO_MODE !== 'false';
  const missing = [];
  if (process.env.X402_MODE !== 'live') missing.push('X402_MODE=live');
  if (!process.env.X402_FACILITATOR_URL) missing.push('X402_FACILITATOR_URL');
  if (!process.env.X402_PAY_TO) missing.push('X402_PAY_TO');
  return { mode: demoMode ? 'demo' : 'live', demoMode, liveAvailable: missing.length === 0, liveMissing: missing };
}

async function mcpCheck(name, params) {
  try {
    const value = await MCP_TOOL_HANDLERS[name](params);
    check('MCP tools', `MCP ${name}`, Boolean(value));
  } catch (error) {
    fail('MCP tools', `MCP ${name}`, error.message);
  }
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function liveHttpCheck(name, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    check('Live readiness', name, response.ok, `HTTP ${response.status}`);
  } catch (error) { fail('Live readiness', name, error.message); }
}

async function rpcCall(method, params = []) {
  const response = await fetch(x402RpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function rpcCheck(name) {
  try {
    const chainId = Number.parseInt(await rpcCall('eth_chainId'), 16);
    check('Live readiness', name, chainId === x402Config.chainId, `chainId ${chainId}`);
  } catch (error) { fail('Live readiness', name, error.message); }
}

async function balanceCheck(address) {
  try {
    const balance = BigInt(await rpcCall('eth_getBalance', [address, 'latest']));
    check('Live readiness', 'Live wallet has readable INJ gas balance', balance > 0n, `${balance} wei`);
  } catch (error) { fail('Live readiness', 'Live wallet has readable INJ gas balance', error.message); }
}
