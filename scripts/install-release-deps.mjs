// Fresh dependency install for release verification and CI: exact lockfiles with third-party install scripts disabled,
// then the one reviewed patch the contracts workspace needs (hardhat/scripts/patch-zod-compat.mjs, its postinstall on an
// ordinary install) applied explicitly and checked. Without it a fresh install crashes Hardhat's configuration diagnostics.
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli || !/npm-cli\.c?js$/u.test(npmCli)) throw new Error('Run through npm run install:release');
const root = path.resolve(import.meta.dirname, '..');
for (const [name, args] of [['application', [npmCli, 'ci', '--ignore-scripts']], ['contracts', [npmCli, '--prefix', 'hardhat', 'ci', '--ignore-scripts']],
  ['contracts patch', ['hardhat/scripts/patch-zod-compat.mjs', '--verify']]]) {
  console.log(`install:release ${name}`);
  const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`install:release ${name} failed with exit code ${run.status}`);
}
