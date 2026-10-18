import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { releaseRoot, releaseSourceSnapshot } from './lib/release-source.mjs';

const npmCli = process.env.npm_execpath;
if (!npmCli || !/npm-cli\.c?js$/u.test(npmCli)) throw new Error('Run through npm run test:n4');
const directory = path.join(releaseRoot, 'artifacts/n4', new Date().toISOString().replaceAll(/[:.]/gu, '-'));
await fs.mkdir(directory, { recursive: true });
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-n4-'));
if (!path.resolve(runtime).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected isolated runtime path');
const source = await releaseSourceSnapshot(), commands = [];
const env = { ...process.env, NODE_TEST_CONTEXT: 'n4-offline', AGENTBL_RUNTIME_DIR: runtime, AGENTBL_N3_EVIDENCE: directory };
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
  stable = (await releaseSourceSnapshot()).source_sha256 === source.source_sha256;
} finally {
  const report = { schema: 'agentbl-n4-local-validation-v1', generated_at: new Date().toISOString(), source,
    environment: { platform: process.platform, architecture: process.arch, node: process.version, browser_executable: env.AGENTBL_CHROMIUM_PATH ?? 'Playwright bundled browser' }, commands,
    source_unchanged: stable, passed: stable && commands.length === 13 && commands.every((command) => command.exit_code === 0),
    external_broadcasts: 0, ci_verified: false, testnet_deployed: false, human_wallet_verified: false, mobile_wallet_verified: false,
    earlier_observations: [
      'artifacts/n4-browser-initial.log and n4-initial/browser: 10 failed, 6 passed; mobile stats overflow and pagination focus loss',
      'artifacts/n4-lint-second.log: malformed diagnostic assertion; corrected before rerun',
      'artifacts/n4-browser-second.log and n4-second/browser: 390px stats flex sizing located; focus fix passed',
      'artifacts/n4-browser-third.log and n4-third/browser: N4 zh390 passed; nested summaries made old N3 locator ambiguous; replaced with explicit role-entry button',
      'artifacts/n4-browser-fourth.log and n4-fourth/browser: 15 passed, 1 failed; English discover section actions overflowed at 390px; responsive wrapping added. Superseded by final source-bound run',
      'artifacts/n4-unified-initial.log: mixed-source intermediate run, source stability false; superseded after final footer wording and default finance role entry checks. N2 en768 clicked details before automatic wallet restoration reset selection; test now waits for wallet positions. Modal focus assertions include native summary controls. Legacy root-page evidence tests now expand the research-tools section'
    ] };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, source_sha256: source.source_sha256 }));
  if (!report.passed) process.exitCode = 1;
  // This process created this absolute temp directory; all child test servers must have exited.
  await fs.rm(runtime, { recursive: true, force: true });
}
