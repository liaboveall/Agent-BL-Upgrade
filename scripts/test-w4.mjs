import path from 'node:path';
import { spawn } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, AGENTBL_W4_INTEGRATION: '1', AGENTBL_W2_INTEGRATION: '1' };
delete env.NODE_TEST_CONTEXT;
const run = (args, cwd = root) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`W4 verification exited ${code}`)));
});
await run(['node_modules/hardhat/dist/src/cli.js', 'build'], path.join(root, 'hardhat'));
await run(['--test', 'tests/w4Evidence.test.js', 'tests/w4Provenance.test.js', 'tests/w4Payments.test.js', 'tests/w4BrowserRecovery.test.js', 'tests/w4CrossLayer.test.js']);
