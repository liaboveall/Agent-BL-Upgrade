import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { lfSourcePaths, releaseSourceSnapshot, releaseSourceByteIssues } from '../scripts/lib/release-source.mjs';

test('release evidence honors LF attributes including untracked inputs and binary overrides', () => {
  const attributes = [
    'src/new module.js', 'text', 'set', 'src/new module.js', 'eol', 'lf',
    'public/vendor/bundle.js', 'text', 'unset', 'public/vendor/bundle.js', 'eol', 'lf',
    'data/uploads/source.json', 'text', 'unset', 'data/uploads/source.json', 'eol', 'lf',
    'docs/guide.md', 'text', 'auto', 'docs/guide.md', 'eol', 'unspecified'
  ].join('\0') + '\0';
  assert.deepEqual(lfSourcePaths(attributes), ['src/new module.js']);
});

test('current release byte digest matches the content Git would publish', async () => {
  const source = await releaseSourceSnapshot();
  assert.deepEqual(await releaseSourceByteIssues(source), []);
  // Exercise the real Git clean filter as an independent oracle, not just the
  // newline scanner. Include both the protocol input and frozen binary fixtures.
  for (const file of ['src/rights/service.js', 'hardhat/contracts/RightsController.sol',
    'scripts/config/testnet-deployment-baseline.json', 'public/vendor/manifest.json']) {
    const raw = await fs.readFile(file);
    const unfiltered = execFileSync('git', ['hash-object', '--stdin', '--no-filters'], { input: raw }).toString().trim();
    const published = execFileSync('git', ['hash-object', '--stdin', '--path', file], { input: raw }).toString().trim();
    assert.equal(unfiltered, published, `${file} would change at commit/checkout`);
  }
});
