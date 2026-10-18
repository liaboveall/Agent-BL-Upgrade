import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { releaseRoot, releaseSourceSnapshot } from './lib/release-source.mjs';

const at = new Date().toISOString(), directory = path.join(releaseRoot, 'artifacts/validation/runs', at.replaceAll(/[:.]/gu, '-'));
await fs.mkdir(directory, { recursive: true });
const npmCli = process.env.npm_execpath; if (!npmCli || !/npm-cli\.c?js$/u.test(npmCli)) throw new Error('Run through npm run validate');
const before = await releaseSourceSnapshot(), receipts = [];
const run = async (name, args, { executable = process.execPath, timeout = 600000, environment = {} } = {}) => {
  const start = new Date().toISOString(), log = path.join(directory, `${name}.log`), stream = createWriteStream(log, { flags: 'wx' });
  const env = { ...process.env, DEMO_MODE: 'true', REAL_DATA: 'off', NO_COLOR: '1', AGENTBL_W2_INTEGRATION: '1', ...environment };
  delete env.NODE_TEST_CONTEXT; delete env.FORCE_COLOR;
  if (['preflight', 'agent-evaluation'].includes(name)) env.NODE_TEST_CONTEXT = 'w5-offline-gate';
  console.log(`W5 ${name}: started`);
  let timedOut = false;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: releaseRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.on('error', reject); child.on('close', (exitCode) => { clearTimeout(timer); stream.end(() => resolve(exitCode)); });
  });
  receipts.push({ name, executable: executable === process.execPath ? 'node' : executable, args: args.map((arg) => arg === npmCli ? 'npm-cli.js' : arg),
    started_at: start, completed_at: new Date().toISOString(), exit_code: code, timed_out: timedOut, log: path.basename(log) });
  await fs.writeFile(path.join(directory, 'receipts.partial.json'), JSON.stringify({ source_sha256: before.source_sha256, receipts }, null, 2) + '\n');
  console.log(`W5 ${name}: ${code === 0 && !timedOut ? 'PASS' : 'FAIL'}`);
};
const npm = (name, args, options) => run(name, [npmCli, ...args], options);
await npm('lint', ['run', 'lint']); await npm('check', ['run', 'check']); await npm('build', ['run', 'build']);
await npm('contracts', ['run', 'test:contracts']); await npm('application', ['test']); await npm('coverage', ['run', 'test:coverage']);
await npm('w2', ['run', 'test:w2']); await npm('w3', ['run', 'test:w3']); await npm('w4', ['run', 'test:w4']); await npm('w5', ['run', 'test:w5']);
await npm('browser', ['run', 'test:browser']);
await fs.cp(path.join(releaseRoot, 'test-results'), path.join(directory, 'browser-artifacts'), { recursive: true }).catch(() => {});
await npm('agent-evaluation', ['run', 'eval:agent', '--', '--check']);
await npm('preflight', ['run', 'preflight', '--', '--report', path.join(directory, 'preflight.json')], { timeout: 1200000 });
await npm('production-audit', ['audit', '--omit=dev', '--audit-level=high', '--json']);
await npm('contracts-audit', ['--prefix', 'hardhat', 'audit', '--audit-level=high', '--json']);
await npm('clean-build', ['run', 'build:clean', '--', path.join(directory, 'clean-build')], { timeout: 900000 });
await npm('capacity', ['run', 'load:w5', '--', '--soak-seconds', '600', '--output', path.join(directory, 'capacity.json')], { timeout: 750000 });
const after = await releaseSourceSnapshot();
const result = { schema: 'agentbl-w5-command-receipts-v1', started_at: at, completed_at: new Date().toISOString(), source_sha256: before.source_sha256,
  source_unchanged: before.source_sha256 === after.source_sha256, runtime: { node: process.version, platform: process.platform, arch: process.arch },
  browser_executable: process.env.AGENTBL_CHROMIUM_PATH ?? 'Playwright default', receipts };
result.passed = result.source_unchanged && receipts.every((item) => item.exit_code === 0 && !item.timed_out);
await fs.writeFile(path.join(directory, 'source-manifest.json'), JSON.stringify(before, null, 2) + '\n');
await fs.writeFile(path.join(directory, 'receipts.json'), JSON.stringify(result, null, 2) + '\n');
await fs.writeFile(path.join(releaseRoot, 'artifacts/validation/latest-run.json'), JSON.stringify({ directory: path.relative(releaseRoot, directory).replaceAll('\\', '/'), passed: result.passed }, null, 2) + '\n');
console.log(JSON.stringify({ passed: result.passed, source_unchanged: result.source_unchanged, directory })); process.exitCode = result.passed ? 0 : 1;
