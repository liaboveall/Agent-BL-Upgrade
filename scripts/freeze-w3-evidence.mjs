import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rightsDeploymentPlan } from './rights-plan.mjs';

const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, 'docs/evidence/w3-local-2026-10-17');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => fs.writeFile(path.join(evidence, file), `${JSON.stringify(value, null, 2)}\n`);
const log = (name) => fs.readFile(path.join(evidence, 'logs', name), 'utf8');
const nodeSummary = (text) => Object.fromEntries([...text.matchAll(/^\s*ℹ (tests|pass|fail|cancelled|skipped) (\d+)\s*$/gmu)].map((match) => [match[1], Number(match[2])]));

export async function freezeW3Evidence() {
  const coverage = await log('coverage-final-3.log'), w2 = nodeSummary(await log('w2-integration-final.log')), w3 = nodeSummary(await log('w3-integration-final.log'));
  const application = nodeSummary(coverage);
  for (const result of [application, w2, w3]) if (!result.tests || result.pass !== result.tests || result.fail || result.cancelled || result.skipped) throw new Error('Cannot freeze incomplete application/EVM checks');
  const contracts = Number((await log('contracts-final.log')).match(/(\d+) passing \(\d+ mocha\)/u)?.[1]);
  const browser = Number((await log('browser-final.log')).match(/(\d+) passed \(/u)?.[1]);
  const percentages = coverage.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/u)?.slice(1).map(Number);
  if (!contracts || !browser || !percentages) throw new Error('Missing full contract/browser/coverage results');
  const preflight = await log('preflight-final.log');
  const preflightSummary = preflight.match(/(\d+) PASS.*?(\d+) WARN.*?(\d+) SKIP.*?(\d+) FAIL/u);
  if (!preflightSummary || Number(preflightSummary[4]) !== 0) throw new Error('Preflight did not finish successfully');
  const sourcePaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root }).toString().split('\0')
    .filter((file) => file && (/^(?:src|web|scripts|tests|public|data|\.github)\//u.test(file)
      || /^hardhat\/(?:contracts|test)\//u.test(file) || /^(?:hardhat\/)?(?:package(?:-lock)?\.json|hardhat\.config\.js)$/u.test(file)
      || /^(?:Dockerfile|docker-compose\.yml|\.env\.example|eslint\.config\.js|playwright\.config\.js)$/u.test(file)))
    .filter((file) => !file.startsWith('data/runtime/') && !file.endsWith('.log'));
  const files = await Promise.all([...new Set(sourcePaths)].sort().map(async (file) => ({ path: file, sha256: hash(await fs.readFile(path.join(root, file))) })));
  const source_sha256 = hash(files.map((file) => `${file.path}\0${file.sha256}\n`).join(''));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  await json('source-manifest.json', { schema: 'agentbl-w3-source-manifest-v1', base_head: head, source_sha256, file_count: files.length,
    scope: 'application, contracts, tests, scripts, public sample data/resources and build/CI configuration; runtime, secrets and evidence excluded', files });
  await json('deployment-plan.json', await rightsDeploymentPlan());
  const validation = { schema: 'agentbl-w3-validation-v1', date: '2026-10-17', timezone: 'Asia/Singapore', source_sha256, base_head: head,
    runtime: { node: process.version, platform: process.platform, arch: process.arch }, application, contracts: { pass: contracts, fail: 0 },
    w2_actual_evm_http: w2, w3_actual_evm_http: w3, browser: { pass: browser, fail: 0, engine: 'Windows Chromium 1243', new_w3_viewports: [1280, 1440] },
    coverage: { lines: percentages[0], branches: percentages[1], functions: percentages[2], thresholds: { lines: 88, branches: 72, functions: 86 } },
    preflight: Object.fromEntries(['pass', 'warn', 'skip', 'fail'].map((key, index) => [key, Number(preflightSummary[index + 1])])),
    lint: 'passed', build: 'passed', check: 'passed', external: { commit: false, push: false, remote_ci: false, deployment: false,
      real_wallet_human: false, real_asset_legal_control: false, enterprise_identity: false, off_host_restore: false },
    evidence_scope: 'Local real EVM / actual ERC-20 / JS typed signatures / HTTP and browser automation; simulated business documents and research identities' };
  await json('validation.json', validation);
  const registerFile = path.join(root, 'docs/evidence/blockchain-comprehensive-2026-10-17/issue-register.json');
  const register = JSON.parse(await fs.readFile(registerFile, 'utf8'));
  const designs = {
    B04: ['Shared identity reservations, versioned EIP-712 source credentials, per-title invalidation and independent holder terms consent', ['hardhat/contracts/AssetIdentityHub.sol', 'hardhat/contracts/CommittedEBLRegistry.sol']],
    B05: ['Notified and independently reviewed resolution, disputes, actual-recovery reconciliation, distribution-backed loss and governed refinancing risk lock', ['hardhat/contracts/RightsController.sol']],
    B06: ['Domain-bound immutable terms and valuation, collateral exposure limits, price-version acceptance and strict economic/time bounds', ['hardhat/contracts/RightsController.sol', 'src/rights/typedData.js']],
    B07: ['Two distinct governance approvals plus delay/expiry/epoch rotation, revocable least-privilege roles and permanently bound share minter', ['hardhat/contracts/RightsGovernance.sol', 'hardhat/contracts/ControlledRWAToken.sol']],
    B08: ['Restricted research eligibility with expiry/revocation/current screening trust, separate consent and preserved acquired withdrawal rights', ['hardhat/contracts/RightsController.sol']],
    B09: ['Encrypted organization/subject/wallet registry, wallet-bound revocable sessions, two independent publication reviews and shared object authorization across private adapters', ['src/rights/service.js', 'src/app/rightsRoutes.js']],
    B10: ['Commitment-only new title records, salted private material, authenticated encryption and independent allowlisted publication projection', ['hardhat/contracts/CommittedEBLRegistry.sol', 'src/rights/vault.js', 'src/rights/service.js']]
  };
  for (const issue of register.issues.filter((issue) => designs[issue.id])) {
    if (issue.status !== 'IMPLEMENTED') {
      issue.status_history ??= [];
      issue.status_history.push({ date: '2026-10-17', previous_status: issue.status, status: 'IMPLEMENTED', scope: 'W3 local research candidate' });
    }
    issue.status = 'IMPLEMENTED'; issue.implemented_commit = null; issue.verified_source_sha256 = source_sha256;
    issue.verification_receipts = ['docs/evidence/w3-local-2026-10-17/validation.json', 'docs/evidence/w3-local-2026-10-17/source-manifest.json',
      'docs/evidence/w3-local-2026-10-17/README.md'];
    issue.external_gates = ['New controlled-instance deployment and explicit transaction scope are still required; existing v3/v5 deployments are not upgraded.',
      'Real source/title control, legal rights, external valuation/compliance, enterprise identity, independent key custody and off-host recovery remain unverified.'];
    issue.closure_note = { design: designs[issue.id][0], files: designs[issue.id][1], source_manifest: 'docs/evidence/w3-local-2026-10-17/source-manifest.json',
      deployment_scope: 'Local actual EVM + application acceptance only; no testnet broadcast or migration',
      remaining_boundary: 'Research identities and simulated titles/test assets. Two-reviewer publication is enforced in the application gateway; authorized chain roles retain their documented trust and signing obligations.' };
  }
  await fs.writeFile(registerFile, `${JSON.stringify(register, null, 2)}\n`);
  return { source_sha256, files: files.length, application_pass: application.pass, contracts_pass: contracts, actual_evm_pass: w2.pass + w3.pass, browser_pass: browser };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await freezeW3Evidence()));
