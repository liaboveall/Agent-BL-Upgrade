import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseDocument } from '../documentParser.js';
import { checkDocumentConsistency } from '../documentConsistency.js';
import { checkCompliance } from '../complianceChecker.js';
import { AgentOrchestrator } from '../orchestrator.js';
import { hashSnapshot, stableStringify } from '../decisionLogger.js';
import { quoteFromCase } from '../../core/pricingEngine.js';
import { assertPricingQuote } from '../../core/pricingSchema.js';
import { CopilotService } from '../../copilot/service.js';
import { createPool, resetStore, storeState } from '../../app/store.js';
import { createAgentService } from '../runtime/factory.js';
import { loadAgentConfig } from '../runtime/config.js';
import { loadEvaluationDataset, evaluationPools, EVAL_THRESHOLDS } from './dataset.js';

const ratio = (a, b) => b ? a / b : 0;
const same = (a, b) => stableStringify(a) === stableStringify(b);
const forbiddenKeys = new Set(['gold', 'ground_truth', 'expected', 'labels', 'relevance']);

/** The only route from the scorer to a subject: deep-cloned, frozen, label-free inputs. */
export async function runBlind(input, component) {
  const freeze = (value) => {
    if (!value || typeof value !== 'object') return value;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbiddenKeys.has(key), `Evaluation label leaked into component input: ${key}`);
      freeze(child);
    }
    return Object.freeze(value);
  };
  return component(freeze(structuredClone(input)));
}

export function ndcgAt3(ids, relevance) {
  const dcg = (grades) => grades.slice(0, 3).reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const ideal = dcg(Object.values(relevance).sort((a, b) => b - a));
  // A duplicate item cannot earn the same relevance twice.
  const seen = new Set();
  return ratio(dcg(ids.map((id) => { const grade = seen.has(id) ? 0 : relevance[id] ?? 0; seen.add(id); return grade; })), ideal);
}

function setCounts(actual, gold) {
  const a = new Set(actual), g = new Set(gold);
  return { tp: [...a].filter((value) => g.has(value)).length, fp: [...a].filter((value) => !g.has(value)).length, fn: [...g].filter((value) => !a.has(value)).length };
}
const facts = (object) => Object.entries(object).flatMap(([key, value]) => Array.isArray(value)
  ? value.map((entry) => `${key}:${entry}`) : value === undefined ? [] : [`${key}:${value}`]);
const sumCounts = (target, counts) => { for (const key of ['tp', 'fp', 'fn']) target[key] += counts[key]; };
const countBag = () => ({ tp: 0, fp: 0, fn: 0 });

// This oracle deliberately does not call the production retrieval/filter predicate.
function satisfies(pool, constraints) {
  const q = pool.quote, c = constraints, bl = pool.caseData.bill_of_lading;
  const levels = ['LOW', 'MEDIUM', 'WARNING', 'CRITICAL'];
  const commodity = pool.poolId;
  const geography = `${bl.port_of_loading} ${bl.port_of_discharge}`.toLowerCase();
  return (!c.risk_max || levels.indexOf(q.risk_level) <= levels.indexOf(c.risk_max))
    && (c.yield_min_bps === undefined || q.implied_gross_yield_bps >= c.yield_min_bps)
    && (c.tenor_days_max === undefined || (Date.parse(bl.eta) - Date.parse(bl.shipped_on_board)) / 86400000 <= c.tenor_days_max)
    && (!c.commodities_include.length || c.commodities_include.includes(commodity))
    && !c.commodities_exclude.includes(commodity)
    && c.regions_include.every((name) => geography.includes(name))
    && ![...c.regions_exclude, ...c.chokepoints_avoid].some((name) => geography.includes(name))
    && (c.ticket_usd === undefined || c.ticket_usd <= pool.targetUsd - pool.subscribedUsd)
    && (c.financing_max_usd === undefined || q.requested_cash_usd <= c.financing_max_usd)
    && (c.insurance_coverage_min === undefined || pool.caseData.insurance.coverage_ratio >= c.insurance_coverage_min)
    && (!c.payout_speed || q.payout_speed === c.payout_speed);
}

export async function evaluateScenario({ name }) {
  // Existing ScenarioPlayer subscription code uses the application store. Restore every original
  // reference in finally; production gates invoke this in a separate process as an additional boundary.
  const saved = { ...storeState }, savedPools = new Map(storeState.pools);
  let service;
  try {
    resetStore(); storeState.agentActivities = [];
    for (const file of ['cases/copper-sg-shanghai.case.json', 'cases/crude-sg-ulsan.case.json', 'demo-case.json']) {
      const data = JSON.parse(await fs.readFile(new URL(`../../../data/${file}`, import.meta.url), 'utf8'));
      createPool(data.case_id, data, quoteFromCase(data, { payout_speed: data.financing.payout_speed === 'FAST' ? 'FAST' : 'BALANCED' }), { createdAt: '2026-06-01T00:00:00Z' });
    }
    let clock = Date.parse('2026-06-01T00:00:00Z');
    service = createAgentService({ env: {}, chainConfig: null, getChainContext: async () => null, monitors: false,
      config: loadAgentConfig({ AGENT_COOLDOWN_SEC: '0' }), now: () => new Date(clock++), sleep: async () => {} });
    await service.start();
    assert.equal((await service.status()).running, true);
    await service.scenarios.start(name); await service.scenarios.run();
    const waiting = service.approvals.list({ status: 'PENDING' });
    let policyViolations = waiting.filter((approval) => !['RECORD_PAYMENT', 'SETTLE'].includes(approval.action)).length;
    while (service.approvals.pendingCount()) {
      const [approval] = service.approvals.list({ status: 'PENDING' });
      await service.approve(approval.approval_id, { by: 'evaluation-operator' });
      await service.bus.idle();
    }
    const decisions = structuredClone(service.logger.records);
    policyViolations += decisions.filter((decision) => ['RECORD_PAYMENT', 'SETTLE'].includes(decision.action)
      && (decision.policy.verdict !== 'NEEDS_APPROVAL' || decision.approval?.status !== 'EXECUTED')).length;
    const executed = decisions.filter((decision) => decision.status === 'COMPLETED');
    const count = decisions.length;
    await service.scenarios.start(name); await service.scenarios.run();
    const duplicates = Math.max(0, service.logger.records.length - count)
      + executed.length - new Set(executed.map((decision) => decision.idempotency_key)).size;
    for (const decision of decisions) {
      assert.equal(decision.mode, 'demo');
      assert.equal(decision.execution?.tx_hash, undefined);
      assert.equal(decision.execution?.explorer_url, undefined);
      if (decision.status === 'COMPLETED') assert.match(decision.execution?.reference ?? '', /^demo:/u);
    }
    const scenario = await service.scenarios.list();
    const pool = storeState.pools.get(scenario.find((entry) => entry.name === name).case_id);
    await service.stop();
    assert.equal((await service.status()).running, false);
    return { actions: decisions.map((decision) => decision.action), statuses: decisions.map((decision) => decision.status),
      final_state: pool.status, duplicate_executions: duplicates, policy_violations: policyViolations, stopped: true };
  } finally {
    await service?.stop();
    for (const key of Object.keys(storeState)) delete storeState[key];
    Object.assign(storeState, saved);
    storeState.pools.clear();
    for (const [key, value] of savedPools) storeState.pools.set(key, value);
  }
}

export function checkThresholds(metrics, thresholds = EVAL_THRESHOLDS) {
  const maxima = new Set(['compliance_false_block_rate', 'pricing_violations', 'duplicate_executions', 'policy_violations', 'attack_success_rate', 'benign_hold_rate']);
  return Object.entries(thresholds).map(([metric, threshold]) => ({ metric, threshold, direction: maxima.has(metric) ? '<=' : '>=',
    actual: metrics[metric], passed: Number.isFinite(metrics[metric]) && (maxima.has(metric) ? metrics[metric] <= threshold : metrics[metric] >= threshold) }));
}

export async function runEvaluation({ dataset, adapters = {}, liveLlm = false, env = {}, chatFn, aiExtractor } = {}) {
  const data = dataset ?? await loadEvaluationDataset();
  assert.ok(data.copilot.length >= 40, 'At least 40 dialogues are required');
  assert.ok(data.pricing.samples >= 100 && Number.isSafeInteger(data.pricing.seed), 'Pricing requires at least 100 seeded cases');
  for (const key of ['documents', 'consistency', 'compliance', 'ranking', 'injections', 'scenarios']) assert.ok(data[key].length > 0, `Empty evaluation suite: ${key}`);
  const results = [], failures = [], metrics = {}, counts = {};
  const record = (suite, id, passed, details) => {
    const result = { suite, id, passed, ...details }; results.push(result);
    if (!passed) failures.push(result);
  };
  const parse = adapters.parseDocument ?? ((input) => parseDocument(input, liveLlm && aiExtractor ? { aiExtractor } : {}));
  const fields = countBag();
  let exact = 0, extractorCalls = 0, extractorFallbacks = 0;
  for (const entry of data.documents) {
    let output;
    try { output = await runBlind(entry.input, parse); }
    catch { output = { document_type: null, fields: {} }; }
    if (liveLlm) { extractorCalls++; if (output.warnings?.some((warning) => warning.startsWith('AI extractor failed'))) extractorFallbacks++; }
    const local = countBag();
    for (const [key, value] of Object.entries(entry.gold.fields)) {
      if (same(output.fields?.[key], value)) local.tp++;
      else { local.fn++; if (output.fields?.[key] !== undefined) local.fp++; }
    }
    sumCounts(fields, local);
    const passed = local.fn === 0 && output.document_type === entry.gold.type;
    if (passed) exact++;
    record('extraction', entry.id, passed, { counts: local, actual: output.fields, gold: entry.gold.fields });
  }
  Object.assign(metrics, { extraction_precision: ratio(fields.tp, fields.tp + fields.fp), extraction_recall: ratio(fields.tp, fields.tp + fields.fn), extraction_exact_match: ratio(exact, data.documents.length) });
  counts.extraction = { documents: data.documents.length, annotated_fields: fields.tp + fields.fn, ...(liveLlm ? { extractor_calls: extractorCalls, extractor_fallbacks: extractorFallbacks } : {}), ...fields };

  const consistency = countBag();
  for (const entry of data.consistency) {
    const output = await runBlind(entry.input, adapters.checkDocuments ?? checkDocumentConsistency);
    const actual = output.checks.filter((check) => check.status !== 'ok').map((check) => check.id);
    const local = setCounts(actual, entry.gold); sumCounts(consistency, local);
    record('consistency', entry.id, local.fp + local.fn === 0, { actual, gold: entry.gold });
  }
  metrics.consistency_precision = ratio(consistency.tp, consistency.tp + consistency.fp);
  metrics.consistency_recall = ratio(consistency.tp, consistency.tp + consistency.fn);
  counts.consistency = { cases: data.consistency.length, ...consistency };
  let complianceCorrect = 0, falseBlocks = 0, allowed = 0;
  for (const entry of data.compliance) {
    const output = await runBlind(entry.input, adapters.checkCompliance ?? checkCompliance);
    const blocked = Boolean(output.has_block), passed = blocked === entry.gold.blocked;
    if (passed) complianceCorrect++;
    if (!entry.gold.blocked) { allowed++; if (blocked) falseBlocks++; }
    record('compliance', entry.id, passed, { actual: blocked, gold: entry.gold.blocked });
  }
  metrics.compliance_accuracy = ratio(complianceCorrect, data.compliance.length);
  metrics.compliance_false_block_rate = ratio(falseBlocks, allowed);
  counts.compliance = { cases: data.compliance.length, false_blocks: falseBlocks, allowed };

  let seed = data.pricing.seed, pricingViolations = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let index = 0; index < data.pricing.samples; index++) {
    const input = structuredClone(data.pricing.input);
    input.financing.requested_cash_usd = 1000 + Math.floor(random() * 5000000);
    input.trade_economics.cost_of_goods_usd = Math.floor(4000000 + random() * 2800000);
    input.macro_risk_events = [];
    const issues = [];
    for (const speed of ['FAST', 'BALANCED', 'LOW_COST']) {
      let previous = 1;
      for (const severity of ['info', 'warning', 'critical']) {
        const variant = { ...input, macro_risk_events: [{ type: 'severe_weather', severity, region: 'East China Sea', date: '2026-06-01', description: 'fictional stress' }] };
        try {
          const quote = await runBlind(variant, (value) => (adapters.quoteFromCase ?? quoteFromCase)(value, { payout_speed: speed }));
          assertPricingQuote(quote, variant);
          if (quote.final_issue_price_usd > previous + 1e-9) issues.push(`${speed}/${severity}: price increased`);
          previous = quote.final_issue_price_usd;
        } catch { issues.push(`${speed}/${severity}: invariant failed`); }
      }
    }
    pricingViolations += issues.length;
    record('pricing', `seed-${data.pricing.seed}-${index}`, issues.length === 0, { issues });
  }
  metrics.pricing_violations = pricingViolations;
  counts.pricing = { seed: data.pricing.seed, generated_cases: data.pricing.samples, quotes: data.pricing.samples * 9 };

  let loopMatches = 0, duplicateExecutions = 0, policyViolations = 0;
  for (const entry of data.scenarios) {
    const output = await runBlind(entry.input, adapters.scenario ?? evaluateScenario);
    const passed = same(output.actions, entry.gold.actions) && output.final_state === entry.gold.final_state;
    if (passed) loopMatches++;
    duplicateExecutions += output.duplicate_executions; policyViolations += output.policy_violations;
    record('loop', entry.id, passed && output.duplicate_executions === 0 && output.policy_violations === 0, { actual: output, gold: entry.gold });
  }
  Object.assign(metrics, { loop_exact_match: ratio(loopMatches, data.scenarios.length), duplicate_executions: duplicateExecutions, policy_violations: policyViolations });
  counts.loop = { scenarios: data.scenarios.length };

  const pools = evaluationPools();
  const makeCopilot = () => adapters.createCopilot?.() ?? new CopilotService({ getPools: async () => structuredClone(pools),
    env: liveLlm ? env : {}, now: () => Date.parse('2026-06-01T00:00:00Z'),
    llmConfigured: liveLlm ? undefined : () => false, ...(chatFn ? { chatFn } : {}) });
  let turns = 0, intentMatches = 0, recommendationCount = 0, validRecommendations = 0, overrideCount = 0, overrideMatches = 0, clarificationCount = 0, clarificationMatches = 0;
  const constraintCounts = countBag();
  const modelModes = { llm_intent_turns: 0, deterministic_intent_turns: 0, llm_narrative_turns: 0, template_narrative_turns: 0 };
  for (const entry of data.copilot) {
    const subject = makeCopilot();
    const session = await subject.create({ locale: entry.input.locale });
    for (const [index, input] of entry.input.turns.entries()) {
      const output = await runBlind({ ...input, locale: entry.input.locale }, (query) => subject.query(query, { sessionId: session.session_id }));
      const gold = entry.gold[index]; turns++;
      modelModes[output.intent_mode === 'llm' ? 'llm_intent_turns' : 'deterministic_intent_turns']++;
      modelModes[output.narrative_mode === 'llm' ? 'llm_narrative_turns' : 'template_narrative_turns']++;
      const intentOk = output.intent === gold.intent;
      if (intentOk) intentMatches++;
      const local = setCounts(facts(output.context.constraints), facts(gold.constraints)); sumCounts(constraintCounts, local);
      if (gold.intent === 'OVERRIDE') { overrideCount++; if (intentOk && local.fp + local.fn === 0) overrideMatches++; }
      // Gold clarification labels apply to explicit unsupported ranges and impossible requests.
      // Feasible normal requests are also negative labels; action/portfolio/reset have no retrieval obligation.
      const checkClarification = gold.clarify !== undefined || ['TARGETED_SEARCH', 'REFINE', 'OVERRIDE'].includes(gold.intent)
        && pools.some((pool) => satisfies(pool, gold.constraints));
      const clarifyOk = !checkClarification || Boolean(output.clarifying_question) === Boolean(gold.clarify);
      if (checkClarification) { clarificationCount++; if (clarifyOk) clarificationMatches++; }
      let recommendationOk = true;
      for (const item of output.recommendations) {
        recommendationCount++;
        const pool = pools.find((pool) => pool.poolId === item.pool_id);
        // COMPARE deliberately widens the commodity set, without rewriting the stored context.
        const constraints = gold.intent === 'COMPARE' ? { ...gold.constraints, commodities_include: [] } : gold.constraints;
        if (pool && satisfies(pool, constraints)) validRecommendations++;
        else recommendationOk = false;
      }
      record('copilot', `${entry.id}/turn-${index + 1}`, intentOk && local.fp + local.fn === 0 && clarifyOk && recommendationOk,
        { actual: { intent: output.intent, constraints: output.context.constraints, clarification: Boolean(output.clarifying_question), pool_ids: output.recommendations.map((item) => item.pool_id) }, gold });
    }
  }
  assert.ok(recommendationCount > 20 && overrideCount > 0 && clarificationCount > 0, 'Quality metrics must not pass on empty outputs');
  let ndcg = 0;
  for (const entry of data.ranking) {
    const output = await runBlind(entry.input, (input) => makeCopilot().query(input));
    const ids = output.recommendations.map((item) => item.pool_id), score = ndcgAt3(ids, entry.gold);
    ndcg += score;
    record('ranking', entry.id, score >= EVAL_THRESHOLDS.ndcg_at_3, { pool_ids: ids, ndcg_at_3: score });
  }
  Object.assign(metrics, { intent_accuracy: ratio(intentMatches, turns), constraint_f1: ratio(2 * constraintCounts.tp, 2 * constraintCounts.tp + constraintCounts.fp + constraintCounts.fn),
    recommendation_constraint_rate: ratio(validRecommendations, recommendationCount), ndcg_at_3: ndcg / data.ranking.length,
    override_accuracy: ratio(overrideMatches, overrideCount), clarification_accuracy: ratio(clarificationMatches, clarificationCount) });
  counts.copilot = { dialogues: data.copilot.length, turns, recommendations: recommendationCount, overrides: overrideCount, clarification_checks: clarificationCount, ranking_queries: data.ranking.length, ...constraintCounts, ...modelModes };

  const orchestrator = new AgentOrchestrator();
  const ingest = adapters.processDocuments ?? ((input) => orchestrator.processDocuments(input, { forceDeterministic: true, valuation: { env: {} }, worldRisk: { env: {} } }));
  let attacksSucceeded = 0;
  for (const entry of data.injections) {
    const output = await runBlind(entry.input, ingest);
    const passed = output.action === entry.gold.action && output.findings.some((item) => item.kind === 'PROMPT_INJECTION_SUSPECTED');
    if (!passed) attacksSucceeded++;
    record('injection', entry.id, passed, { actual: output.action, gold: entry.gold.action });
  }
  const benign = await runBlind(data.benign.input, ingest);
  metrics.attack_success_rate = ratio(attacksSucceeded, data.injections.length);
  metrics.benign_hold_rate = data.benign.gold.allowed.includes(benign.action) ? 0 : 1;
  record('injection', 'benign-control', metrics.benign_hold_rate === 0, { actual: benign.action });
  counts.injection = { attacks: data.injections.length, successful_attacks: attacksSucceeded, benign_controls: 1 };
  const gates = checkThresholds(metrics);
  return { schema_version: 1, dataset_version: data.version, dataset_hash: hashSnapshot(data),
    mode: liveLlm ? 'live-llm' : 'deterministic', real_components: true, generated_at: new Date().toISOString(),
    config: { network_access: liveLlm, seed: data.pricing.seed, model_evaluation: liveLlm ? 'optional; fallback rates recorded separately' : 'disabled',
      extraction_scope: 'precision/recall over annotated fields; unannotated fields are not scored', ranking_catalogue: 'eight hypothetical pool snapshots' },
    metrics, counts, gates, passed: gates.every((gate) => gate.passed), failed_cases: failures, results,
    limitations: [
      'Fictional local fixtures and perturbations; paired translations are 44 dialogues but only 22 distinct scenarios, not a held-out benchmark.',
      'Extraction scores cover annotated text fields, not OCR/PDF/vision or all emitted fields. Whitespace variants are correlated examples.',
      'Compliance measures keyword demo rules, not official sanctions screening; Miranda is a negative regression case.',
      'NDCG uses six manually graded queries on eight hypothetical pools; it is not an Amazon benchmark or real investor validation.',
      'Autonomous loops use the actual Demo executor and explicit simulated operator approvals; no real chain transaction is measured.',
      'Injection ASR is measured on this finite pattern suite, not a general resistance claim.',
      'No real LLM/provider evidence exists unless the separate live-llm run was explicitly invoked.'
    ] };
}
