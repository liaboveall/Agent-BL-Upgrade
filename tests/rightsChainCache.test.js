import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder } from 'ethers';
import { RightsChainService, verifyChain } from '../src/rights/chain.js';

const HUB = '0x00000000000000000000000000000000000000a1';
const REGISTRY = '0x00000000000000000000000000000000000000b2';

/** A chain whose full binding check is counted; the per-call checks read a stub network and hub. */
function chainWith({ chainId = 1439n, enrolled = true, reuseMs = 60_000 } = {}) {
  const state = { chainId, enrolled, full: 0, light: 0 };
  const provider = {
    getNetwork: async () => { state.light += 1; return { chainId: state.chainId }; },
    call: async () => AbiCoder.defaultAbiCoder().encode(['bool'], [state.enrolled])
  };
  class Counted extends RightsChainService {
    async verifyBindings() {
      state.full += 1;
      return { chain_id: '1439', controller: '0xc', pool: '0xp', governance: '0xg', control_version: 3, exit_only: false, hub: HUB, registry: REGISTRY };
    }
  }
  return { state, chain: new Counted({ provider, chainId: 1439, verifyReuseMs: reuseMs }) };
}

test('page reads reuse a complete verification but still re-read the network and hub enrollment', async () => {
  const { state, chain } = chainWith();
  const first = await verifyChain(chain);
  assert.equal(state.full, 1);
  assert.deepEqual(Object.keys(first).sort(), ['chain_id', 'control_version', 'controller', 'exit_only', 'governance', 'pool']);
  assert.deepEqual(await verifyChain(chain), first);
  assert.equal(state.full, 1, 'the immutable bindings are not re-read');
  assert.equal(state.light, 1);
  state.chainId = 1n;
  await assert.rejects(verifyChain(chain), { code: 'rights_network_mismatch' });
  state.chainId = 1439n; state.enrolled = false;
  await assert.rejects(verifyChain(chain), { code: 'rights_registry_not_enrolled' });
});

test('signing paths and an expired reuse window verify in full; concurrent page reads share one full check', async () => {
  const { state, chain } = chainWith({ reuseMs: 0 });
  await Promise.all([verifyChain(chain), verifyChain(chain), verifyChain(chain)]);
  assert.equal(state.full, 1);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await verifyChain(chain);
  assert.equal(state.full, 2);
  await chain.verify();
  assert.equal(state.full, 3);
});
