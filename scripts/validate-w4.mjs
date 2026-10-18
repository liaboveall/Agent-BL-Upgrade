import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { w4Root, w4SourceSnapshot } from './lib/w4-source.mjs';

const base = path.join(w4Root, 'docs/evidence/w4-local-2026-10-17'), at = new Date().toISOString();
const directory = path.join(base, 'runs', at.replaceAll(/[:.]/gu, '-')); await fs.mkdir(directory, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli || !/npm-cli\.c?js$/u.test(npmCli)) throw new Error('Run through npm run validate:w4');
const before = await w4SourceSnapshot(), receipts = [];
const run = async (name, args, overrides = {}) => {
  const env = { ...process.env, DEMO_MODE: 'true', REAL_DATA: 'off', ...overrides }; delete env.NODE_TEST_CONTEXT;
  if (name === 'preflight') env.NODE_TEST_CONTEXT = 'w4-preflight-offline';
  const start = new Date().toISOString(), stream = createWriteStream(path.join(directory, `${name}.log`), { flags: 'wx' });
  console.log(`W4 ${name}: started`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, 'run', ...args], { cwd: w4Root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
    child.on('error', reject); child.on('close', (exitCode) => stream.end(() => resolve(exitCode)));
  });
  receipts.push({ name, command: `npm run ${args.join(' ')}`, started_at: start, completed_at: new Date().toISOString(), exit_code: code,
    log: path.relative(base, path.join(directory, `${name}.log`)).replaceAll('\\', '/') });
  console.log(`W4 ${name}: ${code === 0 ? 'PASS' : `FAIL (${code})`}`);
};
await run('lint', ['lint']); await run('check', ['check']); await run('build', ['build']);
await run('contracts', ['test:contracts']); await run('application', ['test']); await run('coverage', ['test:coverage']);
await run('w2', ['test:w2']); await run('w3', ['test:w3']); await run('w4', ['test:w4']);
await run('browser', ['test:browser']);
await fs.cp(path.join(w4Root, 'test-results'), path.join(directory, 'browser-artifacts'), { recursive: true }).catch(() => {});
await run('agent-evaluation', ['eval:agent', '--', '--check']);
await run('preflight', ['preflight', '--', '--report', path.join(directory, 'preflight.json')]);
const after = await w4SourceSnapshot();
const result = { schema: 'agentbl-w4-command-receipts-v1', started_at: at, completed_at: new Date().toISOString(),
  source_sha256: before.source_sha256, source_unchanged: before.source_sha256 === after.source_sha256,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  browser_executable: process.env.AGENTBL_CHROMIUM_PATH ?? 'Playwright default bundled executable', receipts };
result.passed = result.source_unchanged && receipts.every((item) => item.exit_code === 0);
await fs.writeFile(path.join(directory, 'source-manifest.json'), `${JSON.stringify(before, null, 2)}\n`);
await fs.writeFile(path.join(directory, 'receipts.json'), `${JSON.stringify(result, null, 2)}\n`);
await fs.writeFile(path.join(base, 'latest-run.json'), `${JSON.stringify({ directory: path.relative(base, directory).replaceAll('\\', '/'), passed: result.passed }, null, 2)}\n`);
console.log(JSON.stringify({ passed: result.passed, source_unchanged: result.source_unchanged, directory })); process.exitCode = result.passed ? 0 : 1;
