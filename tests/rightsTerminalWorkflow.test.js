import test from 'node:test';
import assert from 'node:assert/strict';
import { materialWorkflow } from '../src/rights/workflow.js';

const wallet = `0x${'11'.repeat(20)}`, asset = `0x${'22'.repeat(20)}`, poolAddress = `0x${'33'.repeat(20)}`;
const hash = `0x${'44'.repeat(32)}`, block = { number: 10, hash, timestamp: 1000 };
async function flow({ state, available = 0n, drawn = 0n, fail = false }) {
  const amount = async (...args) => {
    assert.deepEqual(args, state === 12n ? [1n, asset, wallet, { blockTag: 10 }] : [1n, wallet, { blockTag: 10 }]);
    if (fail) throw Error('RPC failed'); return available;
  };
  const chain = { verify: async () => ({ control_version: 4 }), provider: { getBlock: async () => block },
    registry: { eblForAsset: async () => 1n, titles: async () => ({ documentHash: hash }), pledgedTo: async () => poolAddress, pledgeTerms: async () => hash },
    controller: { latestPoolForEbl: async () => 1n, termsHash: async () => hash, screeningValidUntil: async () => 0n, roles: async () => false },
    pool: { getAddress: async () => poolAddress, offerings: async () => ({ state, subscribed: 3n, raisedAtomic: available, settlementAsset: asset }),
      disbursedAtomic: async () => drawn, recoveredAtomic: async () => available, fundingFinalized: async () => state !== 12n,
      subscriptionDeadline: async () => 900n, investorPaid: amount, claimable: amount } };
  return materialWorkflow(chain, { wallet, roles: ['holder', 'investor'] }, { material_id: 'm', revision: 1, document_hash: hash, public_summary: { terms_hash: hash } },
    { terms_hash: hash, terms: { assetKey: hash, eblId: '1', minRaise: '8' } }, true, 2);
}

for (const [name, state, available, drawn, exit] of [
  ['cancelled empty', 12n, 0n, 0n, 'complete'], ['cancelled refundable', 12n, 2400000n, 0n, 'refund_available'],
  ['undrawn closed', 9n, 8000000n, 0n, 'claim_available'], ['repaid and claimed', 9n, 0n, 8000000n, 'complete'],
  ['loss with recovery', 14n, 4000000n, 8000000n, 'claim_available'], ['late recovery', 14n, 10n, 8000000n, 'claim_available']
]) test(`terminal workflow: ${name}`, async () => {
  const result = await flow({ state, available, drawn }), step = id => result.steps.find(item => item.id === id);
  assert.equal(result.warning, undefined);
  assert.equal(step('eligibility').status, 'not_applicable');
  assert.equal(step('draw').status, drawn ? 'complete' : 'not_applicable');
  assert.equal(step('repay').status, drawn ? 'complete' : 'not_applicable');
  assert.equal(step('repay').next, null);
  assert.equal(step('exit').status, exit); assert.equal(result.exit_available_atomic, String(available));
});
test('terminal workflow refuses to infer a zero balance from an RPC failure', async () => {
  const result = await flow({ state: 14n, fail: true });
  assert.equal(result.warning, 'workflow_chain_unavailable');
  assert.equal(result.exit_available_atomic, undefined);
  assert.equal(result.steps.find(item => item.id === 'exit').status, 'unknown');
});
