import fs from 'node:fs/promises';
import path from 'node:path';
import { w4Root, sha256, w4SourceSnapshot } from './lib/w4-source.mjs';

const base = path.join(w4Root, 'docs/evidence/w4-local-2026-10-17');
const latest = JSON.parse(await fs.readFile(path.join(base, 'latest-run.json'), 'utf8'));
const run = path.join(base, latest.directory), commands = JSON.parse(await fs.readFile(path.join(run, 'receipts.json'), 'utf8'));
if (!latest.passed || !commands.passed || !commands.source_unchanged || commands.receipts.length !== 12 || commands.receipts.some((item) => item.exit_code !== 0)) throw new Error('Cannot freeze incomplete W4 validation');
const source = await w4SourceSnapshot();
if (source.source_sha256 !== commands.source_sha256) throw new Error('Source changed after validation; do not relabel old results');
const read = (name) => fs.readFile(path.join(run, `${name}.log`), 'utf8');
const summary = (text) => Object.fromEntries([...text.matchAll(/^\s*ℹ (tests|pass|fail|cancelled|skipped) (\d+)\s*$/gmu)].map((match) => [match[1], Number(match[2])]));
const application = summary(await read('application')), coverageLog = await read('coverage'), coverageRun = summary(coverageLog);
const integrations = Object.fromEntries(await Promise.all(['w2', 'w3', 'w4'].map(async (name) => [name, summary(await read(name))])));
for (const item of [application, coverageRun]) if (!item.tests || item.fail || item.cancelled || item.pass + item.skipped !== item.tests || item.skipped !== 2) throw new Error('Unexpected application skips or failures');
for (const item of Object.values(integrations)) if (!item.tests || item.fail || item.skipped || item.pass !== item.tests) throw new Error('Actual EVM integration did not fully run');
const percentages = coverageLog.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/u)?.slice(1).map(Number);
const contracts = Number((await read('contracts')).match(/(\d+) passing \(\d+ mocha\)/u)?.[1]);
const browser = Number((await read('browser')).match(/(\d+) passed \(/u)?.[1]);
const preflight = (await read('preflight')).match(/(\d+) PASS.*?(\d+) WARN.*?(\d+) SKIP.*?(\d+) FAIL/u);
if (!percentages || percentages[0] < 88 || percentages[1] < 72 || percentages[2] < 86 || !contracts || !browser || !preflight || Number(preflight[4])) throw new Error('Missing successful broad validation results');
const providerFiles = (await fs.readdir(path.join(base, 'provider-runs'))).filter((file) => /-live\.json$/u.test(file)).sort();
const provider = providerFiles.length ? JSON.parse(await fs.readFile(path.join(base, 'provider-runs', providerFiles.at(-1)), 'utf8')) : null;
if (!provider?.source_version || !provider.metrics.provider_attempts) throw new Error('A version-bound real provider attempt is required');
const validation = { schema: 'agentbl-w4-validation-v1', date: '2026-10-17', timezone: 'Asia/Singapore',
  generated_at: new Date().toISOString(), base_head: source.base_head, source_sha256: source.source_sha256,
  dirty_workspace: true, implemented_commit: null, command_receipts: `${latest.directory}/receipts.json`, runtime: commands.runtime,
  application, coverage_run: coverageRun, skipped_scope: 'Two W4 local-EVM tests are intentionally separated from ordinary npm test; both run under test:w4 with zero skips',
  actual_evm_http: integrations, contracts: { pass: contracts, fail: 0 }, browser: { pass: browser, fail: 0, executable: commands.browser_executable, viewports: [390, 1280, 1440] },
  coverage: { lines: percentages[0], branches: percentages[1], functions: percentages[2], thresholds: { lines: 88, branches: 72, functions: 86 } },
  preflight: Object.fromEntries(['pass', 'warn', 'skip', 'fail'].map((name, index) => [name, Number(preflight[index + 1])])),
  provider: { report: `provider-runs/${providerFiles.at(-1)}`, scope: provider.scope, metrics: provider.metrics, business_accepted: false, provider_identity_verified: false },
  external: { testnet_broadcast: false, live_anchor_enabled: false, real_funds: false, remote_ci: false, committed: false, pushed: false,
    independent_business_dataset: false, independent_cargo_valuation: false, enterprise_compliance_acceptance: false, off_host_restore: false } };
await fs.writeFile(path.join(base, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`);
await fs.writeFile(path.join(base, 'source-manifest.json'), `${JSON.stringify(source, null, 2)}\n`);

const issueFile = path.join(w4Root, 'docs/evidence/blockchain-comprehensive-2026-10-17/issue-register.json');
const register = JSON.parse(await fs.readFile(issueFile, 'utf8'));
const changes = {
  B11: { design: 'Versioned complete evidence packages, canonical salted commitments, encrypted authorized retrieval, independent-process verifier, v2 private anchor projection, source-bound runtime archive, coverage and canonical receipt invalidation', files: ['src/evidence/schema.js', 'src/evidence/archive.js', 'src/agent/runtime/anchoring.js', 'scripts/verify-evidence.mjs'], gates: ['First testnet code/policy/model registration and batch require separate transaction authorization.', 'Independent physical-host recovery is W5; local new-process verification is not off-host disaster recovery.'] },
  C01: { design: 'Versioned research calibration, basis/units/calendar/freshness/conflict guards, full input commitments and ACT/365 actual-period calculations; public monthly benchmark baseline is measured separately from cargo valuations', files: ['src/provenance/market.js', 'src/realdata/index.js', 'src/core/pricingEngine.js'], gates: ['Independent net-recovery/cargo valuation error remains unmeasured.', 'No business-approved calibration thresholds or payout SLA; source-unverified Live pricing remains paused.'] },
  C02: { design: 'Pinned official public DCSA specimens and labeled synthetic faults, blind real-endpoint evaluation, official OFAC primary-name source probe, invalid model-output rejection and immutable version-bound independent human review', files: ['src/provenance/evaluation.js', 'src/provenance/screening.js', 'src/rights/service.js', 'web/src/features/evidence/EvidencePanel.jsx'], gates: ['Configured model endpoint responded, but its document outputs were rejected; no model-quality acceptance.', 'Public specimens and source probes are not independent real-business/scan-quality or complete enterprise sanctions acceptance.'] },
  C03: { design: 'Independent direct ERC-3009 receipt/signature/domain/asset/amount/nonce verification, durable cross-process identity, no settle retry, bounded read-only unknown/reorg reconciliation, encrypted delivery and browser/CLI original-authorization recovery', files: ['src/x402/independentVerifier.js', 'src/x402/settlement.js', 'src/x402/clientRecovery.js', 'web/src/lib/payment-recovery.js'], gates: ['Actual payment tests use local test ERC-3009 tokens and a synthetic facilitator; no new real/testnet payment.', 'Production verifier supports direct token calls; an unreviewed wrapper is rejected. Independent RPC/finality and key custody must be operationally configured.'] }
};
for (const issue of register.issues.filter((item) => changes[item.id])) {
  const change = changes[issue.id]; issue.status_history ??= [];
  if (issue.status !== 'IMPLEMENTED') issue.status_history.push({ date: '2026-10-17', previous_status: issue.status, status: 'IMPLEMENTED', scope: 'W4 local implementation; external business acceptance remains open' });
  issue.status = 'IMPLEMENTED'; issue.implemented_commit = null; issue.verified_source_sha256 = source.source_sha256;
  issue.evidence_summary = 'S + actual local EVM/HTTP + encrypted/offline recovery + real endpoint/source observations; business quality not accepted';
  issue.verification_receipts = ['docs/evidence/w4-local-2026-10-17/validation.json', 'docs/evidence/w4-local-2026-10-17/source-manifest.json', 'docs/evidence/w4-local-2026-10-17/README.md'];
  issue.external_gates = change.gates;
  issue.closure_note = { design: change.design, files: change.files, tests: ['tests/w4Evidence.test.js', 'tests/w4Provenance.test.js', 'tests/w4Payments.test.js', 'tests/w4CrossLayer.test.js', 'tests/w4BrowserRecovery.test.js'],
    deployment_scope: 'Local source candidate; no testnet broadcast/deployment, commit, push or remote CI', remaining_boundary: 'IMPLEMENTED is not VERIFIED. Real source/model/compliance quality and independent operational recovery require their own evidence.' };
}
await fs.writeFile(issueFile, `${JSON.stringify(register, null, 2)}\n`);
const manifest = [];
async function collect(directory) {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name); if (entry.isDirectory()) await collect(file);
    else if (entry.name !== 'manifest.json') manifest.push({ path: path.relative(base, file).replaceAll('\\', '/'), sha256: sha256(await fs.readFile(file)) });
  }
}
await collect(base);
await fs.writeFile(path.join(base, 'manifest.json'), `${JSON.stringify({ schema: 'agentbl-w4-evidence-manifest-v1', source_sha256: source.source_sha256, files: manifest }, null, 2)}\n`);
console.log(JSON.stringify({ source_sha256: source.source_sha256, application: application.pass, contracts, browser, integrations, evidence_files: manifest.length }));
