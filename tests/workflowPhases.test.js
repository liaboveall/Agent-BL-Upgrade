// Assessment 2026-11-04 F05: a step is a task only when its roles can act on it now. Each running-pool condition the
// contracts check (docs/contracts.md, freeze matrix) is named as the step's blocker instead of every unfinished step
// reading "pending". The fixture chain answers the same views RightsChainService reads; the local-EVM version of the
// frozen case is in tests/rightsRecovery.integration.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { id } from 'ethers';
import { materialWorkflow } from '../src/rights/workflow.js';
import { SCREENING_ATTESTOR_SLOT } from '../src/rights/screening.js';
import { CONTROL_VERSION } from '../src/rights/typedData.js';

const STATE = { Open: 2n, Subscribed: 3n, Funded: 4n, InTransit: 5n, Paused: 7n, Frozen: 8n, Defaulted: 13n };
const hash = `0x${'44'.repeat(32)}`, pool = `0x${'33'.repeat(20)}`, controller = `0x${'c0'.repeat(20)}`, signer = `0x${'5e'.repeat(20)}`;
const pack = { terms_hash: hash, terms: { assetKey: hash, eblId: '1', minRaise: '8000000', supply: '10', subscribeUntil: '1500', disburseUntil: '2000', maturity: '3000' } };
const record = { material_id: 'm', revision: 1, document_hash: hash, public_summary: { terms_hash: hash } };

/** A running pool at block time `now`: subscriptions close at `deadline`, the draw window at 2000 and maturity at 3000. */
function chain({ now = 1000, state = 'Open', subscribed = 3n, raised = 2400000n, finalized = false, drawn = 0n, deadline = 1500n, screening = 5000n,
  intakeStopped = false, valuationUntil = 5000n, outstanding = null } = {}) {
  return { verify: async () => ({ control_version: CONTROL_VERSION }),
    provider: { getBlock: async () => ({ number: 10, hash, timestamp: now }),
      getStorage: async (address, slot) => { assert.equal(slot, SCREENING_ATTESTOR_SLOT[CONTROL_VERSION]); return `0x${'00'.repeat(12)}${signer.slice(2)}`; } },
    registry: { eblForAsset: async () => 1n, titles: async () => ({ documentHash: hash }), pledgedTo: async () => pool, pledgeTerms: async () => hash },
    controller: { getAddress: async () => controller, latestPoolForEbl: async () => 1n, termsHash: async () => hash, screeningValidUntil: async () => screening,
      roles: async (role, account) => role === id('COMPLIANCE') && account.toLowerCase() === signer, intakeStopped: async () => intakeStopped,
      valuations: async () => ({ validUntil: valuationUntil }) },
    pool: { getAddress: async () => pool, offerings: async () => ({ state: STATE[state], subscribed, tokenSupply: 10n, minRaise: 8000000n, raisedAtomic: raised, settlementAsset: pool }),
      disbursedAtomic: async () => drawn, recoveredAtomic: async () => 0n, fundingFinalized: async () => finalized, subscriptionDeadline: async () => deadline,
      ...(outstanding == null ? {} : { outstandingDebt: async () => outstanding }) } };
}
const run = async (options, roles = ['operator', 'investor', 'compliance', 'holder']) => {
  const result = await materialWorkflow(chain(options), { wallet: `0x${'aa'.repeat(20)}`, roles }, record, pack, true, 2);
  assert.equal(result.warning, undefined, JSON.stringify(result.warning));
  return Object.fromEntries(result.steps.map((step) => [step.id, step]));
};
const shape = (step) => [step.phase, step.blocker ?? null, step.next ?? null];

test('an open raise: investors can subscribe, and the draw and repayment wait for it', async () => {
  const steps = await run({});
  assert.deepEqual(shape(steps.fund), ['actionable', null, 'acknowledge_terms']);
  assert.deepEqual(shape(steps.eligibility), ['actionable', null, 'set_eligibility']);
  assert.deepEqual(shape(steps.draw), ['waiting', 'funding_not_finalized', 'disburse']);
  assert.deepEqual(shape(steps.repay), ['waiting', 'not_disbursed', 'repay']);
  assert.deepEqual(shape(steps.exit), ['waiting', null, 'claim']);
});

test('instance-wide conditions block new subscriptions with their own reason', async () => {
  assert.deepEqual(shape((await run({ intakeStopped: true })).fund), ['blocked', 'intake_stopped', 'acknowledge_terms']);
  const lapsed = await run({ screening: 500n });
  assert.deepEqual(shape(lapsed.fund), ['blocked', 'screening_expired', 'acknowledge_terms']);
  assert.deepEqual(shape(lapsed.eligibility), ['actionable', 'screening_expired', 'set_eligibility'], 'refreshing it is the compliance task');
  assert.deepEqual(shape((await run({ valuationUntil: 500n })).fund), ['blocked', 'valuation_expired', 'acknowledge_terms']);
});

test('after the deadline: a raise below its minimum is refunded, one above it must be finalized first', async () => {
  const failed = await run({ state: 'Subscribed', deadline: 900n });
  assert.deepEqual(shape(failed.fund), ['not_applicable', 'minimum_not_reached', null]);
  assert.deepEqual([failed.draw.phase, failed.repay.phase], ['not_applicable', 'not_applicable']);
  assert.deepEqual([failed.exit.phase, failed.exit.status, failed.exit.next], ['actionable', 'refund_available', 'refund']);
  const met = await run({ state: 'Subscribed', deadline: 900n, raised: 8000000n, subscribed: 10n });
  assert.deepEqual([met.fund.phase, met.fund.status, met.fund.next, met.fund.assigned_to_you], ['actionable', 'finalize_required', 'finalize_funding', true]);
  assert.deepEqual(shape(met.draw), ['waiting', 'funding_not_finalized', 'disburse']);
});

test('paused and frozen pools say so instead of offering the draw', async () => {
  const paused = await run({ state: 'Paused' });
  assert.deepEqual(shape(paused.fund), ['blocked', 'state_paused', 'acknowledge_terms']);
  const funded = await run({ state: 'Funded', finalized: true, raised: 8000000n, subscribed: 10n });
  assert.deepEqual(shape(funded.draw), ['actionable', null, 'disburse']);
  const [frozen, result] = await (async () => { const value = await materialWorkflow(chain({ state: 'Frozen', finalized: true, raised: 8000000n, subscribed: 10n }),
    { wallet: `0x${'aa'.repeat(20)}`, roles: ['operator'] }, record, pack, true, 2); return [Object.fromEntries(value.steps.map((step) => [step.id, step])), value]; })();
  assert.equal(result.state_notice, 'state_frozen');
  assert.deepEqual(shape(frozen.draw), ['blocked', 'state_frozen', 'disburse']);
  assert.deepEqual(shape(frozen.repay), ['waiting', 'not_disbursed', 'repay']);
  assert.deepEqual(result.steps.filter((step) => step.assigned_to_you && step.phase === 'actionable').map((step) => step.id), []);
  // The freeze does not hold back undrawn principal past the draw deadline (the matrix's one exception).
  const late = await run({ now: 2500, state: 'Frozen', finalized: true, raised: 8000000n, subscribed: 10n });
  assert.deepEqual(shape(late.draw), ['blocked', 'draw_deadline_passed', null]);
  assert.deepEqual([late.repay.phase, late.exit.phase, late.exit.next, late.exit.assigned_to_you], ['not_applicable', 'actionable', 'start_exit', true]);
});

test('an offering nobody subscribed is exited by anyone, or by the operator while it is frozen', async () => {
  const empty = await run({ subscribed: 0n, raised: 0n, deadline: 900n });
  assert.deepEqual(shape(empty.fund), ['not_applicable', 'no_subscribers', null]);
  assert.deepEqual([empty.exit.phase, empty.exit.next, empty.exit.roles.includes('holder')], ['actionable', 'start_exit', true]);
  const frozen = await run({ state: 'Frozen', subscribed: 0n, raised: 0n, deadline: 900n });
  assert.deepEqual([frozen.exit.phase, frozen.exit.next, frozen.exit.roles], ['actionable', 'cancel_offering', ['operator', 'custodian']]);
});

test('after a draw: repayment is the task; at maturity the exit starts, except a frozen pool with nothing owed', async () => {
  const drawn = await run({ state: 'InTransit', finalized: true, raised: 8000000n, subscribed: 10n, drawn: 8000000n });
  assert.deepEqual([drawn.draw.phase, drawn.repay.phase, drawn.exit.phase], ['complete', 'actionable', 'waiting']);
  const matured = await run({ now: 3500, state: 'InTransit', finalized: true, raised: 8000000n, subscribed: 10n, drawn: 8000000n, outstanding: 2000000n });
  assert.deepEqual([matured.exit.phase, matured.exit.next], ['actionable', 'start_exit']);
  const covered = await run({ now: 3500, state: 'Frozen', finalized: true, raised: 8000000n, subscribed: 10n, drawn: 8000000n, outstanding: 0n });
  assert.deepEqual(shape(covered.exit), ['blocked', 'state_frozen', 'claim']);
  const unread = await run({ now: 3500, state: 'Frozen', finalized: true, raised: 8000000n, subscribed: 10n, drawn: 8000000n });
  assert.equal(unread.exit.phase, 'unknown', 'a debt that cannot be read is not guessed');
  const defaulted = await run({ now: 3500, state: 'Defaulted', finalized: true, raised: 8000000n, subscribed: 10n, drawn: 8000000n });
  assert.deepEqual([defaulted.repay.phase, defaulted.repay.status, defaulted.exit.phase, defaulted.exit.blocker], ['actionable', 'resolution', 'waiting', 'resolution_pending']);
});

test('before issuance each step waits for the one it needs', async () => {
  const unpledged = { ...chain(), registry: { eblForAsset: async () => 0n } };
  const result = await materialWorkflow(unpledged, { wallet: `0x${'aa'.repeat(20)}`, roles: ['holder'] }, record, pack, true, 2);
  const steps = Object.fromEntries(result.steps.map((step) => [step.id, step]));
  assert.deepEqual([steps.title.phase, steps.consent.phase, steps.consent.blocker, steps.issue.blocker, steps.fund.blocker], ['actionable', 'waiting', 'title_not_registered', 'pledge_missing', 'not_issued']);
  const missing = await materialWorkflow(null, { wallet: `0x${'aa'.repeat(20)}`, roles: ['issuer'] }, record, null, false, 0);
  assert.deepEqual([missing.warning, missing.steps[2].phase], ['rights_chain_not_configured', 'actionable']);
});
