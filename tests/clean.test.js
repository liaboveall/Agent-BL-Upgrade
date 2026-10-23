import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanGenerated } from '../scripts/clean.mjs';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentbl-clean-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const put = async (relative) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'preserve these bytes');
  };
  return { root, put };
}

test('cleanup previews without writes and preserves runtime, evidence, secrets and application dependencies', async (t) => {
  const { root, put } = await workspace(t);
  const preserved = ['.env', 'data/runtime/ledger/cash.jsonl', 'data/runtime/owner-cli/lock',
    'artifacts/acceptance/result.json', 'node_modules/package/index.js', 'hardhat/node_modules/package/index.js'];
  for (const file of [...preserved, 'dist/index.html', 'hardhat/artifacts/output.json', 'test-results/browser.json']) await put(file);
  assert.deepEqual(await cleanGenerated(root, { dryRun: true }), ['dist', 'hardhat/artifacts', 'test-results']);
  assert.equal(await fs.readFile(path.join(root, 'dist/index.html'), 'utf8'), 'preserve these bytes');
  await cleanGenerated(root);
  await assert.rejects(fs.access(path.join(root, 'dist')), { code: 'ENOENT' });
  for (const file of preserved) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), 'preserve these bytes');
  assert.deepEqual(await cleanGenerated(root), []);
});

test('cleanup rejects a redirected parent before deleting any output', async (t) => {
  const { root, put } = await workspace(t);
  await put('dist/index.html');
  await put('data/runtime/artifacts/checkpoint.json');
  await fs.symlink(path.join(root, 'data/runtime'), path.join(root, 'hardhat'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanGenerated(root), /Refusing redirected/u);
  assert.equal(await fs.readFile(path.join(root, 'dist/index.html'), 'utf8'), 'preserve these bytes');
  assert.equal(await fs.readFile(path.join(root, 'data/runtime/artifacts/checkpoint.json'), 'utf8'), 'preserve these bytes');
});
