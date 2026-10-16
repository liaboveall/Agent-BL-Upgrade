import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { hasTranslation, setLang, t, tData, tTradeText } from '../web/src/lib/i18n.js';

// Scan the whole dashboard: pages, features, components, state and shared helpers.
async function frontendSources(directory) {
  const sources = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('i18n')) continue;
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) sources.push(...await frontendSources(path));
    else if (/\.jsx?$/u.test(entry.name)) sources.push(await fs.readFile(path, 'utf8'));
  }
  return sources;
}
const sources = await frontendSources(new URL('../web/src/', import.meta.url));

function referencedTranslationKeys() {
  const keys = new Set();
  // t('key') calls and <RichT k="key"/>, plus every quoted ac_* key (toast and label keys are passed as strings).
  for (const source of sources) {
    for (const match of source.matchAll(/\bt\('([^']+)'(?=\s*(?:,|\)))/gu)) keys.add(match[1]);
    for (const match of source.matchAll(/<RichT k="([^"]+)"/gu)) keys.add(match[1]);
    for (const match of source.matchAll(/(?:labelKey|titleKey|hintKey):\s*'([a-z0-9_]+)'/gu)) keys.add(match[1]);
    for (const match of source.matchAll(/'(ac_[a-z_]+)'/gu)) if (!match[1].endsWith('_')) keys.add(match[1]);
    for (const match of source.matchAll(/'((?:cp|ebld)_[a-z_]+)'/gu)) if (!match[1].endsWith('_')) keys.add(match[1]);
  }
  for (const key of ['risk_max', 'yield_min_bps', 'tenor_days_max', 'commodities_include', 'commodities_exclude', 'regions_include', 'regions_exclude', 'chokepoints_avoid', 'ticket_usd', 'financing_max_usd', 'insurance_coverage_min', 'payout_speed']) keys.add(`cp_filter_${key}`);
  for (const key of ['inactive_pool', 'compliance_block', 'agent_hold', 'unknown_risk', 'risk_max', 'yield_min_bps', 'tenor_days_max', 'commodities_include', 'commodities_exclude', 'regions_include', 'regions_exclude', 'chokepoints_avoid', 'ticket_usd', 'financing_max_usd', 'insurance_coverage_min', 'payout_speed']) keys.add(`cp_exclude_${key}`);
  for (const key of ['Market', 'Mystery', 'Copilot']) keys.add(`cp_source_${key}`);
  for (const key of ['elevated_risk', 'not_subscribable', 'compliance_review', 'stale_quote']) keys.add(`cp_warning_${key}`);
  for (const key of ['yield', 'risk', 'preference', 'coverage', 'penalties']) keys.add(`cp_score_${key}`);
  for (const key of ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'INTERRUPTED']) keys.add(`ebld_status_${key}`);
  for (const key of ['Created', 'Priced', 'Open', 'Subscribed', 'Funded', 'InTransit', 'Repriced', 'Paused', 'Frozen', 'Liquidated', 'Repaid', 'Cancelled', 'Unknown']) keys.add(`cp_state_${key}`);
  for (const key of ['document_parse', 'injection_screen', 'document_consistency', 'compliance', 'cargo_valuation', 'world_risk', 'three_speed_pricing', 'exporter_constraints', 'decision', 'policy', 'execution_plan']) keys.add(`ebld_step_${key}`);
  for (const key of ['PASS', 'WARN', 'FAIL', 'SKIP', 'REVIEW']) keys.add(`ebld_step_status_${key}`);
  for (const key of ['OPEN', 'OPEN_WITH_WARNING', 'HOLD_FOR_REVIEW', 'REJECT']) keys.add(`ebld_action_${key}`);
  for (const key of ['bl_id', 'bl_no', 'invoice_no', 'cargo', 'quantity_mt', 'declared_value_usd', 'total_amount_usd', 'unit_price_usd_per_mt', 'currency', 'vessel', 'voyage_no', 'port_of_loading', 'port_of_discharge', 'eta', 'issue_date', 'coverage_ratio', 'insured_value_usd', 'expires_at']) keys.add(`ebld_field_${key}`);
  for (const status of ['DECIDED', 'EXECUTING', 'COMPLETED', 'FAILED', 'SKIPPED', 'REJECTED', 'PENDING_APPROVAL', 'AWAITING_OWNER_SIGNATURE']) keys.add(`ac_status_${status}`);
  for (const verdict of ['AUTO', 'NEEDS_APPROVAL', 'OBSERVE_ONLY', 'REJECTED']) keys.add(`ac_verdict_${verdict}`);
  for (const level of ['off', 'observe', 'propose', 'auto']) keys.add(`ac_autonomy_${level}`);
  for (const state of ['disabled', 'inactive', 'idle', 'healthy', 'catching-up', 'waiting-confirmations', 'degraded']) keys.add(`ac_chain_${state}`);
  for (const action of ['RECORD_PAYMENT', 'RECORD_ARRIVAL', 'SETTLE']) keys.add(`ac_set_reason_${action}`);
  for (const status of ['CLEAR', 'REVIEW', 'BLOCK']) keys.add(`comp_status_${status}`);
  for (const category of ['entity', 'vessel', 'imo', 'port', 'jurisdiction', 'hs', 'cargo', 'export_controls', 'standard', 'standards', 'fair_access', 'external']) keys.add(`comp_category_${category}`);
  for (const code of ['ENTITY_CLEAR', 'ENTITY_MATCH_REVIEW', 'ENTITY_MATCH_BLOCK', 'INPUT_REVIEW', 'COUNTERPARTY_MISSING', 'INJECTION_REVIEW',
    'JURISDICTION_BLOCK', 'PORT_CLEAR', 'PORT_UNKNOWN', 'PORT_AMBIGUOUS', 'PORT_MISSING', 'VESSEL_CLEAR', 'VESSEL_MATCH_REVIEW', 'VESSEL_MATCH_BLOCK', 'IMO_INVALID',
    'HS_BLOCK', 'HS_REVIEW', 'HS_CLEAR', 'HS_MISSING', 'HS_INVALID', 'CARGO_BLOCK', 'CARGO_REVIEW', 'STANDARD_DECLARED', 'STANDARD_UNDECLARED', 'STANDARD_NOT_APPLICABLE', 'FAIR_ACCESS',
    'EXTERNAL_CLEAR', 'EXTERNAL_REVIEW', 'EXTERNAL_BLOCK', 'EXTERNAL_UNAVAILABLE']) keys.add(`comp_code_${code}`);
  return [...keys].sort();
}

test('frontend translation keys have both Chinese and English copy', () => {
  const missing = [];
  for (const key of referencedTranslationKeys()) {
    if (!hasTranslation(key, 'zh')) missing.push(`zh:${key}`);
    if (!hasTranslation(key, 'en')) missing.push(`en:${key}`);
  }
  assert.deepEqual(missing, []);
});

test('the document language follows the language switch', () => {
  const savedDocument = globalThis.document;
  globalThis.document = { title: '', documentElement: { lang: '' } };
  try {
    setLang('en');
    assert.equal(globalThis.document.documentElement.lang, 'en');
    assert.equal(t('a11y_network'), 'Protocol network');
    setLang('zh');
    assert.equal(globalThis.document.documentElement.lang, 'zh-CN');
    assert.equal(t('a11y_network'), '协议网络');
  } finally { globalThis.document = savedDocument; }
});

test('Chinese UI keeps navigation and key investor information in Chinese', () => {
  setLang('zh');
  assert.equal(t('nav_market'), '投资市场');
  assert.equal(t('nav_mint'), '提单上链 · 铸造 RWA');
  assert.equal(t('portfolio_h'), '我的持仓');
  assert.equal(t('protocol_evidence_h'), '实时协议凭证');
});

test('English UI copy contains no accidental Chinese', () => {
  setLang('en');
  const allowed = new Set(['lang_switch_to']);
  const mixed = referencedTranslationKeys()
    .filter((key) => !allowed.has(key) && /[\u3400-\u9fff]/u.test(t(key)))
    .map((key) => `${key}: ${t(key)}`);
  assert.deepEqual(mixed, []);
  setLang('zh');
});

test('Chinese-native trade data is rendered in English in English mode', () => {
  setLang('en');
  assert.equal(tData('N/A（库内交货）'), 'N/A (Warehouse Delivery)');
  assert.equal(tData('AL99.70 / P1020 级别'), 'AL99.70 / P1020 Grade');
  assert.equal(
    tData('佛山南海指定仓库（入库单号 WH-FS-00008)'),
    'Designated Warehouse, Nanhai, Foshan (Inbound Receipt WH-FS-00008)'
  );
  assert.equal(tData('Non-GMO Soybeans (非转基因大豆), Bulk'), 'Non-GMO Soybeans, Bulk');
  assert.equal(tData('domestic_aluminum_market/medium (中国 / 华南): +30bps'), 'domestic_aluminum_market/medium (China / South China): +30bps');
  const source = '5. 铝锭 AL99.70（P1020 级别，国产重熔用铝锭） · 佛山南海指定仓库（入库单号 WH-FS-2026-05003）';
  assert.doesNotMatch(tTradeText(source), /[\u3400-\u9fff]/u);
  assert.match(tTradeText(source), /AL99\.70.*P1020.*WH-FS-2026-05003/u);
  setLang('zh');
});
