import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, AGENTBL_W2_INTEGRATION: '1' };
delete env.NODE_TEST_CONTEXT;
function run(args, cwd, childEnv = env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env: childEnv, stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`W2 verification exited ${code}`)));
  });
}
await run(['node_modules/hardhat/dist/src/cli.js', 'build'], path.join(root, 'hardhat'));
await run(['--test', 'tests/w2CrossLayer.test.js'], root);
