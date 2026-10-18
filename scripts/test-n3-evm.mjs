import path from 'node:path';
import { spawn } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const run = (args, cwd = root) => new Promise((resolve, reject) => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`N3 EVM verification exited ${code}`)));
});
await run(['node_modules/hardhat/dist/src/cli.js', 'build'], path.join(root, 'hardhat'));
await run(['--test', 'tests/n3Workflow.integration.js']);
