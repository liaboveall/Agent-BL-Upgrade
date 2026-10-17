// Uses real planning functions with synthetic provider receipts, without keys or network calls.
import assert from 'node:assert/strict';
import { ZeroHash } from 'ethers';
import { quoteFromCase } from '../../../src/core/pricingEngine.js';
import { buildOpeningPlan } from '../../../src/agent/runtime/openingPlan.js';
import { planTransition } from '../../../src/agent/runtime/poolRules.js';
import { buildSettlementPlan, verifyUsdcTransfer } from '../../../src/agent/pipelines/settlementPipeline.js';
import { openingChain } from '../../../tests/helpers/opening.js';
import { settlementChain, oil, chainConfig, RECIPIENT, PAYER, paymentHash } from '../../../tests/helpers/settlement.js';

const observations = [];
for (const action of ['RECORD_PAYMENT', 'RECORD_ARRIVAL']) {
  const result = planTransition(action, { state: 'Defaulted', subscribed: '100', paymentProof: false, arrivalProof: false });
  assert.equal(result.ok, false);
  observations.push({ name: `defaulted-${action.toLowerCase()}`, confirmed: true, ...result });
}

// Two genuine-looking synthetic USDC receipts sum to the recorded debt; neither single receipt equals the sum.
const chain = settlementChain();
chain.payment({ amount: 400_000n });
const secondHash = `0x${'cb'.repeat(32)}`;
chain.payment({ txHash: secondHash, amount: 600_000n });
const evidence = await verifyUsdcTransfer({ provider: chain.context.provider, chainConfig, recipient: RECIPIENT,
  expectedPayer: PAYER, txHash: paymentHash, amountAtomic: '400000' });
const pool = chain.pools.get(11);
Object.assign(pool, { state: 5, subscribed: 1n, targetRedemptionValue: 1_000_000n,
  paymentProof: paymentHash, arrivalProof: `0x${'da'.repeat(32)}`, repaymentAmount: 1_000_000n });
const params = { payment_proof: paymentHash, arrival_proof: pool.arrivalProof, repayment_amount: '1',
  repayment_amount_atomic: '1000000', payment_verification: evidence };
let rejected = null;
try {
  await buildSettlementPlan({ action: 'SETTLE', chain_pool_id: 11, params, chainConfig, context: chain.context,
    recipient: RECIPIENT, expectedPayer: PAYER });
} catch (error) { rejected = error.code; }
assert.equal(rejected, 'payment_transfer_mismatch');
observations.push({ name: 'multiple-recoveries-cannot-use-single-receipt-settlement-plan', confirmed: true,
  synthetic_receipt_amounts: ['400000', '600000'], recorded_total: '1000000', rejected });

const quote = quoteFromCase(oil);
const opening = await buildOpeningPlan({ params: { case_data: oil, quote, compliance: { status: 'CLEAR' }, documents: [] },
  chainConfig, context: openingChain().context });
assert.notEqual(quote.tenor_days, 60);
assert.deepEqual(opening.steps.map((step) => step.method), ['mintEBLV2', 'pledge', 'createOffering']);
assert.equal(opening.steps[2].args.length, 4);
observations.push({ name: 'quote-tenor-is-not-carried-into-opening-transaction', confirmed: true,
  case_id: oil.case_id, quote_tenor_days: quote.tenor_days, methods: opening.steps.map((step) => step.method),
  create_args_count: opening.steps[2].args.length, maturity_step: false,
  note: 'Contract probe independently confirms a fixed 60-day default; this planning probe uses a synthetic provider.' });

// The failure above is about aggregate evidence, not missing arrival proof.
assert.notEqual(pool.arrivalProof, ZeroHash);
console.log(JSON.stringify({ schema: 'agentbl-review-cross-layer-probes-v1', evidence: 'real JS functions plus synthetic provider fixtures', observations }, null, 2));
