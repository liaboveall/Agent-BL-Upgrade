import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { assessMarketEvidence, actualFinancingPeriod, CALIBRATION } from '../src/provenance/market.js';
import { evaluateProviderCorpus } from '../src/provenance/evaluation.js';
import { hashSnapshot } from '../src/agent/decisionLogger.js';
import { quoteFromCase } from '../src/core/pricingEngine.js';
import { parseSdnExport, screenPrimaryName } from '../src/provenance/screening.js';

const now = Date.parse('2026-10-17T00:00:00.000Z');
const basis = { grade: 'Grade 1 cathode', region: 'COMEX delivery', currency: 'USD', unit: 'USD/MT', instrument: 'futures_reference',
  calendar_version: 'test-calendar-1', basis_source: 'research-scenario', liquidation_cost_bps: 500, insurance_deduction_bps: 100 };
const input = { market: { benchmark_key: 'copper', valuation_basis: basis } };
const quote = { key: 'copper', price_usd_per_mt: 10000, quoted_unit: 'USD/lb', observed_at: '2026-10-16T20:00:00.000Z', status: 'live', change_1m: 0.01 };
const options = { now, calendar: { version: basis.calendar_version, state: 'open' } };

test('W4 market rejects missing/stale/conflicting/closed/extreme/unit/grade/region data without a false clear', () => {
  const healthy = assessMarketEvidence(input, quote, options);
  assert.equal(healthy.applicability, 'REFERENCE_ONLY'); assert.equal(healthy.net_reference_price, 9400);
  assert.equal(healthy.independent_valuation_verified, false); assert.equal(healthy.review_required, true);
  const scenarios = [
    [null, options, 'MISSING_SOURCE'], [{ ...quote, price_usd_per_mt: null }, options, 'INVALID_PRICE'],
    [{ ...quote, observed_at: '2026-09-01T00:00:00.000Z' }, options, 'STALE_SOURCE'],
    [quote, { ...options, calendar: { version: basis.calendar_version, state: 'closed' } }, 'MARKET_CALENDAR_REVIEW'],
    [{ ...quote, change_1m: 0.4 }, options, 'EXTREME_VOLATILITY'],
    [quote, { ...options, alternatives: [{ ...quote, price_usd_per_mt: 13000 }] }, 'SOURCE_CONFLICT'],
    [{ ...quote, change_1m: null }, options, 'MISSING_VOLATILITY']
  ];
  for (const [value, opt, reason] of scenarios) {
    const result = assessMarketEvidence(input, value, opt); assert.equal(result.applicability, 'REVIEW', reason);
    assert.ok(result.reasons.includes(reason), reason); assert.equal(result.net_reference_price, null);
  }
  const incomplete = assessMarketEvidence({ market: { benchmark_key: 'copper' } }, quote, options);
  for (const field of ['GRADE', 'REGION', 'CURRENCY', 'UNIT', 'BASIS_SOURCE']) assert.ok(incomplete.reasons.includes(`MISSING_${field}`));
  assert.equal(CALIBRATION.risk_score_semantics, 'risk_pressure_not_default_probability'); assert.equal(CALIBRATION.payout_sla, null);
});

test('W4 official-list adapter handles quoted fields and rejects truncated/schema-invalid sources; no-match never clears eligibility', () => {
  const csv = '1,"Synthetic, Example",-0-,DEMO,-0-,-0-,-0-,-0-,-0-,-0-,-0-,"quoted ""remark"""\r\n';
  const source = parseSdnExport(csv), hit = screenPrimaryName(source, 'synthetic example'), miss = screenPrimaryName(source, 'Other Example');
  assert.equal(parseSdnExport(`${csv}${String.fromCharCode(26)}`).records.length, 1);
  assert.deepEqual(hit.entry_ids, ['1']); assert.equal(hit.status, 'MATCH_REVIEW');
  assert.equal(miss.status, 'NO_EXACT_PRIMARY_NAME_MATCH'); assert.equal(miss.eligible, false); assert.equal(miss.human_review_required, true);
  for (const bad of ['<html>unavailable</html>', '1,"truncated', `${csv}${csv}`, 'id,name,type\n']) assert.throws(() => parseSdnExport(bad));
});

test('W4 ACT/365 uses actual remaining time, exact atomic amounts and explicit fee-adjusted yield', () => {
  const value = actualFinancingPeriod({ fundedAt: '2026-10-17T12:00:00Z', maturityAt: '2026-10-27T12:00:00Z', priceAtomic: '800000', redemptionAtomic: '1000000', feeAtomic: '10000' });
  assert.equal(value.remaining_days, 10); assert.equal(value.gross_yield, 0.25);
  assert.equal(value.annualized_gross_yield, 9.125); assert.equal(value.annualized_net_yield, 8.66875);
  assert.throws(() => actualFinancingPeriod({ fundedAt: '2026-10-17', maturityAt: '2026-10-17', priceAtomic: '1', redemptionAtomic: '1' }));
});

test('W4 pricing commits complete source inputs and policy/calibration versions with stable key order', async () => {
  const data = JSON.parse(await fs.readFile('data/demo-case.json', 'utf8'));
  const first = quoteFromCase(data), reversed = quoteFromCase(Object.fromEntries(Object.entries(data).reverse()));
  assert.equal(first.evidence_hash, reversed.evidence_hash); assert.equal(first.evidence_schema, 'agentbl-pricing-evidence-v2');
  const changed = quoteFromCase({ ...data, source_revision: 'previously omitted input' });
  assert.notEqual(first.evidence_hash, changed.evidence_hash); assert.notEqual(first.quote_hash, changed.quote_hash);
  const period = quoteFromCase(data, { funded_at: '2026-10-17T00:00:00Z', maturity_at: '2026-10-27T00:00:00Z' });
  assert.equal(period.tenor_days, 10); assert.equal(period.actual_financing_period.remaining_days, 10);
  const live = quoteFromCase(data, { require_source_validation: true }); assert.equal(live.pricing_action, 'PAUSE_OFFERING');
});

test('W4 frozen corpus isolates labels, records actual failures/unsupported evidence/version drift, and refuses changed manifest', async () => {
  const corpus = JSON.parse(await fs.readFile('data/evaluation/w4/corpus.json', 'utf8'));
  const local = await evaluateProviderCorpus(corpus); assert.equal(local.scope, 'local_deterministic_or_injected'); assert.equal(local.business_accepted, false);
  const timeout = await evaluateProviderCorpus(corpus, { model: async (input) => { assert.equal(input.gold, undefined); throw new Error('synthetic timeout'); } });
  assert.ok(timeout.metrics.provider_failures > 0); assert.equal(timeout.metrics.human_review_rate, 1);
  const drift = await evaluateProviderCorpus(corpus, { providerVersion: { provider: 'expected', model: '1' }, model: async () => ({ document_type: 'EBL', text: '', fields: [
    { name: 'carrier', value: 'Invented Carrier', evidence: 'not present in document' }
  ], provider: 'changed', model: '2' }) });
  assert.ok(drift.metrics.supported_field_failures > 0); assert.ok(drift.metrics.version_drift > 0);
  const tampered = structuredClone(corpus); tampered.samples[0].gold.review = false;
  await assert.rejects(evaluateProviderCorpus(tampered), /integrity/u);
  assert.equal(local.corpus_hash, corpus.corpus_hash);
  assert.notEqual(hashSnapshot(local), hashSnapshot(timeout));
});
