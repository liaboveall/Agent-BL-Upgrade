import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, AGENTBL_W3_INTEGRATION: '1', AGENTBL_W2_INTEGRATION: '1' };
delete env.NODE_TEST_CONTEXT;
const run = (args, cwd) => new Promise((resolve, reject) => {
  const process = spawn(globalThis.process.execPath, args, { cwd, env, stdio: 'inherit' });
  process.on('error', reject);
  process.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`W3 verification exited ${code}`)));
});
await run(['node_modules/hardhat/dist/src/cli.js', 'build'], path.join(root, 'hardhat'));
await run(['--test', 'tests/w3CrossLayer.test.js'], root);
