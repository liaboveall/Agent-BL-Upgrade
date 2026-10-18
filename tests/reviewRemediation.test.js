import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { priceRwaOffering, PAYOUT_SPEEDS, quoteFromCase } from '../src/core/pricingEngine.js';
import { assertPricingQuote } from '../src/core/pricingSchema.js';

import { planTransition, ACTIVE_STATES } from '../src/agent/runtime/poolRules.js';
import { fetchSeaState, fetchFuturesQuote } from '../src/realdata/sources.js';
import { getMarketQuote, routeRiskEvents } from '../src/realdata/index.js';
import { TtlCache } from '../src/realdata/http.js';
import { mergeWorldRiskIntoCase } from '../src/core/worldRiskPricing.js';
import { createPool, resetStore, subscribeToPool } from '../src/app/store.js';
import { subscriptionAvailability } from '../src/core/subscription.js';
import { IngestService } from '../src/agent/ingest/ingestService.js';
import { workspaceOwner, canReadWorkspaceCase } from '../src/app/workspaceAccess.js';



const input = { case_id: 'ECON-BOUNDARY', bl_id: 'BL-BOUNDARY', payout_speed: 'BALANCED', requested_cash_usd: 5e6,
  gross_profit_usd: 100, ai_verified_collateral_value_usd: 8e6, tenor_days: 30 };
const response = (data) => ({ ok: true, text: async () => JSON.stringify(data) });

test('F01: final rounded terms reject the independently reproduced loss, zero profit and negative profit', () => {
  for (const profit of [100, 0, -100]) {
    const q = priceRwaOffering({ ...input, gross_profit_usd: profit });
    assert.equal(q.pricing_action, 'PAUSE_OFFERING');
    assert.equal(q.exporter_gross_profit_usd, profit);
    assert.equal(q.economic_checks.ok, false);
    assertPricingQuote(q);
  }
});

test('F01: every openable rounded quote satisfies profit, annual rate, cash and collateral invariants', () => {
  let open = 0, closed = 0;
  for (const speed of PAYOUT_SPEEDS) for (const cash of [0, 0.01, 100, 100000, 5000000])
    for (const profit of [-1, 0, 0.01, 100, 1000000]) for (const tenor of [1, 30, 60, 365]) {
      const q = priceRwaOffering({ ...input, payout_speed: speed, requested_cash_usd: cash, gross_profit_usd: profit, tenor_days: tenor });
      assertPricingQuote(q);
      if (q.pricing_action.startsWith('OPEN')) {
        open++;
        assert.ok(q.exporter_net_profit_usd >= 0);
        assert.ok(q.financing_cost_usd <= profit * 0.85 + 0.005);
        assert.ok(q.annualized_yield_bps <= q.annual_rate_cap_bps);
        assert.ok(q.expected_cash_to_exporter_usd <= cash + 0.005);
        assert.ok(q.target_redemption_exposure_usd <= q.max_safe_redemption_exposure_usd);
        assert.ok(Number.isInteger(q.recommended_token_supply) && q.recommended_token_supply > 0);
      } else closed++;
    }
  assert.ok(open > 0 && closed > 0);
});

test('F02: pricing is orthogonal to every active lifecycle, including full funding and in-transit', () => {
  for (const state of ACTIVE_STATES) {
    const plan = planTransition('REPRICE', { state });
    assert.equal(plan.to, state); assert.equal(plan.changesState, false);
  }
  assert.equal(planTransition('MARK_IN_TRANSIT', { state: planTransition('REPRICE', { state: 'Funded' }).to }).to, 'InTransit');
});





test('F04: partial recovery and missing debt terms cannot discharge an offering', () => {
  const pool = { state: 'InTransit', subscribed: 100, paymentProof: true, arrivalProof: true, targetRedemptionValueAtomic: '1000000', repaymentAmountAtomic: '1' };
  assert.equal(planTransition('SETTLE', pool).code, 'outstanding_debt');
  assert.equal(planTransition('SETTLE', { ...pool, repaymentAmountAtomic: undefined }).code, 'debt_unverified');
  assert.equal(planTransition('SETTLE', { ...pool, repaymentAmountAtomic: '100000000' }).to, 'Repaid');
});

test('F05: workspace ownership isolates uploads and cross-case identical documents are rejected', async () => {
  const ingest = new IngestService();
  const request = { headers: {} }, responseHeaders = {};
  const owner = workspaceOwner(request, { setHeader: (key, value) => { responseHeaders[key] = value; } });
  const document = { name: 'private.txt', mime_type: 'text/plain', text: 'Fictional private exporter' };
  await ingest.accept({ case_id: 'PRIVATE-A', documents: [document] }, { ownerId: owner });
  const ownerRequest = { headers: { cookie: responseHeaders['Set-Cookie'].split(';')[0] } };
  assert.equal(canReadWorkspaceCase({ ingest }, request, 'PRIVATE-A'), false);
  assert.equal(canReadWorkspaceCase({ ingest }, ownerRequest, 'PRIVATE-A'), true);
  await assert.rejects(ingest.accept({ case_id: 'PRIVATE-A', documents: [document] }, { ownerId: 'other' }), { code: 'case_owner_conflict' });
  await assert.rejects(ingest.accept({ case_id: 'PRIVATE-B', documents: [document] }, { ownerId: owner }), { code: 'duplicate_asset_documents' });
  const generated = new IngestService();
  await generated.accept({ documents: [document] }, { ownerId: owner });
  await assert.rejects(generated.accept({ documents: [document] }, { ownerId: 'another-workspace' }), { code: 'duplicate_asset_documents' });
});

test('F09: full funding, transit and unknown states are closed through the shared eligibility rule', () => {
  for (const status of ['Funded', 'InTransit', 'Paused', 'Frozen', 'Defaulted', 'LossSettled', 'Unknown']) {
    assert.equal(subscriptionAvailability({ status, targetUsd: 100, subscribedUsd: 1 }).can_subscribe, false);
  }
  assert.equal(subscriptionAvailability({ status: 'Open', targetUsd: 100, subscribedUsd: 100 }).can_subscribe, false);
  assert.equal(subscriptionAvailability({ status: 'Subscribed', targetUsd: 100, subscribedUsd: 1 }).can_subscribe, true);
});

test('subscription precision: integer shares conserve six-decimal amounts and leave the unspent budget explicit', async () => {
  resetStore();
  try {
    const data = JSON.parse(await fs.readFile(new URL('../data/cases/copper-sg-shanghai.case.json', import.meta.url)));
    const pool = createPool(data.case_id, data, quoteFromCase(data));
    const { investment } = subscribeToPool('0xDemoWallet', data.case_id, 1000);
    assert.ok(Number.isInteger(investment.tokenCount));
    assert.equal(Number(investment.paidAmountAtomic), investment.tokenCount * Math.round(investment.price * 1e6));
    assert.ok(Math.abs(investment.amountUsd + investment.unspentUsd - 1000) < 1e-6);
    assert.equal(pool.subscribedShares, investment.tokenCount);
    const original = investment.price; pool.quote = { ...pool.quote, final_issue_price_usd: 0.8 };
    assert.equal(investment.price, original); assert.equal(investment.redemptionValueUsd, 1);
  } finally { resetStore(); }
});

test('F10: null sea heights stay missing and filtering retains the correct observation date', async () => {
  const fetchImpl = async () => response({ daily: { wave_height_max: [null, 4, 2], time: ['2026-10-17', '2026-10-18', '2026-10-19'] } });
  assert.deepEqual(await fetchSeaState({ lat: 1, lon: 2 }, { fetchImpl }), { max_wave_height_m: 4, on: '2026-10-18' });
  await assert.rejects(fetchSeaState({ lat: 1, lon: 2 }, { fetchImpl: async () => response({ daily: { wave_height_max: [null, null] } }) }), /no wave heights/u);
});

test('F10: missing prices are rejected; null closes are omitted; old observations stay stale after a successful fetch', async () => {
  const chart = (price) => ({ chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: Date.parse('2025-01-01') / 1000 }, indicators: { quote: [{ close: [null, 4, 5] }] } }] } });
  await assert.rejects(fetchFuturesQuote('HG=F', { fetchImpl: async () => response(chart(null)) }), /positive quote/u);
  const quote = await fetchFuturesQuote('HG=F', { fetchImpl: async () => response(chart(5)) });
  assert.equal(quote.change_1m, 0.25);
  const q = await getMarketQuote('copper', { env: { REAL_DATA: 'on' }, now: Date.parse('2026-10-17'), cache: new TtlCache(), fetchImpl: async () => response(chart(5)) });
  assert.equal(q.status, 'stale'); assert.equal(q.observed_at, '2025-01-01T00:00:00.000Z');
  const risk = await routeRiskEvents({ route_profile: { waypoints: [{ name: 'Missing', lat: 87.321, lon: 123.456 }] } },
    { env: { REAL_DATA: 'on' }, cache: new TtlCache(), fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(risk.review_required, true); assert.equal(risk.evidence.sea_state[0].max_wave_height_m, null);
});

test('F11: a newer same-source observation can downgrade or resolve risk; empty/stale feeds cannot', () => {
  const initial = { macro_risk_events: [{ type: 'war_risk', region: 'Route', source: 'Source A', date: '2026-10-16', severity: 'critical' }] };
  const newer = { type: 'war_risk', region: 'Route', source: 'Source A', date: '2026-10-17', severity: 'info' };
  const recovered = mergeWorldRiskIntoCase(initial, [newer]);
  assert.equal(recovered.macro_risk_events[0].severity, 'info'); assert.equal(recovered.risk_event_history[0].severity, 'critical');
  assert.equal(mergeWorldRiskIntoCase(initial, []).macro_risk_events[0].severity, 'critical');
  assert.equal(mergeWorldRiskIntoCase(initial, [{ ...newer, data_status: 'stale' }]).macro_risk_events[0].severity, 'critical');
  assert.equal(mergeWorldRiskIntoCase(initial, [{ ...newer, source: 'Source B' }]).macro_risk_events.length, 2);
  assert.equal(mergeWorldRiskIntoCase(initial, [{ ...newer, status: 'resolved' }]).macro_risk_events.length, 0);
});
