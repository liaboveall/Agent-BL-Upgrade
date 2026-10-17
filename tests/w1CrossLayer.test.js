// W1 cross-layer regressions: the on-chain rules, the JS transition table, the owner plan,
// settlement entry verification and the documented ABI must describe the same lifecycle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ZeroHash } from 'ethers';
import { planTransition } from '../src/agent/runtime/poolRules.js';
import { buildOwnerPlan } from '../src/agent/runtime/ownerTxPlan.js';
import { buildSettlementPlan, verifyUsdcTransfer } from '../src/agent/pipelines/settlementPipeline.js';
import { protocolAbi } from '../src/chain/protocolV4Abi.js';
import { subscriptionAvailability } from '../src/core/subscription.js';
import { settlementChain, chainConfig, RECIPIENT, PAYER } from './helpers/settlement.js';

const ROOT = path.join(import.meta.dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

async function evidenceFor(chain, txHash, amountAtomic) {
  chain.payment({ txHash, amount: BigInt(amountAtomic) });
  return verifyUsdcTransfer({ provider: chain.context.provider, chainConfig, recipient: RECIPIENT,
    expectedPayer: PAYER, txHash, amountAtomic, confirmations: 2 });
}

function chainWithPool(overrides = {}) {
  const chain = settlementChain();
  const pool = chain.pools.get(11);
  Object.assign(pool, { subscribed: 1n, repaymentAmount: 0n, paymentProof: ZeroHash, arrivalProof: ZeroHash }, overrides);
  return chain;
}

test('A03: Defaulted and Frozen remain settleable, and the owner plan exposes default/loss/liquidation exits', async () => {
  for (const state of ['Defaulted', 'Frozen']) {
    assert.equal(planTransition('RECORD_PAYMENT', { state, subscribed: 1, paymentProof: false }).ok, true);
    assert.equal(planTransition('RECORD_ARRIVAL', { state, subscribed: 1, arrivalProof: false }).ok, true);
    assert.equal(planTransition('RECORD_ADDITIONAL_PAYMENT', { state, subscribed: 1, paymentProof: true }).ok, true);
  }
  assert.equal(planTransition('MARK_DEFAULT', { state: 'Frozen', subscribed: 1, overdue: true }).to, 'Defaulted');
  assert.equal(planTransition('MARK_DEFAULT', { state: 'Frozen', subscribed: 1, overdue: false }).code, 'not_overdue');
  assert.equal(planTransition('SETTLE_LOSS', { state: 'Defaulted', subscribed: 1 }).to, 'LossSettled');
  assert.equal(planTransition('UNFREEZE', { state: 'Frozen', subscribed: 1 }).to, 'Open');
  assert.equal(planTransition('CANCEL', { state: 'Frozen', subscribed: 0 }).to, 'Cancelled');
  assert.equal(planTransition('CANCEL', { state: 'Liquidation', subscribed: 0 }).to, 'Cancelled');

  const chain = chainWithPool({ state: 3 });
  chain.context.pool.maturityAt = async () => 1_000n;
  const common = { chainConfig, context: chain.context };
  const markDefault = await buildOwnerPlan({ action: 'MARK_DEFAULT', chain_pool_id: 11, params: {}, ...common });
  assert.equal(markDefault.steps[0].method, 'markDefault');

  chain.pools.get(11).state = 13;
  const loss = await buildOwnerPlan({ action: 'SETTLE_LOSS', chain_pool_id: 11, params: { resolution_hash: 'approved-loss' }, ...common });
  assert.equal(loss.steps[0].method, 'settleLoss');

  Object.assign(chain.pools.get(11), { state: 11, subscribed: 10n, targetRedemptionValue: 1_000_000n, repaymentAmount: 4_000_000n });
  const liquidation = await buildOwnerPlan({ action: 'RESOLVE_LIQUIDATION', chain_pool_id: 11, params: { resolution_hash: 'sale-result' }, ...common });
  assert.equal(liquidation.steps[0].method, 'resolveLiquidation');

  Object.assign(chain.pools.get(11), { state: 8 });
  const unfreeze = await buildOwnerPlan({ action: 'UNFREEZE', chain_pool_id: 11, params: { evidence_hash: 'risk-cleared' }, ...common });
  assert.equal(unfreeze.steps[0].method, 'unfreezeOffering');

  // The standard settlement path can record a late payment on a Defaulted offering.
  Object.assign(chain.pools.get(11), { state: 13, subscribed: 1n, repaymentAmount: 0n, paymentProof: ZeroHash, arrivalProof: ZeroHash });
  const tx = `0x${'a1'.repeat(32)}`;
  const payment = await evidenceFor(chain, tx, '400000');
  const late = await buildSettlementPlan({ action: 'RECORD_PAYMENT', chain_pool_id: 11, chainConfig, context: chain.context,
    recipient: RECIPIENT, expectedPayer: PAYER, confirmations: 2,
    params: { payment_proof: tx, repayment_amount: '0.4', repayment_amount_atomic: '400000', payment_verification: payment } });
  assert.equal(late.steps[0].method, 'recordImporterPayment');

  // A late full recovery can still settle through the standard plan while Defaulted.
  const arrival = `0x${'aa'.repeat(32)}`;
  const fullTx = `0x${'a9'.repeat(32)}`;
  const full = await evidenceFor(chain, fullTx, '1000000');
  Object.assign(chain.pools.get(11), { state: 13, repaymentAmount: 1_000_000n, paymentProof: fullTx, arrivalProof: arrival });
  const settled = await buildSettlementPlan({ action: 'SETTLE', chain_pool_id: 11, chainConfig, context: chain.context,
    recipient: RECIPIENT, expectedPayer: PAYER, confirmations: 2,
    params: { arrival_proof: arrival, recoveries: [{ payment_proof: fullTx, repayment_amount_atomic: '1000000', payment_verification: full }] } });
  assert.equal(settled.steps[0].method, 'settle');
  assert.deepEqual(settled.steps[0].args, ['11', '1000000']);
});

test('A04: multi-entry recovery is verified entry by entry and must equal the on-chain total', async () => {
  const chain = chainWithPool({ state: 5, repaymentAmount: 1_000_000n, paymentProof: `0x${'a1'.repeat(32)}`,
    arrivalProof: `0x${'aa'.repeat(32)}` });
  const first = `0x${'a1'.repeat(32)}`, second = `0x${'a2'.repeat(32)}`, third = `0x${'a3'.repeat(32)}`;
  const firstEvidence = await evidenceFor(chain, first, '400000');
  const secondEvidence = await evidenceFor(chain, second, '600000');
  const thirdEvidence = await evidenceFor(chain, third, '400000');
  const build = (entries) => buildSettlementPlan({ action: 'SETTLE', chain_pool_id: 11, chainConfig, context: chain.context,
    recipient: RECIPIENT, expectedPayer: PAYER, confirmations: 2,
    params: { arrival_proof: `0x${'aa'.repeat(32)}`, recoveries: entries } });
  const entry = (tx, amount, verification) => ({ payment_proof: tx, repayment_amount_atomic: amount, payment_verification: verification });

  const plan = await build([entry(first, '400000', firstEvidence), entry(second, '600000', secondEvidence)]);
  assert.equal(plan.steps[0].method, 'settle');
  assert.deepEqual(plan.steps[0].args, ['11', '1000000']);
  assert.equal(plan.recoveries.length, 2);

  await assert.rejects(build([entry(first, '400000', firstEvidence), entry(first, '400000', firstEvidence)]), { code: 'duplicate_recovery_entry' });
  await assert.rejects(build([entry(first, '400000', firstEvidence)]), { code: 'settlement_total_mismatch' });
  await assert.rejects(build([entry(second, '600000', secondEvidence), entry(third, '400000', thirdEvidence)]), { code: 'settlement_primary_missing' });
});

test('A10: source, merged ABI and documentation describe the same v4 events and terms', () => {
  const poolSource = read('hardhat', 'contracts', 'RWAOfferingPool.sol');
  const oracleSource = read('hardhat', 'contracts', 'RiskPricingOracle.sol');
  const docs = read('docs', 'contracts.md');
  assert.match(poolSource, /uint256 public constant protocolVersion = 4;/u);
  assert.match(poolSource, /emit OfferingFrozen\(poolId, evidenceHash\)/u);
  assert.match(poolSource, /emit OfferingTermsSet\(/u);
  assert.match(oracleSource, /event PricingDecision\(/u);
  assert.match(oracleSource, /require\(expectedQuoteVersion == currentVersion/u);

  const poolAbi = protocolAbi('RWAOfferingPool', []);
  for (const fragment of ['event OfferingFrozen', 'event OfferingTermsSet', 'function createOfferingWithTerms',
    'function subscribeWithTerms', 'function resolveLiquidation', 'event AdditionalPaymentRecorded']) {
    assert.ok(poolAbi.some((entry) => entry.startsWith(fragment)), `merged ABI is missing ${fragment}`);
  }
  const oracleAbi = protocolAbi('RiskPricingOracle', []);
  assert.ok(oracleAbi.some((entry) => entry.includes('function updatePricing(uint256,uint256,uint8,uint8,bytes32,bytes32,uint256,uint256,uint256)')));

  for (const needle of ['createOfferingWithTerms', 'OfferingFrozen', 'resolveLiquidation', 'expectedQuoteVersion',
    'AdditionalPaymentRecorded', 'subscriptionDeadline']) {
    assert.ok(docs.includes(needle), `docs/contracts.md is missing ${needle}`);
  }
});

test('A06: the shared subscription predicate disables a closed on-chain deadline', () => {
  const base = { status: 'Open', quote: { final_issue_price_usd: 0.8 }, tokenSupply: 100, subscribedShares: 10,
    investorEligible: true, chainSnapshot: { subscription_deadline: Math.floor(Date.now() / 1000) - 1 } };
  assert.equal(subscriptionAvailability(base).subscription_disabled_reason, 'subscription_closed');
  assert.equal(subscriptionAvailability({ ...base, chainSnapshot: { subscription_deadline: Math.floor(Date.now() / 1000) + 60 } })
    .subscription_disabled_reason, null);
});
