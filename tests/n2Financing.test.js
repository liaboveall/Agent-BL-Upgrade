import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { disclosureFixture } from './helpers/disclosure.js';
import { createDisclosure, verifyDisclosure, disclosureFromPricingQuote } from '../src/rights/disclosure.js';
import { verifyFinancingTerms } from '../scripts/verify-financing-terms.mjs';
import { RightsService } from '../src/rights/service.js';
import { financingReview } from '../src/rights/financingReview.js';
import { priceRwaOffering, quoteFromCase } from '../src/core/pricingEngine.js';
import { sourceState } from '../src/provenance/fields.js';
import { runValuationAgent } from '../src/agent/valuationAgent.js';
import { AgentOrchestrator } from '../src/agent/orchestrator.js';
import { buildPremiumValuation } from '../src/x402/endpoints.js';

const inputOf = (pack) => { const { schema: _s, policy: _p, ...input } = pack.document; return structuredClone(input); };
test('N2 readable obligations are canonical, complete, immutable and independently bound to EIP-712', () => {
  const pack = disclosureFixture(); assert.equal(verifyDisclosure(pack), true);
  assert.deepEqual(createDisclosure(inputOf(pack)), pack);
  assert.equal(pack.document.scenario.asset_class, 'copper');
  for (const mutate of [p => p.document.parties.issuer = Wallet.createRandom().address, p => p.document.policy.platform_fee_atomic = '1',
    p => p.terms.issuePrice = '1', p => p.document.terms.maturity = '1', p => p.terms_hash = p.policy_hash]) {
    const changed = structuredClone(pack); mutate(changed); assert.equal(verifyDisclosure(changed), false);
  }
  for (const mutate of [p => delete p.parties.reviewer, p => p.terms.maxFee = '1', p => p.terms.disburseUntil = p.terms.maturity,
    p => p.sources[1] = p.sources[0], p => p.terms.supply = '1000001', p => p.private_title = 'private data']) {
    const changed = inputOf(pack); mutate(changed); assert.throws(() => createDisclosure(changed));
  }
});
test('version 2 disclosures keep verifying under their own policy and domain; versions cannot be swapped', async () => {
  const { FINANCE_POLICY, FINANCE_POLICY_V2 } = await import('../src/rights/financePolicy.js');
  const { hashOfferingTerms } = await import('../src/rights/typedData.js');
  const legacy = disclosureFixture(2), current = disclosureFixture();
  assert.equal('control_version' in legacy.document.instance, false); assert.equal(current.document.instance.control_version, 3);
  assert.deepEqual(legacy.document.policy, FINANCE_POLICY_V2); assert.deepEqual(current.document.policy, FINANCE_POLICY);
  assert.equal(FINANCE_POLICY.max_subscription_segments_per_investor, 32);
  for (const pack of [legacy, current]) { assert.equal(verifyDisclosure(pack), true); assert.deepEqual(createDisclosure(inputOf(pack)), pack); }
  const { chain_id: chainId, controller } = current.document.instance;
  assert.equal(legacy.terms_hash, hashOfferingTerms(chainId, controller, legacy.terms, 2));
  assert.equal(current.terms_hash, hashOfferingTerms(chainId, controller, current.terms, 3));
  const relabelled = structuredClone(legacy); relabelled.document.instance.control_version = 3; assert.equal(verifyDisclosure(relabelled), false);
  const downgraded = structuredClone(current); delete downgraded.document.instance.control_version; assert.equal(verifyDisclosure(downgraded), false);
  for (const version of [1, 2, 4]) assert.throws(() => createDisclosure({ ...inputOf(current), instance: { ...current.document.instance, control_version: version } }));
});
test('N2 public disclosure requires issuing authority and two approved bindings; restart and old revisions retain exact terms without private title', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'n2-vault-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { AGENTBL_RIGHTS_KEY: 'ab'.repeat(32) }, service = new RightsService({ directory, env });
  const login = async (roles) => {
    const wallet = Wallet.createRandom(), subject = await service.createSubject({ wallet: wallet.address, roles, organization: 'research' });
    const challenge = await service.createChallenge(subject.subject_id);
    return { wallet, ...(await service.openSession({ challenge_id: challenge.challenge_id, signature: await wallet.signTypedData(challenge.domain, challenge.types, challenge.message) })) };
  };
  const issuer = await login(['issuer']), a = await login(['reviewer']), b = await login(['reviewer']), investor = await login(['investor']);
  const material = await service.createMaterial(issuer.token, { material: { private_title: 'DO-NOT-PUBLISH-N2' }, public_summary: {
    asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 3, terms_hash: disclosureFixture().terms_hash, risk_flags: ['simulated_title'] } });
  const input = inputOf(disclosureFixture()); input.parties.issuer = issuer.wallet.address; input.terms.documentHash = material.document_hash;
  const wrongScenario = structuredClone(input); wrongScenario.scenario.asset_class = 'oil';
  await assert.rejects(service.createFinancingDisclosure(issuer.token, material.material_id, wrongScenario), { code: 'financing_disclosure_invalid' });
  await assert.rejects(service.createFinancingDisclosure(investor.token, material.material_id, input));
  const pack = await service.createFinancingDisclosure(issuer.token, material.material_id, input);
  await assert.rejects(service.financingDisclosure(pack.disclosure_hash), { code: 'financing_disclosure_unverified' });
  await service.bindTerms(issuer.token, material.material_id, pack.terms_hash);
  for (const reviewer of [a, b]) await service.reviewMaterial(reviewer.token, material.material_id, { document_hash: material.document_hash, terms_hash: pack.terms_hash });
  await service.publishMaterial(issuer.token, material.material_id);
  assert.deepEqual(await new RightsService({ directory, env }).financingDisclosure(pack.disclosure_hash), pack);
  assert.equal(JSON.stringify(await service.financingDisclosure(pack.disclosure_hash)).includes('DO-NOT-PUBLISH-N2'), false);
  const changed = structuredClone(input); changed.terms.issuePrice = '810000';
  await assert.rejects(service.createFinancingDisclosure(issuer.token, material.material_id, changed), { code: 'disclosure_revision_used' });
  changed.revision = 2; const second = await service.createFinancingDisclosure(issuer.token, material.material_id, changed);
  await service.bindTerms(issuer.token, material.material_id, second.terms_hash);
  await assert.rejects(service.financingDisclosure(second.disclosure_hash), { code: 'financing_disclosure_unverified' });
  assert.deepEqual(await service.financingDisclosure(pack.disclosure_hash), pack);

  // Approved terms stay readable without the vault key, from the public copy alone; an unapproved revision never leaks.
  const keyless = new RightsService({ directory, env: {} });
  assert.deepEqual(await keyless.financingDisclosure(pack.disclosure_hash), pack);
  await assert.rejects(keyless.financingDisclosure(second.disclosure_hash), { code: 'rights_not_configured' });
  const copy = path.join(directory, 'public-disclosures', `${pack.disclosure_hash.toLowerCase()}.json`);
  assert.equal(JSON.stringify(JSON.parse(await fs.readFile(copy, 'utf8'))).includes('DO-NOT-PUBLISH-N2'), false);
  const altered = JSON.parse(await fs.readFile(copy, 'utf8')); altered.terms.issuePrice = '1';
  await fs.writeFile(copy, JSON.stringify(altered));
  await assert.rejects(keyless.financingDisclosure(pack.disclosure_hash), { code: 'rights_not_configured' });
  await assert.rejects(keyless.financingDisclosure('../vault'), { code: 'rights_not_configured' });
});
test('N2 canonical review refuses missing or corrupt terms, altered pool terms, cross-instance bindings, revoked roles and reorgs', async () => {
  const pack = disclosureFixture(), t = pack.terms; let price = t.issuePrice, reorg = false, revoked = false;
  const chain = { chainId: 1439, provider: { getBlock: async (tag) => ({ number: 10, hash: reorg && tag === 10 ? 'fork' : 'canonical' }) },
    controller: { getAddress: async () => pack.document.instance.controller, terms: async () => t, termsHash: async () => pack.terms_hash,
      governance: async () => pack.document.parties.governance, valuer: async () => pack.document.parties.valuer, roles: async () => !revoked },
    registry: { holderOf: async () => pack.document.parties.holder },
    pool: { quoteVersion: async () => 3, getAddress: async () => pack.document.instance.pool, offerings: async () => ({ issuePrice: price, targetRedemptionValue: t.target, tokenSupply: t.supply, settlementAsset: t.settlementAsset }) } };
  const store = { financingDisclosure: async () => pack };
  assert.equal((await financingReview(chain, store, 1)).quote_version, '3');
  price = '1'; await assert.rejects(financingReview(chain, store, 1), { code: 'financing_terms_changed' }); price = t.issuePrice;
  revoked = true; await assert.rejects(financingReview(chain, store, 1), { code: 'financing_terms_changed' }); revoked = false;
  reorg = true; await assert.rejects(financingReview(chain, store, 1), { code: 'chain_reconciliation_required' }); reorg = false;
  chain.chainId = 31337; await assert.rejects(financingReview(chain, store, 1)); chain.chainId = 1439;
  const corrupt = structuredClone(pack); corrupt.document.terms.issuePrice = '1';
  await assert.rejects(financingReview(chain, { financingDisclosure: async () => corrupt }, 1), { code: 'financing_disclosure_unverified' });
  await assert.rejects(financingReview(chain, { financingDisclosure: async () => { throw new Error('material unavailable'); } }, 1));
});
const base = { case_id: 'n2', bl_id: 'n2', payout_speed: 'BALANCED', requested_cash_usd: 100000, gross_profit_usd: 20000,
  ai_verified_collateral_value_usd: 200000, redemption_coverage_limit: 0.9, tenor_days: 60, risk_score_bps: 0 };
test('N2 independent compensation lower bound, borrower cap and collateral intersect; low profit/high funding/high loss reject', () => {
  const q = priceRwaOffering(base), r = q.research_feasibility;
  assert.equal(q.economic_checks.ok, true); assert.equal(r.annual_floor_bps, 500);
  assert.equal(r.investor_floor_usd, 821.92); assert.equal(r.borrower_ceiling_usd, 1479.45);
  for (const extra of [{ gross_profit_usd: 100 }, { research_constraints: { funding_rate_bps: 2000 } },
    { research_constraints: { loss_buffer_bps: 2000 } }, { ai_verified_collateral_value_usd: 110000 }]) {
    const bad = priceRwaOffering({ ...base, ...extra }); assert.equal(bad.pricing_action, 'PAUSE_OFFERING');
    assert.ok(bad.economic_checks.failures.includes('NO_COMMON_FINANCING_INTERVAL'));
  }
  assert.deepEqual(r.sensitivity.map(row => row.scenario), ['base', 'low_profit', 'high_funding_cost', 'high_loss_pressure']);
  assert.equal(r.sensitivity[2].feasible, false); assert.equal(r.sensitivity[3].feasible, false);
  for (const v of [null, -1, Infinity, 1.2, '300']) assert.throws(() => priceRwaOffering({ ...base, research_constraints: { funding_rate_bps: v } }));
  assert.notEqual(q.evidence_hash, priceRwaOffering({ ...base, research_constraints: { funding_rate_bps: 301 } }).evidence_hash);
});
test('N2 deterministic quote generates the same exact atomic terms for offline recomputation, disclosure and wallet EIP-712', () => {
  const quote = priceRwaOffering(base), input = inputOf(disclosureFixture());
  input.terms.minRaise = '1';
  const pack = disclosureFromPricingQuote(input, quote), checked = verifyFinancingTerms({ ...pack, block_number: 1, verification: 'not_trusted_by_offline_verifier' });
  assert.equal(pack.terms.issuePrice, quote.atomic_economics.issue_price_atomic);
  assert.equal(checked.gross_principal_atomic, quote.atomic_economics.principal_atomic);
  assert.equal(checked.gross_target_atomic, quote.atomic_economics.target_atomic);
  assert.equal(checked.chain_state_verified, false);
  assert.throws(() => disclosureFromPricingQuote(input, priceRwaOffering({ ...base, gross_profit_usd: 1 })));
  const tampered = structuredClone(pack); tampered.document.policy.platform_fee_atomic = '1'; assert.throws(() => verifyFinancingTerms(tampered));
});
test('N2 open quotes satisfy actual unit-price compensation, profit, rate and collateral limits across deterministic stress cases', () => {
  let opened = 0;
  for (let i = 1; i <= 160; i++) {
    const q = priceRwaOffering({ ...base, requested_cash_usd: 10000 + i * 987, gross_profit_usd: i * 37,
      tenor_days: 30 + i, risk_score_bps: i * 9, research_constraints: { funding_rate_bps: (i % 10) * 100 } });
    if (q.pricing_action === 'PAUSE_OFFERING') continue;
    opened++;
    const cash = q.recommended_token_supply * q.final_issue_price_usd, compensation = q.recommended_token_supply - cash;
    assert.ok(compensation + 0.005 >= cash * q.research_feasibility.annual_floor_bps / 10000 * q.tenor_days / 365);
    assert.ok(compensation <= q.exporter_gross_profit_usd * 0.85 + 0.005);
    assert.ok(compensation <= cash * q.annual_rate_cap_bps / 10000 * q.tenor_days / 365 + 0.005);
    assert.ok(q.recommended_token_supply <= q.max_safe_redemption_exposure_usd);
  }
  assert.ok(opened > 5);
});
test('N2 source status never upgrades missing, stale or undated evidence into live; risk and collateral remain research estimates', async () => {
  const now = Date.parse('2026-10-18T00:00:00Z');
  assert.equal(sourceState({ value: null, status: 'live' }, now).status, 'unavailable');
  assert.equal(sourceState({ value: 123, status: 'live' }, now).status, 'unavailable');
  const live = { value: 123, status: 'live', observed_at: '2026-10-17T00:00:00Z', expires_at: '2026-10-19T00:00:00Z' };
  assert.equal(sourceState(live, now).status, 'live'); assert.equal(sourceState({ ...live, expires_at: '2026-10-18T00:00:00Z' }, now).status, 'stale');
  assert.equal(sourceState({ value: 123, status: 'offline' }, now).status, 'fixture');
  const data = JSON.parse(await fs.readFile('data/cases/copper-sg-shanghai.case.json', 'utf8'));
  const q = quoteFromCase(data, { now });
  assert.equal(q.field_sources.cost.status, 'fixture'); assert.equal(q.field_sources.collateral.status, 'fixture');
  assert.equal(q.field_sources.risk.applicability, 'risk_pressure_not_default_probability');
  const report = await runValuationAgent(data, { env: { DEEPSEEK_API_KEY: 'synthetic-only', COMMODITY_PRICE_PROVIDER: 'mock' }, chat: async () => { throw new Error('secret-provider-response'); } });
  assert.equal(report.model_status, 'failed'); assert.equal(report.human_takeover.required, true); assert.equal(report.provider_verified, false);
  assert.equal(report.field_sources.market.status, 'fixture'); assert.equal(report.ai_explanation.includes('secret-provider-response'), false);
});
test('N2 valuation failure propagates to both agent pipelines and paid reports, preventing automatic execution', async () => {
  const data = JSON.parse(await fs.readFile('data/cases/copper-sg-shanghai.case.json', 'utf8'));
  const options = { env: { DEEPSEEK_API_KEY: 'synthetic-only', COMMODITY_PRICE_PROVIDER: 'mock' }, forceDeterministic: false,
    chat: async () => { throw new Error('synthetic provider failure'); } };
  const report = await runValuationAgent(data, options);
  const orchestrator = new AgentOrchestrator({ runValuation: async () => report });
  let executed = false;
  const old = await orchestrator.processEbl(data, { executeAction: async () => { executed = true; } });
  assert.equal(old.action, 'PAUSE_OFFERING'); assert.equal(old.can_auto_execute, false); assert.equal(executed, false);
  const documents = await Promise.all(['bill-of-lading.md', 'commercial-invoice.md', 'insurance-policy.md'].map(async (name, i) => ({ name, kind: 'text', mime_type: 'text/markdown',
    sha256: `0x${String(i).padStart(64, '0')}`, text: await fs.readFile(`data/uploads/copper-sg-shanghai/${name}`, 'utf8') })));
  const current = await orchestrator.processDocuments({ case_id: 'CASE-N2-FAILURE', documents }, { forceDeterministic: true });
  assert.equal(current.action, 'HOLD_FOR_REVIEW'); assert.ok(current.findings.some((f) => f.kind === 'VALUATION_REVIEW'));
  assert.equal(current.pipeline.find((step) => step.step === 'cargo_valuation').status, 'REVIEW');
  const paid = await buildPremiumValuation(data, { valuation: options });
  assert.equal(paid.human_takeover.required, true); assert.equal(paid.model_status, 'failed'); assert.equal(paid.provider_verified, false);
});

test('N2 terms can take price, supply and minimum raise from the deterministic quote; a moved or paused quote is refused', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'n2-quoted-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let quote = priceRwaOffering(base); const requests = [];
  const service = new RightsService({ directory, env: { AGENTBL_RIGHTS_KEY: 'cd'.repeat(32) }, quoteCase: async (request, terms) => { requests.push({ request, terms }); return quote; } });
  const wallet = Wallet.createRandom(), subject = await service.createSubject({ wallet: wallet.address, roles: ['issuer'], organization: 'research' });
  const challenge = await service.createChallenge(subject.subject_id);
  const { token } = await service.openSession({ challenge_id: challenge.challenge_id, signature: await wallet.signTypedData(challenge.domain, challenge.types, challenge.message) });
  const material = await service.createMaterial(token, { material: { private_title: 'quoted' }, public_summary: {
    asset_class: 'copper', settlement: 'TEST_USDC', tenor_days: 3, terms_hash: disclosureFixture().terms_hash, risk_flags: ['simulated_title'] } });
  const input = inputOf(disclosureFixture()); input.parties.issuer = wallet.address; input.terms.documentHash = material.document_hash; input.terms.minRaise = '1';
  const from_quote = { case_id: 'CASE-EBL-CU-SIN-SHA', payout_speed: 'BALANCED', requested_cash_usd: 1000 };
  const preview = await service.createFinancingDisclosure(token, material.material_id, { ...input, from_quote }, { save: false });
  const { source_quote: source, ...pack } = preview;
  assert.equal(verifyDisclosure(pack), true, 'The quote reference travels beside an intact pack');
  assert.equal(pack.terms.issuePrice, quote.atomic_economics.issue_price_atomic);
  assert.equal(pack.terms.supply, String(quote.recommended_token_supply));
  assert.equal(pack.terms.minRaise, '1', 'A smaller minimum from the file is kept');
  assert.deepEqual([source.quote_hash, source.payout_speed, requests[0].terms.maturity], [quote.quote_hash, 'BALANCED', input.terms.maturity]);
  const saved = await service.createFinancingDisclosure(token, material.material_id, { ...input, from_quote, expected_terms_hash: preview.terms_hash });
  assert.equal(saved.terms_hash, preview.terms_hash);
  quote = priceRwaOffering({ ...base, risk_score_bps: 400 });
  assert.notEqual(quote.atomic_economics.issue_price_atomic, pack.terms.issuePrice);
  await assert.rejects(service.createFinancingDisclosure(token, material.material_id, { ...input, revision: 2, from_quote, expected_terms_hash: preview.terms_hash }), { code: 'financing_quote_changed' });
  quote = priceRwaOffering({ ...base, gross_profit_usd: 1 });
  await assert.rejects(service.createFinancingDisclosure(token, material.material_id, { ...input, revision: 2, from_quote }), { code: 'financing_quote_not_openable' });
  for (const wrong of [{ ...from_quote, case_id: 'CASE-EBL-OIL-FUJ-SIN' }, { ...from_quote, requested_cash_usd: 1000000 }, { ...from_quote, payout_speed: 'NOW' }]) {
    await assert.rejects(service.createFinancingDisclosure(token, material.material_id, { ...input, from_quote: wrong }, { save: false }), { code: 'financing_quote_invalid' });
  }
});
