// F05 (comprehensive review 2026-10-29, v4): the controller's isEligible() and disburse() also need the wallet that last
// refreshed the instance-wide screening to hold COMPLIANCE now. The catalog (tests/n3Reads.test.js), the role workflow
// and the operations monitor read that wallet the same way; the slot is checked against a deployment in
// tests/w3CrossLayer.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, id } from 'ethers';
import { SCREENING_ATTESTOR_SLOT, readScreening } from '../src/rights/screening.js';
import { materialWorkflow } from '../src/rights/workflow.js';
import { RpcReadPool } from '../src/rights/reads.js';
import { CONTROL_VERSION } from '../src/rights/typedData.js';

const CONTROLLER = `0x${'c0'.repeat(20)}`, SIGNER = `0x${'5e'.repeat(20)}`, COMPLIANCE = id('COMPLIANCE');
const word = (address) => `0x${'00'.repeat(12)}${address.slice(2)}`;

function chainWith({ signer = SIGNER, active = true, validUntil = 2_000, storage = true } = {}) {
  return { provider: { getBlock: async () => ({ number: 9, hash: `0x${'ab'.repeat(32)}`, timestamp: 1_000 }),
    ...(storage ? { getStorage: async (address, slot) => { assert.deepEqual([address, slot], [CONTROLLER, SCREENING_ATTESTOR_SLOT[CONTROL_VERSION]]); return word(signer); } } : {}) },
  controller: { getAddress: async () => CONTROLLER, screeningValidUntil: async () => BigInt(validUntil),
    roles: async (role, account) => role === COMPLIANCE && account?.toLowerCase() === SIGNER && active } };
}

test('F05 the screening read reports its window, its signer and whether that signer still holds COMPLIANCE', async () => {
  assert.deepEqual(await readScreening(chainWith(), CONTROL_VERSION), { valid_until: '2000', attestor: getAddress(SIGNER), attestor_active: true });
  assert.equal((await readScreening(chainWith({ active: false }), CONTROL_VERSION)).attestor_active, false);
  // Never refreshed: no source, and the zero expiry already closes everything.
  assert.equal((await readScreening(chainWith({ signer: `0x${'0'.repeat(40)}`, validUntil: 0 }), CONTROL_VERSION)).attestor_active, false);
  // A version without a known slot, or a provider that cannot read storage, is unknown rather than valid.
  assert.equal((await readScreening(chainWith(), 3)).attestor_active, null);
  assert.equal((await readScreening(chainWith({ storage: false }), CONTROL_VERSION)).attestor_active, null);
  const failing = chainWith(); failing.provider.getStorage = async () => { throw new Error('rpc down'); };
  assert.deepEqual(await readScreening(failing, CONTROL_VERSION), { valid_until: '2000', attestor: null, attestor_active: null });
});

test('F05 the role workflow names a revoked screening signer instead of reporting eligibility as checkable', async () => {
  const pack = { terms_hash: `0x${'77'.repeat(32)}`, terms: { assetKey: `0x${'88'.repeat(32)}`, eblId: '4', minRaise: '8000000' } };
  const record = { material_id: 'm', revision: 1, document_hash: `0x${'99'.repeat(32)}`, public_summary: { terms_hash: pack.terms_hash } };
  const workflowWith = async (options) => {
    const chain = chainWith(options);
    Object.assign(chain, { verify: async () => ({ control_version: CONTROL_VERSION }),
      registry: { eblForAsset: async () => 4n, titles: async () => ({ documentHash: record.document_hash }), pledgedTo: async () => `0x${'22'.repeat(20)}`,
        pledgeTerms: async () => pack.terms_hash },
      pool: { getAddress: async () => `0x${'22'.repeat(20)}`, offerings: async () => ({ state: 2n, subscribed: 0n, raisedAtomic: 0n }), disbursedAtomic: async () => 0n,
        recoveredAtomic: async () => 0n, fundingFinalized: async () => false, subscriptionDeadline: async () => 5_000n } });
    Object.assign(chain.controller, { latestPoolForEbl: async () => 1n, termsHash: async () => pack.terms_hash });
    chain.provider.getBlock = async () => ({ number: 9, hash: `0x${'ab'.repeat(32)}`, timestamp: 1_000 });
    return materialWorkflow(chain, { roles: ['compliance'], wallet: `0x${'aa'.repeat(20)}` }, record, pack, true, 2, new RpcReadPool());
  };
  const eligibility = (result) => result.steps.find((step) => step.id === 'eligibility');
  assert.deepEqual([eligibility(await workflowWith()).status, eligibility(await workflowWith()).blocker], ['check_each_investor', undefined]);
  const revoked = eligibility(await workflowWith({ active: false }));
  assert.deepEqual([revoked.status, revoked.blocker], ['pending', 'screening_source_inactive']);
  assert.deepEqual([eligibility(await workflowWith({ validUntil: 10 })).status, eligibility(await workflowWith({ validUntil: 10 })).blocker], ['pending', undefined]);
  assert.equal(eligibility(await workflowWith({ storage: false })).status, 'unknown');
});
