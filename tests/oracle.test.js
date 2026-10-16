import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { toChainPricingArgs, toOracleUpdate } from '../src/core/oracle.js';
import { PRICING_ACTION_TO_UINT8, RISK_LEVEL_TO_UINT8 } from '../src/core/contractHarness.js';
import { loadCuratedCase } from '../src/core/curatedCases.js';

// BE-8: the quote must serialise into the exact payload the on-chain
// RiskPricingOracle / RWAOfferingPool need, carrying both anchoring hashes.

const copperCase = JSON.parse(
  await fs.readFile(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url), 'utf8')
);
// The Hormuz-transit aluminium case with the offline real-data snapshot attached: CRITICAL, paused.
const warCase = await loadCuratedCase(new URL('../data/cases/alu-dxb-rtm.case.json', import.meta.url));

test('BE-8: toOracleUpdate maps an opening quote to the oracle payload', () => {
  const quote = quoteFromCase(copperCase, { payout_speed: 'FAST' });
  const update = toOracleUpdate(quote, { pool_id: 'POOL-1' });

  assert.equal(update.pool_id, 'POOL-1');
  assert.equal(update.case_id, quote.case_id);
  assert.equal(update.bl_id, quote.bl_id);
  // RiskPricingOracle.updatePricing(poolId, issuePrice, riskLevel, action, evidenceHash)
  assert.equal(update.issue_price_usd, quote.final_issue_price_usd);
  assert.equal(update.risk_level, quote.risk_level);
  assert.equal(update.pricing_action, 'OPEN_OFFERING');
  assert.equal(update.offering_state, 'Open');
  // RWAOfferingPool.createOffering(eblId, tokenSupply, issuePrice, targetRedemptionValue)
  assert.equal(update.recommended_token_supply, quote.recommended_token_supply);
  assert.equal(update.target_redemption_value_usd, 1);

  // Both anchoring hashes are present, valid and distinct.
  assert.match(update.evidence_hash, /^0x[0-9a-f]{64}$/);
  assert.match(update.quote_hash, /^0x[0-9a-f]{64}$/);
  assert.notEqual(update.evidence_hash, update.quote_hash);
});

test('BE-8: a paused war-crisis quote maps to the Paused offering state', () => {
  const update = toOracleUpdate(quoteFromCase(warCase, { payout_speed: 'FAST' }));
  assert.equal(update.pricing_action, 'PAUSE_OFFERING');
  assert.equal(update.offering_state, 'Paused');
  assert.equal(update.pool_id, null);
});

// WP0.2: one encoder for RiskPricingOracle.updatePricing, shared by the MCP tool and the Agent.

test('WP0.2: toChainPricingArgs encodes a quote exactly as updatePricing expects it', () => {
  const quote = quoteFromCase(copperCase, { payout_speed: 'FAST' });
  const args = toChainPricingArgs(quote, { pool_id: 2 });
  assert.equal(args.pool_id, 2);
  assert.equal(args.issue_price_e6, Math.round(quote.final_issue_price_usd * 1_000_000));
  assert.equal(args.risk_level, RISK_LEVEL_TO_UINT8[quote.risk_level]);
  assert.equal(args.pricing_action, PRICING_ACTION_TO_UINT8[quote.pricing_action]);
  assert.equal(args.evidence_hash, quote.evidence_hash);
  assert.equal(args.quote_hash, quote.quote_hash);
});

test('WP0.2: toChainPricingArgs covers every action updatePricing accepts, including RESUME_OFFERING', () => {
  const base = quoteFromCase(copperCase, { payout_speed: 'FAST' });
  const expected = {
    OPEN_OFFERING: 0, OPEN_WITH_WARNING: 1, REPRICE_DOWN: 2, PAUSE_OFFERING: 3,
    FREEZE_POOL: 4, TRIGGER_LIQUIDATION: 5, RESUME_OFFERING: 6
  };
  for (const [name, code] of Object.entries(expected)) {
    assert.equal(toChainPricingArgs({ ...base, pricing_action: name }, { pool_id: 1 }).pricing_action, code, name);
  }
  for (const level of ['LOW', 'MEDIUM', 'WARNING', 'CRITICAL']) {
    assert.equal(toChainPricingArgs({ ...base, risk_level: level }, { pool_id: 1 }).risk_level, RISK_LEVEL_TO_UINT8[level]);
  }
});

test('WP0.2: toChainPricingArgs refuses unknown actions and levels instead of defaulting them', () => {
  const base = quoteFromCase(copperCase, { payout_speed: 'FAST' });
  const bad = (patch, opts = { pool_id: 1 }) => () => toChainPricingArgs({ ...base, ...patch }, opts);
  assert.throws(bad({ risk_level: 'HIGH' }), /unknown risk_level: HIGH/u);
  assert.throws(bad({ risk_level: undefined }), /unknown risk_level/u);
  assert.throws(bad({ pricing_action: 'SETTLE_OFFERING' }), /unsupported pricing_action/u);
  assert.throws(bad({ pricing_action: 'DO_SOMETHING' }), /unsupported pricing_action/u);
  assert.throws(bad({ final_issue_price_usd: 0 }), /positive number/u);
  assert.throws(bad({ final_issue_price_usd: 'abc' }), /positive number/u);
  assert.throws(bad({ evidence_hash: '0x12' }), /evidence_hash/u);
  assert.throws(bad({}, { pool_id: 0 }), /pool_id/u);
  assert.throws(bad({}, { pool_id: 'two' }), /pool_id/u);
  assert.throws(() => toChainPricingArgs(null, { pool_id: 1 }), /quote is required/u);
});
