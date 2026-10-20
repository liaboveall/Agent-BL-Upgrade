// Reproduce the dirty candidate in a fresh local clone without publishing or committing it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { releaseRoot, releaseSourceSnapshot, releaseSourceByteIssues, digest } from './lib/release-source.mjs';

const npmCli = process.env.npm_execpath;
if (!npmCli || !/npm-cli\.c?js$/u.test(npmCli)) throw new Error('Run through npm run verify:release');
const source = await releaseSourceSnapshot();
const byteIssues = await releaseSourceByteIssues(source);
if (byteIssues.length) throw new Error('Normalize .gitattributes LF sources before release verification: ' + byteIssues.join(', '));
const directory = path.join(releaseRoot, 'artifacts/releases', new Date().toISOString().replaceAll(/[:.]/gu, '-'));
await fs.mkdir(directory, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-release-'));
if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected temporary root');
const checkout = path.join(temporary, 'checkout'), receipts = [];
// Only OS/runtime discovery settings cross into the clone. No .env, provider, signing or application credentials.
const allowed = /^(?:path|systemroot|windir|comspec|pathext|temp|tmp|userprofile|home|appdata|localappdata|programfiles(?:\(x86\))?|programdata|ci|npm_config_cache)$/iu;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
Object.assign(env, { DEMO_MODE: 'true', REAL_DATA: 'off', X402_MODE: 'demo', AGENTBL_RUNTIME_DIR: path.join(temporary, 'runtime'), AGENTBL_N3_EVIDENCE: directory });
if (process.env.AGENTBL_CHROMIUM_PATH) env.AGENTBL_CHROMIUM_PATH = process.env.AGENTBL_CHROMIUM_PATH;
else if (process.platform === 'win32') {
  const edge = path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  try { await fs.access(edge); env.AGENTBL_CHROMIUM_PATH = edge; } catch {}
}
const run = async (name, executable, args, { cwd = checkout, context = false } = {}) => {
  const log = `${name}.log`, started = new Date().toISOString(), handle = await fs.open(path.join(directory, log), 'wx');
  let code;
  try {
    const child = spawn(executable, args, { cwd, env: { ...env, ...(context ? { NODE_TEST_CONTEXT: 'n5-offline' } : {}) }, windowsHide: true, stdio: ['ignore', handle.fd, handle.fd] });
    code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  } finally { await handle.close(); }
  const raw = await fs.readFile(path.join(directory, log));
  const substantive = !['coverage', 'n3-evm', 'w2', 'w3', 'w4', 'w5'].includes(name)
    || /^(?:# tests |ℹ tests )([1-9]\d*)/mu.test(raw.toString());
  receipts.push({ name, started_at: started, completed_at: new Date().toISOString(), exit_code: code, substantive_execution: substantive, log, log_sha256: digest(raw) });
  await fs.writeFile(path.join(directory, 'progress.json'), JSON.stringify({ source_sha256: source.source_sha256, receipts }, null, 2) + '\n');
  console.log(`Release ${name}: ${code === 0 && substantive ? 'PASS' : 'FAIL'}`);
  return code === 0 && substantive;
};
const npm = (name, args, options) => run(name, process.execPath, [npmCli, ...args], options);
let cloneSource, after, error;
try {
  if (!await run('clone', 'git', ['clone', '--quiet', '--no-hardlinks', releaseRoot, checkout], { cwd: temporary })) throw new Error('Fresh local clone failed');
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: releaseRoot }).toString().split('\0').filter(Boolean);
  for (const name of names) {
    const from = path.join(releaseRoot, name), to = path.join(checkout, name);
    try { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to); }
    catch (failure) { if (failure.code !== 'ENOENT') throw failure; await fs.rm(to, { force: true }); }
  }
  const cloned = await import(pathToFileURL(path.join(checkout, 'scripts/lib/release-source.mjs')).href);
  cloneSource = await cloned.releaseSourceSnapshot();
  if (cloneSource.source_sha256 !== source.source_sha256) throw new Error('Fresh clone overlay differs from candidate manifest');
  await fs.writeFile(path.join(directory, 'source-manifest.json'), JSON.stringify(source, null, 2) + '\n');
  if (!await npm('install-app', ['ci', '--ignore-scripts']) || !await npm('install-contracts', ['--prefix', 'hardhat', 'ci', '--ignore-scripts'])) throw new Error('Fresh dependency install failed');
  for (const [name, command] of [['lint', 'lint'], ['check', 'check'], ['build', 'build'], ['contracts', 'test:contracts'], ['coverage', 'test:coverage'],
    ['w2', 'test:capital'], ['w3', 'test:rights'], ['w4', 'test:evidence'], ['w5', 'test:operations'], ['n3-evm', 'test:finance'], ['browser', 'test:browser']]) {
    await npm(name, ['run', command]);
  }
  await fs.cp(path.join(checkout, 'test-results'), path.join(directory, 'browser'), { recursive: true });
  await npm('agent', ['run', 'eval:agent', '--', '--check'], { context: true });
  await npm('preflight', ['run', 'preflight', '--', '--report', path.join(directory, 'preflight.json')], { context: true });
  await npm('production-audit', ['audit', '--omit=dev', '--audit-level=high', '--json']);
  await npm('contracts-audit', ['--prefix', 'hardhat', 'audit', '--audit-level=high', '--json']);
  await npm('clean-build', ['run', 'build:clean', '--', path.join(directory, 'clean-build')]);
  await run('container', process.execPath, ['scripts/verify-container.mjs', path.join(directory, 'container')]);
  await npm('capacity', ['run', 'test:load', '--', '--soak-seconds', '600', '--output', path.join(directory, 'capacity.json')]);
  after = await cloned.releaseSourceSnapshot();
} catch (failure) { error = failure.message; }
finally {
  const current = await releaseSourceSnapshot();
  const result = { schema: 'agentbl-release-local-candidate-v1', source_sha256: source.source_sha256, base_head: source.base_head, file_count: source.file_count,
    generated_at: new Date().toISOString(), environment: { node: process.version, platform: process.platform, architecture: process.arch, browser: env.AGENTBL_CHROMIUM_PATH ?? 'Playwright default' },
    fresh_clone_matches: cloneSource?.source_sha256 === source.source_sha256, source_unchanged: after?.source_sha256 === source.source_sha256 && current.source_sha256 === source.source_sha256,
    receipts, ...(error ? { error } : {}), ci_verified: false, public_testnet_deployed: false, human_verified: false, public_broadcasts: 0 };
  result.passed = !error && result.source_unchanged && result.fresh_clone_matches && receipts.length === 21 && receipts.every((r) => r.exit_code === 0 && r.substantive_execution);
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: result.passed, source_sha256: source.source_sha256, ...(error ? { error } : {}) }));
  // Only this invocation's checked, freshly-created temporary root is removed.
  await fs.rm(temporary, { recursive: true, force: true });
  process.exitCode = result.passed ? 0 : 1;
}
