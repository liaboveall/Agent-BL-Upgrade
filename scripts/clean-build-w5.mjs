import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { releaseRoot, releaseSourceSnapshot, digest } from './lib/release-source.mjs';

const out = path.resolve(process.argv[2] ?? 'docs/evidence/w5-2026-10-18/clean-build');
await fs.mkdir(out, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli || !/npm-cli\.c?js$/u.test(npmCli)) throw new Error('Run through npm run build:clean');
const source = await releaseSourceSnapshot(), attempts = [];
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-clean-'));
const artifactNames = ['RightsGovernance', 'AssetIdentityHub', 'CommittedEBLRegistry', 'RightsController', 'ControlledRWAToken', 'RWAOfferingPoolV5', 'AgentDecisionLog'];
// Solc AST identifiers depend on the compilation group. The immutable byte ranges do not.
const normalizedArtifact = (artifact) => ({ abi: artifact.abi, bytecode: artifact.bytecode, deployedBytecode: artifact.deployedBytecode,
  immutableReferences: Object.values(artifact.immutableReferences ?? {}).flat().sort((a, b) => a.start - b.start).map(({ start, length }) => ({ start, length })) });
async function collect(directory, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collect(directory, file));
    else files.push({ path: file, sha256: digest(await fs.readFile(path.join(directory, file))) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
try {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const dir = path.join(temp, `build-${attempt}`); await fs.mkdir(dir);
    for (const file of source.files) {
      const target = path.join(dir, file.path); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(releaseRoot, file.path), target);
    }
    const env = { ...process.env, NODE_TEST_CONTEXT: 'w5-clean-build', AGENTBL_W2_INTEGRATION: '1' };
    for (const name of Object.keys(env)) if (/PRIVATE_KEY|API_KEY|AGENTBL_RIGHTS_KEY|ALERT_TOKEN/u.test(name)) delete env[name];
    const commands = [];
    const run = async (name, args, cwd = dir) => {
      const startedAt = new Date().toISOString(); let output = '';
      const child = spawn(process.execPath, [npmCli, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
      const timeout = setTimeout(() => child.kill(), 300000);
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); clearTimeout(timeout);
      const log = `build-${attempt}-${name}.log`; await fs.writeFile(path.join(out, log), output);
      commands.push({ name, args, started_at: startedAt, completed_at: new Date().toISOString(), exit_code: code, log });
      console.log(`Clean build ${attempt}: ${name} ${code === 0 ? 'PASS' : 'FAIL'}`);
      if (code !== 0) throw new Error(`Clean build ${attempt} failed at ${name}`);
    };
    await run('install-app', ['ci', '--ignore-scripts']); await run('install-contracts', ['ci', '--ignore-scripts'], path.join(dir, 'hardhat'));
    await run('web', ['run', 'build']); await run('contracts', ['run', 'compile'], path.join(dir, 'hardhat'));
    const web = await collect(path.join(dir, 'dist'));
    const contracts = [];
    for (const name of artifactNames) {
      const artifact = JSON.parse(await fs.readFile(path.join(dir, 'hardhat/artifacts/contracts', `${name}.sol`, `${name}.json`), 'utf8'));
      const normalized = normalizedArtifact(artifact);
      const current = JSON.parse(await fs.readFile(path.join(releaseRoot, 'hardhat/artifacts/contracts', `${name}.sol`, `${name}.json`), 'utf8'));
      if (JSON.stringify(normalized) !== JSON.stringify(normalizedArtifact(current))) throw new Error(`${name} clean artifact differs from the deployed-source build`);
      contracts.push({ name, sha256: digest(JSON.stringify(normalized)), runtime_bytes: (artifact.deployedBytecode.length - 2) / 2 });
    }
    attempts.push({ attempt, commands, web, contracts });
  }
  const after = await releaseSourceSnapshot();
  const passed = source.source_sha256 === after.source_sha256 && JSON.stringify(attempts[0].web) === JSON.stringify(attempts[1].web)
    && JSON.stringify(attempts[0].contracts) === JSON.stringify(attempts[1].contracts);
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ schema: 'agentbl-clean-build-v1', generated_at: new Date().toISOString(), source_sha256: source.source_sha256,
    runtime: { node: process.version, platform: process.platform }, passed, attempts }, null, 2) + '\n');
  if (!passed) throw new Error('Clean builds or source revision differ');
  console.log('Clean build reproducibility: PASS');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
