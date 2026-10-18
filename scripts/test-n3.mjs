import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { releaseRoot, releaseSourceSnapshot } from './lib/release-source.mjs';
import { rightsDeploymentPlan } from './rights-plan.mjs';

const npmCli = process.env.npm_execpath;
if (!npmCli || !/npm-cli\.c?js$/u.test(npmCli)) throw new Error('Run through npm run test:n3');
const directory = path.join(releaseRoot, 'artifacts/n3', new Date().toISOString().replaceAll(/[:.]/gu, '-'));
await fs.mkdir(directory, { recursive: true });
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-n3-'));
if (!path.resolve(runtime).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected isolated runtime path');
const source = await releaseSourceSnapshot(), commands = [];
const env = { ...process.env, NODE_TEST_CONTEXT: 'n3-offline', AGENTBL_RUNTIME_DIR: runtime, AGENTBL_N3_EVIDENCE: directory };
for (const name of Object.keys(env)) if (/PRIVATE_KEY|API_KEY|_TOKEN$|AGENTBL_RIGHTS_KEY|AGENTBL_RIGHTS_CONFIG/u.test(name)) delete env[name];
if (process.platform === 'win32' && !env.AGENTBL_CHROMIUM_PATH) {
  const edge = path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  try { await fs.access(edge); env.AGENTBL_CHROMIUM_PATH = edge; } catch {}
}
let stable = false;
try {
  for (const name of ['lint', 'check', 'build', 'test', 'test:contracts', 'test:w2', 'test:w3', 'test:w4', 'test:w5', 'test:n3:evm', 'test:browser', 'eval:agent', 'preflight']) {
    const args = [npmCli, 'run', name, ...(name === 'eval:agent' ? ['--', '--check'] : name === 'preflight' ? ['--', '--report', path.join(directory, 'preflight.json')] : [])];
    const started = new Date().toISOString(), log = `${name.replaceAll(':', '-')}.log`;
    const output = await fs.open(path.join(directory, log), 'wx');
    let code;
    try {
      const childEnv = { ...env };
      if (name === 'test') delete childEnv.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, args, { cwd: releaseRoot, env: childEnv, windowsHide: true, stdio: ['ignore', output.fd, output.fd] });
      code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    } finally { await output.close(); }
    const raw = await fs.readFile(path.join(directory, log), 'utf8');
    const executed = name !== 'test' || (/^(?:# tests |ℹ tests )([1-9]\d*)/mu.test(raw) && !/skipping running files/u.test(raw));
    if (!executed) code = 1;
    commands.push({ command: `npm run ${name}`, exit_code: code, substantive_execution: executed, started_at: started, completed_at: new Date().toISOString(), log });
    await fs.writeFile(path.join(directory, 'progress.json'), JSON.stringify({ source_sha256: source.source_sha256, commands }, null, 2) + '\n');
    console.log(`${name}: ${code === 0 ? 'PASS' : 'FAIL'} (${log})`);
  }
  await fs.cp(path.join(releaseRoot, 'test-results'), path.join(directory, 'browser'), { recursive: true });
  await fs.writeFile(path.join(directory, 'deployment-plan.json'), JSON.stringify(await rightsDeploymentPlan(), null, 2) + '\n');
  stable = (await releaseSourceSnapshot()).source_sha256 === source.source_sha256;
} finally {
  const report = { schema: 'agentbl-n3-local-validation-v1', generated_at: new Date().toISOString(), source,
    environment: { platform: process.platform, architecture: process.arch, node: process.version, browser_executable: env.AGENTBL_CHROMIUM_PATH ?? 'Playwright bundled browser' }, commands,
    source_unchanged: stable, passed: stable && commands.length === 13 && commands.every((command) => command.exit_code === 0),
    external_broadcasts: 0, ci_verified: false, testnet_deployed: false, human_wallet_verified: false,
    earlier_observations: [
      'artifacts/n3-evm-initial.log: empty NODE_TEST_CONTEXT still caused zero execution; excluded',
      'artifacts/n3-evm-second.log: before-hook context has no t.after; fixture initialization corrected',
      'artifacts/n3-evm-third.log: missing fixture wallet kind and public nextPoolId ABI; corrected',
      'artifacts/n3-w5-initial.log: run started before the nextPoolId ABI correction; position reconciliation failed',
      'artifacts/n3-evm-fourth.log: four EVM paths passed before the final bounded-provider and historical projection review; interim evidence only',
      'artifacts/n3-browser-initial.log: four browser cases passed before final review; interim evidence only',
      'artifacts/n3/2026-10-18T13-55-15-547Z/result.json: all thirteen commands exited zero but source changed during final action-preview and privacy review; interim only',
      'artifacts/n3-unified-certified.log: run superseded while restoring the revoked-subject exit-only session invariant; interim only',
      'artifacts/n3-lint-refinement.log: duplicate translated document label was corrected',
      'artifacts/n3/2026-10-18T13-48-14-177Z/result.json: source changed during final review; 27/28 browser tests, zh390 pagination clicked before automatic wallet restoration reset; corrected synchronization waits for wallet positions and verifies explicit wallet reset; initial trace retained'
    ] };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, source_sha256: source.source_sha256 }));
  if (!report.passed) process.exitCode = 1;
  // This process created this absolute temp directory; all child test servers must have exited.
  await fs.rm(runtime, { recursive: true, force: true });
}
