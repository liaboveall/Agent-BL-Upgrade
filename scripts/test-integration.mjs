import path from 'node:path';
import { spawn } from 'node:child_process';

const suites = {
  capital: { env: { AGENTBL_W2_INTEGRATION: '1' }, files: ['tests/w2CrossLayer.test.js'] },
  rights: { env: { AGENTBL_W2_INTEGRATION: '1', AGENTBL_W3_INTEGRATION: '1' }, files: ['tests/w3CrossLayer.test.js'] },
  evidence: { env: { AGENTBL_W2_INTEGRATION: '1', AGENTBL_W4_INTEGRATION: '1' }, files: [
    'tests/w4Evidence.test.js', 'tests/w4Provenance.test.js', 'tests/w4Payments.test.js', 'tests/w4BrowserRecovery.test.js', 'tests/w4CrossLayer.test.js'
  ] },
  operations: { env: { AGENTBL_W2_INTEGRATION: '1' }, files: ['tests/w5Operations.test.js', 'tests/w5Controlled.integration.js'] },
  finance: { env: {}, files: ['tests/n3Workflow.integration.js'] }
};
const name = process.argv[2], suite = Object.hasOwn(suites, name ?? '') ? suites[name] : null;
if (!suite || process.argv.length !== 3) throw new Error('Choose one integration suite: ' + Object.keys(suites).join(', '));
const root = path.resolve(import.meta.dirname, '..');
const env = { ...process.env, ...suite.env };
delete env.NODE_TEST_CONTEXT;
const run = (args, cwd = root) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${name} integration exited ${code}`)));
});
await run(['node_modules/hardhat/dist/src/cli.js', 'build'], path.join(root, 'hardhat'));
await run(['--test', ...suite.files]);
