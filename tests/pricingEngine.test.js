import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  BASE_PROFIT_SHARE,
  MIN_TENOR_DAYS,
  PAYOUT_SPEEDS,
  annualRateCap,
  compareSpeeds,
  priceRwaOffering,
  quoteFromCase,
  scoreRisk,
  tenorFromCase
} from '../src/core/pricingEngine.js';
import { assertPricingQuote } from '../src/core/pricingSchema.js';

const copperCase = JSON.parse(
  await fs.readFile(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url), 'utf8')
);

// Copper-calibrated inputs reused across the pure-function tests.
const baseInput = {
  case_id: 'CASE-EBL-2026-CU-SG-SHA',
  bl_id: 'EBL-2026-CU-04417',
  requested_cash_usd: 3_300_000,
  gross_profit_usd: 1_375_000,
  cost_of_goods_usd: 5_500_000,
  invoice_value_usd: 6_875_000,
  ai_verified_collateral_value_usd: 6_531_250,
  redemption_coverage_limit: 0.9,
  risk_score_bps: 350,
  risk_level: 'MEDIUM',
  risk_factors: ['war_risk/warning', 'commodity_volatility/warning']
};

function quoteForSpeed(speed, overrides = {}) {
  return priceRwaOffering({ ...baseInput, payout_speed: speed, ...overrides });
}

// Over a two-year tenor the annual-rate cap is above the profit share, so the share alone prices the offering.
const LONG_TENOR = { tenor_days: 720 };

test('AI-2: base issue price is set by payout speed (FAST cheapest, LOW_COST dearest)', () => {
  const fast = quoteForSpeed('FAST', LONG_TENOR);
  const balanced = quoteForSpeed('BALANCED', LONG_TENOR);
  const lowCost = quoteForSpeed('LOW_COST', LONG_TENOR);

  // When the profit share binds it lands FAST at the PRD's ~0.80 headline for this case.
  assert.equal(fast.binding_constraint, 'EXPORTER_PROFIT');
  assert.equal(fast.final_issue_price_usd, 0.8);
  assert.ok(balanced.final_issue_price_usd > 0.83 && balanced.final_issue_price_usd < 0.86);
  assert.ok(lowCost.final_issue_price_usd > 0.88 && lowCost.final_issue_price_usd < 0.9);

  // Monotonic by speed (do not assert legacy fixed literals like 0.86).
  assert.ok(fast.final_issue_price_usd < balanced.final_issue_price_usd);
  assert.ok(balanced.final_issue_price_usd < lowCost.final_issue_price_usd);
});

test('AI-3: the more urgent the payout, the lower the price and the bigger the urgency discount', () => {
  const fast = quoteForSpeed('FAST');
  const balanced = quoteForSpeed('BALANCED');
  const lowCost = quoteForSpeed('LOW_COST');

  // Urgency discount grows with urgency; LOW_COST is the no-urgency anchor.
  assert.equal(lowCost.urgency_discount_bps, 0);
  assert.ok(balanced.urgency_discount_bps > 0);
  assert.ok(fast.urgency_discount_bps > balanced.urgency_discount_bps);

  // Faster payout => exporter gives up a bigger share of profit => lower price.
  assert.ok(fast.exporter_profit_share_bps > balanced.exporter_profit_share_bps);
  assert.ok(balanced.exporter_profit_share_bps > lowCost.exporter_profit_share_bps);
});

test('profit-grounded: FAST costs ~60% of margin, LOW_COST ~30% (the reasonable ratio)', () => {
  const fast = quoteForSpeed('FAST', LONG_TENOR);
  const lowCost = quoteForSpeed('LOW_COST', LONG_TENOR);

  assert.ok(Math.abs(fast.exporter_profit_share_bps - 6000) <= 50); // ~60%
  assert.ok(Math.abs(lowCost.exporter_profit_share_bps - 3000) <= 50); // ~30%

  // Financing cost must come out of profit, never exceed it, leave a positive net.
  assert.ok(fast.financing_cost_usd < fast.exporter_gross_profit_usd);
  assert.ok(fast.exporter_net_profit_usd > 0);
});

test('higher trade risk lowers the price (investors paid more to take it)', () => {
  const calm = quoteForSpeed('FAST', { risk_score_bps: 0, risk_level: 'LOW' });
  const stressed = quoteForSpeed('FAST', { risk_score_bps: 700, risk_level: 'WARNING' });

  assert.ok(stressed.final_issue_price_usd < calm.final_issue_price_usd);
  assert.ok(stressed.risk_discount_bps > calm.risk_discount_bps);
  assert.ok(stressed.risk_score_bps > calm.risk_score_bps);
});

test('AI-5: redemption exposure never exceeds safe collateral coverage', () => {
  for (const speed of PAYOUT_SPEEDS) {
    const q = quoteForSpeed(speed);
    assert.ok(q.target_redemption_exposure_usd <= q.max_safe_redemption_exposure_usd);
  }

  // When requested cash is large, the collateral floor must bind and cap supply.
  const bound = quoteForSpeed('FAST', { requested_cash_usd: 5_600_000, ...LONG_TENOR });
  assert.equal(bound.binding_constraint, 'COLLATERAL');
  assert.ok(bound.target_redemption_exposure_usd <= bound.max_safe_redemption_exposure_usd);
  assert.ok(bound.final_issue_price_usd > 0.94); // lifted by the floor

  // Cash above the entire safe exposure: still invariant-safe, and paused.
  const overdrawn = quoteForSpeed('FAST', { requested_cash_usd: 6_200_000, ...LONG_TENOR });
  assert.ok(overdrawn.target_redemption_exposure_usd <= overdrawn.max_safe_redemption_exposure_usd);
  assert.ok(overdrawn.expected_cash_to_exporter_usd < overdrawn.requested_cash_usd);
  assert.equal(overdrawn.pricing_action, 'PAUSE_OFFERING');
});

test('AI-1: every produced quote passes the PricingQuote schema validator', () => {
  for (const speed of PAYOUT_SPEEDS) {
    assert.doesNotThrow(() => assertPricingQuote(quoteForSpeed(speed)));
  }
  // From a real case file, with case cross-checking.
  for (const speed of PAYOUT_SPEEDS) {
    const q = quoteFromCase(copperCase, { payout_speed: speed });
    assert.doesNotThrow(() => assertPricingQuote(q, copperCase));
  }
});

test('AI-6: quotes carry investor and exporter explanations', () => {
  const q = quoteForSpeed('FAST');
  assert.ok(q.investor_explanation.includes('target redemption'));
  assert.ok(q.investor_explanation.includes('not guaranteed'));
  assert.ok(q.exporter_explanation.includes('profit'));
  assert.ok(q.evidence_hash.startsWith('0x'));
});

test('quoteFromCase derives the copper headline deterministically', () => {
  const fast = quoteFromCase(copperCase, { payout_speed: 'FAST' });
  assert.equal(fast.case_id, copperCase.case_id);
  assert.equal(fast.ai_verified_collateral_value_usd, 6_531_250);
  assert.equal(fast.max_safe_redemption_exposure_usd, 5_878_125);
  assert.equal(fast.risk_level, 'MEDIUM');
  assert.equal(fast.exporter_gross_profit_usd, 1_375_000);
  // 12-day voyage + 7 days for an L/C at sight is under the 30-day floor; FAST at 350 bps costs 19% a year.
  assert.equal(fast.tenor_days, 30);
  assert.equal(fast.binding_constraint, 'TENOR_RATE');
  assert.equal(fast.annual_rate_cap_bps, 1900);
  assert.equal(fast.final_issue_price_usd, 0.9846);
  assert.ok(Math.abs(fast.annualized_yield_bps - 1900) <= 10, 'the investor earns the capped rate');
});

test('the annual-rate cap prices short tenors: no more 100% upside on a 3-day voyage', () => {
  const short = quoteForSpeed('FAST', { tenor_days: 30 });
  assert.equal(short.binding_constraint, 'TENOR_RATE');
  assert.ok(short.annualized_yield_bps <= short.annual_rate_cap_bps + 10);
  assert.ok(short.final_issue_price_usd > 0.95 && short.final_issue_price_usd < 0.995);
  // A longer tenor costs more in total, so its price is lower, but the annual rate is the same.
  const longer = quoteForSpeed('FAST', { tenor_days: 90 });
  assert.ok(longer.final_issue_price_usd < short.final_issue_price_usd);
  assert.ok(Math.abs(longer.annualized_yield_bps - short.annualized_yield_bps) <= 20);
  // Faster payout and higher risk raise the annual rate.
  assert.ok(annualRateCap('FAST', 0) > annualRateCap('BALANCED', 0) && annualRateCap('BALANCED', 0) > annualRateCap('LOW_COST', 0));
  assert.ok(annualRateCap('FAST', 700) > annualRateCap('FAST', 0));
  assert.ok(quoteForSpeed('FAST', { tenor_days: 30, risk_score_bps: 700, risk_level: 'WARNING' }).final_issue_price_usd < short.final_issue_price_usd);
  // A tenor below the floor is lifted to it.
  assert.equal(quoteForSpeed('FAST', { tenor_days: 3 }).tenor_days, MIN_TENOR_DAYS);
});

test('tenorFromCase reads payment terms and voyage dates', () => {
  const at = (terms, shipped = '2026-06-01', eta = '2026-06-21') => tenorFromCase({
    bill_of_lading: { shipped_on_board: shipped, eta }, commercial_invoice: { payment_terms: terms }
  });
  assert.equal(at('Irrevocable L/C 90 days from B/L date'), 90);
  assert.equal(at('Irrevocable L/C at sight', '2026-06-01', '2026-07-20'), 49 + 7, 'voyage + presentation');
  assert.equal(at('Irrevocable L/C at sight'), MIN_TENOR_DAYS, 'short voyages use the floor');
  assert.equal(at('先货后款（验收后7个工作日内）', '2026-06-01', '2026-07-10'), 39 + 7);
  assert.equal(at('Irrevocable L/C 30 days from B/L date', '2026-06-01', '2026-07-20'), 49, 'never shorter than the voyage');
  assert.equal(tenorFromCase({}), 60, 'no dates: the default tenor');
});

test('compareSpeeds returns all three speeds plus a recommendation', () => {
  const comparison = compareSpeeds(copperCase);
  assert.equal(comparison.quotes.length, 3);
  assert.ok(PAYOUT_SPEEDS.includes(comparison.recommended_payout_speed));
  // Prices are monotonic across the comparison.
  const [fast, balanced, lowCost] = comparison.quotes;
  assert.ok(fast.final_issue_price_usd <= balanced.final_issue_price_usd);
  assert.ok(balanced.final_issue_price_usd <= lowCost.final_issue_price_usd);
});

test('scoreRisk reads macro + shipment events into bps and a level', () => {
  const risk = scoreRisk(copperCase);
  assert.equal(risk.risk_score_bps, 350); // war(200) + volatility(150), both warning
  assert.equal(risk.risk_level, 'MEDIUM');
  assert.ok(risk.risk_factors.length >= 2);
});

test('BASE_PROFIT_SHARE encodes the reasonable ratio per speed', () => {
  assert.ok(BASE_PROFIT_SHARE.FAST > BASE_PROFIT_SHARE.BALANCED);
  assert.ok(BASE_PROFIT_SHARE.BALANCED > BASE_PROFIT_SHARE.LOW_COST);
});

test('AI-7: every quote carries an evidence graph mapping discounts to evidence', () => {
  const q = quoteFromCase(copperCase, { payout_speed: 'FAST' });
  const components = q.evidence_graph.map((n) => n.component);
  assert.ok(components.includes('base_issue_price'));
  assert.ok(components.includes('urgency_discount'));
  assert.ok(components.includes('risk_discount'));
  assert.ok(components.includes('collateral_floor'));

  const risk = q.evidence_graph.find((n) => n.component === 'risk_discount');
  // risk evidence cites both the macro factors and retrieved risk intel (RAG).
  assert.ok(risk.evidence.length >= 2);
  assert.ok(risk.evidence.some((e) => e.includes('MRI-')));
});

test('BE-8: quote_hash and evidence_hash are distinct, stable 0x sha256 hashes', () => {
  const a = quoteFromCase(copperCase, { payout_speed: 'FAST' });
  const b = quoteFromCase(copperCase, { payout_speed: 'FAST' });
  for (const h of [a.quote_hash, a.evidence_hash]) {
    assert.match(h, /^0x[0-9a-f]{64}$/);
  }
  assert.notEqual(a.quote_hash, a.evidence_hash);
  // deterministic: same case -> same hashes
  assert.equal(a.quote_hash, b.quote_hash);
  assert.equal(a.evidence_hash, b.evidence_hash);
  // different terms -> different quote hash
  const slow = quoteFromCase(copperCase, { payout_speed: 'LOW_COST' });
  assert.notEqual(a.quote_hash, slow.quote_hash);
});

test('AI-4/AI-8: document inconsistency raises the risk discount and lowers the price', () => {
  const clean = quoteFromCase(copperCase, { payout_speed: 'FAST' });
  const tampered = structuredClone(copperCase);
  tampered.commercial_invoice.quantity_mt = 600; // eBL/cargo say 500 -> doc mismatch, collateral unchanged
  const dirty = quoteFromCase(tampered, { payout_speed: 'FAST' });
  assert.ok(dirty.risk_score_bps > clean.risk_score_bps);
  assert.equal(dirty.ai_verified_collateral_value_usd, clean.ai_verified_collateral_value_usd); // collateral floor unaffected
  assert.ok(dirty.final_issue_price_usd < clean.final_issue_price_usd);
});
