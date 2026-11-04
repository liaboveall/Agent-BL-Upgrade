// Assessment 2026-11-04 F01: the browser refused two pool-targeted operations the server prepared, because each side kept
// its own idea of where an operation may be sent. One table (src/rights/operations.js) now names the contract and the
// function of every operation; this checks it against every compiled ABI that can still prepare each operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AbiCoder, Interface, id } from 'ethers';
import { RIGHTS_OPERATIONS, rightsCallMatches, rightsTarget } from '../src/rights/operations.js';
import { LEGACY_OPERATIONS, FROZEN_ARTIFACTS } from '../src/rights/chain.js';

const CONTRACT = { controller: 'RightsController', registry: 'CommittedEBLRegistry', pool: 'RWAOfferingPoolV5' };
const decodeBytes = (hex) => AbiCoder.defaultAbiCoder().decode(['bytes'], hex)[0];
// The current build's artifacts are git-ignored: where contracts are not compiled (the CI app job) the current-ABI check
// is skipped; npm run test:rights compiles them and runs this file in full.
const COMPILED = existsSync(path.resolve('hardhat/artifacts/contracts/RightsController.sol/RightsController.json'));
const current = async (name) => new Interface(JSON.parse(await fs.readFile(path.resolve('hardhat/artifacts/contracts', `${name}.sol`, `${name}.json`), 'utf8')).abi);
const frozen = async (version) => {
  const { contracts } = JSON.parse(await fs.readFile(path.resolve('scripts/config', FROZEN_ARTIFACTS[version]), 'utf8'));
  return Object.fromEntries(Object.values(CONTRACT).map((name) => [name, new Interface(contracts[name].abi)]));
};
/** Calldata for an operation from an ABI set, with zero arguments of the right types. */
function encode(abis, operation) {
  const spec = RIGHTS_OPERATIONS[operation], target = abis[CONTRACT[spec.target]];
  const zeros = (fragment) => AbiCoder.defaultAbiCoder().decode(fragment.inputs, `0x${'00'.repeat(32 * 64)}`).toArray?.() ?? [];
  if (!spec.lifecycle) { const fragment = target.getFunction(spec.method); return target.encodeFunctionData(fragment, zeros(fragment)); }
  const pool = abis.RWAOfferingPoolV5, inner = pool.getFunction(spec.lifecycle.method);
  return target.encodeFunctionData(spec.method, [pool.encodeFunctionData(inner, zeros(inner))]);
}

test('every operation names a function of its contract with the pinned selector, in the current build',
  { skip: COMPILED ? false : 'contracts are not compiled here; npm run test:rights compiles them and runs this test' }, async () => {
  const abis = Object.fromEntries(await Promise.all(Object.values(CONTRACT).map(async (name) => [name, await current(name)])));
  for (const [operation, spec] of Object.entries(RIGHTS_OPERATIONS)) {
    assert.equal(abis[CONTRACT[spec.target]].getFunction(spec.method).selector, spec.selector, operation);
    if (spec.lifecycle) assert.equal(abis.RWAOfferingPoolV5.getFunction(spec.lifecycle.method).selector, spec.lifecycle.selector, `${operation} inner call`);
    assert.equal(rightsCallMatches(operation, encode(abis, operation), decodeBytes), true, operation);
  }
});

test('superseded instances keep the same selectors for every exit they still allow', async () => {
  for (const version of [2, 3]) {
    const abis = await frozen(version);
    for (const operation of LEGACY_OPERATIONS[version]) {
      const spec = RIGHTS_OPERATIONS[operation];
      assert.ok(spec, `v${version} ${operation} is in the table`);
      assert.equal(abis[CONTRACT[spec.target]].getFunction(spec.method).selector, spec.selector, `v${version} ${operation}`);
      if (spec.lifecycle) assert.equal(abis.RWAOfferingPoolV5.getFunction(spec.lifecycle.method).selector, spec.lifecycle.selector, `v${version} ${operation} inner`);
    }
  }
});

test('a call that is not the operation\'s own function never matches', async () => {
  // The frozen v3 ABI is committed and has every function used here, with the same selectors as the current build.
  const abis = await frozen(3);
  const pool = abis.RWAOfferingPoolV5, controller = abis.RightsController;
  // Pool operations really are pool functions: the browser used to accept only repay there.
  assert.deepEqual(Object.entries(RIGHTS_OPERATIONS).filter(([, spec]) => spec.target === 'pool').map(([name]) => name).sort(), ['finalize_funding', 'repay', 'retry_collateral_release']);
  assert.equal(rightsCallMatches('finalize_funding', pool.encodeFunctionData('retryCollateralRelease', [1]), decodeBytes), false);
  assert.equal(rightsCallMatches('repay', pool.encodeFunctionData('finalizeFunding', [1]), decodeBytes), false);
  // A lifecycle call whose inner function is another lifecycle step, or not a pool function at all.
  assert.equal(rightsCallMatches('mark_in_transit', controller.encodeFunctionData('executeLifecycle', [pool.encodeFunctionData('settle', [1, 1])]), decodeBytes), false);
  assert.equal(rightsCallMatches('settle', controller.encodeFunctionData('executeLifecycle', ['0x']), decodeBytes), false);
  assert.equal(rightsCallMatches('settle', `${RIGHTS_OPERATIONS.settle.selector}deadbeef`, decodeBytes), false);
  for (const value of [undefined, null, '', '0x', '0x1234', 'not hex', 42]) assert.equal(rightsCallMatches('repay', value, decodeBytes), false, String(value));
  for (const name of ['unknown', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(rightsCallMatches(name, pool.encodeFunctionData('repay', [1, 1]), decodeBytes), false, name);
    assert.equal(rightsTarget(name, { controller: 'c', registry: 'r', pool: 'p' }), null, name);
  }
  assert.equal(rightsTarget('finalize_funding', { controller: 'c', registry: 'r', pool: 'p' }), 'p');
  assert.equal(rightsTarget('pledge', { controller: 'c', registry: 'r', pool: 'p' }), 'r');
  assert.equal(rightsTarget('mark_default', { controller: 'c', registry: 'r', pool: 'p' }), 'c');
  assert.equal(RIGHTS_OPERATIONS.repay.selector, id('repay(uint256,uint256)').slice(0, 10));
});
