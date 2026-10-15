// AI-13 — AgentBL deterministic Agent orchestrator.
//
// Pipeline: document parsing -> cross-document checks -> cargo valuation ->
// three-speed pricing -> recommendation -> optional on-chain execution.
//
// `processEbl` is the original structured-case pipeline. `processDocuments` is the ingest pipeline the
// agent runtime runs for uploads (docs/agent-implementation-plan.md WP2.4): it adds injection
// screening, compliance, world risk and exporter constraints, times every step and can decide to hold
// or reject instead of opening.

import { assessFreshness, evidenceMetadata } from './runtime/freshness.js';
import { checkCompliance } from './complianceChecker.js';
import { checkDocumentConsistency } from './documentConsistency.js';
import { DecisionLogger, createDecisionId, hashSnapshot } from './decisionLogger.js';
import { DocumentParseError, extractDocumentInput, mergeParsedDocuments, parseDocument, parseDocuments } from './documentParser.js';
import { screenDocuments } from './ingest/injectionScreen.js';
import { runValuationAgent } from './valuationAgent.js';
import { assessWorldRisk } from './worldRiskAgent.js';
import { assertPricingQuote } from '../core/pricingSchema.js';
import { compareSpeeds } from '../core/pricingEngine.js';
import { mergeWorldRiskIntoCase } from '../core/worldRiskPricing.js';

const OPEN_ACTIONS = new Set(['OPEN_OFFERING', 'OPEN_WITH_WARNING']);
/** The agent runtime's opening action for each pricing-engine action that may open an offering. */
const OPEN_FOR = { OPEN_OFFERING: 'OPEN', OPEN_WITH_WARNING: 'OPEN_WITH_WARNING' };

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateCaseForPricing(caseData) {
  const errors = [];
  if (!isRecord(caseData)) errors.push('case_data must be an object');
  if (!caseData?.case_id) errors.push('case_id is required');
  if (!caseData?.bill_of_lading?.bl_id) errors.push('bill_of_lading.bl_id is required');
  if (!caseData?.financing) errors.push('financing is required');
  if (!Number.isFinite(Number(caseData?.financing?.requested_cash_usd))) errors.push('financing.requested_cash_usd is required');
  if (!Number.isFinite(Number(caseData?.commercial_invoice?.total_amount_usd ?? caseData?.bill_of_lading?.declared_value_usd))) {
    errors.push('invoice or declared cargo value is required');
  }
  if (errors.length > 0) throw new TypeError(`Case cannot be priced: ${errors.join('; ')}`);
}

function enrichCaseWithValuation(caseData, valuation) {
  const live = valuation.live_market ?? {};
  const landed = Number(live.landed_price_usd_per_mt);
  const marketPrice = Number(live.price_usd_per_mt);
  const premium = Number(live.regional_premium_usd_per_mt);
  return {
    ...caseData,
    market: {
      ...(caseData.market ?? {}),
      ...(Number.isFinite(marketPrice) ? { reference_price_usd_per_mt: marketPrice, current_price_usd_per_mt: marketPrice } : {}),
      ...(Number.isFinite(premium) ? { regional_premium_usd_per_mt: premium } : {}),
      ...(Number.isFinite(landed) ? { landed_price_usd_per_mt: landed } : {})
    },
    ai_valuation: valuation
  };
}

function chooseAction({ parsing, documents, recommended, preferences }) {
  if (parsing?.requires_human_review) {
    return { action: 'PAUSE_OFFERING', reason: 'Document extraction confidence is below the auto-execution threshold.' };
  }
  if (documents.has_critical) {
    return { action: 'PAUSE_OFFERING', reason: 'Critical cross-document inconsistency requires human review.' };
  }

  if (preferences && typeof preferences.min_acceptable_issue_price === 'number') {
    if (recommended.final_issue_price_usd < preferences.min_acceptable_issue_price) {
      return {
        action: 'PAUSE_OFFERING',
        reason: `Final issue price USD ${recommended.final_issue_price_usd.toFixed(2)} is below the exporter's minimum acceptable price of USD ${preferences.min_acceptable_issue_price.toFixed(2)}.`
      };
    }
  }

  return { action: recommended.pricing_action, reason: recommended.investor_explanation };
}

function contractAction(action, quote) {
  const common = {
    case_id: quote.case_id,
    ebl_id: quote.bl_id,
    quote_hash: quote.quote_hash,
    evidence_hash: quote.evidence_hash
  };
  if (OPEN_ACTIONS.has(action)) {
    return {
      method: 'createOffering',
      args: {
        ...common,
        token_supply: quote.recommended_token_supply,
        issue_price_usd: quote.final_issue_price_usd,
        target_redemption_value_usd: quote.target_redemption_value_usd
      }
    };
  }
  if (action === 'REPRICE_DOWN') return { method: 'repriceOffering', args: { ...common, issue_price_usd: quote.final_issue_price_usd } };
  if (action === 'FREEZE_POOL') return { method: 'freezeOffering', args: common };
  if (action === 'TRIGGER_LIQUIDATION') return { method: 'liquidateOffering', args: common };
  return { method: 'pauseOffering', args: common };
}

function buildSummary(action, documentReport, valuation, quote) {
  const documentSentence = documentReport.ok
    ? 'Trade documents agree on the material financing fields.'
    : `${documentReport.issues.length} document issue(s) produced ${documentReport.penalty_bps} bps of risk penalty.`;
  const value = valuation.valuation?.ai_verified_collateral_value_usd ?? quote.ai_verified_collateral_value_usd;
  return `${documentSentence} Verified collateral is USD ${Math.round(value)}. `
    + `The recommended ${quote.payout_speed} quote is USD ${quote.final_issue_price_usd} with ${quote.risk_score_bps} bps risk. `
    + `Decision: ${action}.`;
}

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Financing defaults for a case that arrives as documents only (no structured template). */
function defaultFinancing(caseData, preferences) {
  const goodsValue = Number(caseData.commercial_invoice?.total_amount_usd ?? caseData.bill_of_lading?.declared_value_usd);
  const requested = preferences?.target_financing_amount
    ?? (Number.isFinite(goodsValue) ? Math.max(1000, Math.round((goodsValue * 0.6) / 1000) * 1000) : undefined);
  return {
    requested_cash_usd: requested,
    payout_speed: preferences?.payout_speed_preference ?? 'BALANCED',
    target_redemption_value_usd: 1,
    redemption_coverage_limit: 0.9,
    max_ltv: 0.9,
    currency: 'USDC'
  };
}

/** Keep world-risk events the case does not already carry (same type and region). */
function newWorldEvents(caseData, events) {
  const known = new Set((caseData.macro_risk_events ?? []).map((event) => `${event.type}|${event.region}`));
  return events.filter((event) => !known.has(`${event.type}|${event.region}`));
}

export class AgentOrchestrator {
  constructor(options = {}) {
    this.parseDocuments = options.parseDocuments ?? parseDocuments;
    this.checkDocuments = options.checkDocuments ?? checkDocumentConsistency;
    this.runValuation = options.runValuation ?? runValuationAgent;
    this.compareSpeeds = options.compareSpeeds ?? compareSpeeds;
    this.assessWorldRisk = options.assessWorldRisk ?? assessWorldRisk;
    this.checkCompliance = options.checkCompliance ?? checkCompliance;
    this.logger = options.logger ?? null;
  }

  /**
   * The ingest pipeline (docs/agent-implementation-plan.md WP2.4): uploaded documents in, one opening
   * proposal out. Every step is timed and reported through `onStep`; none of them can change the result
   * by what the document TEXT asks for -- text is parsed, screened, and priced by the engine.
   *
   * Steps: parse → injection screen → consistency → compliance → valuation → world risk → three-speed
   * pricing → exporter constraints → decision.
   *
   * @param {object} input
   * @param {string} input.case_id
   * @param {Array<{name:string, kind:string, text:string|null, sha256:string, mime_type?:string}>} input.documents
   * @param {object} [input.template_case]          an existing case the documents refine
   * @param {object} [input.exporter_preferences]
   * @param {{onStep?: Function, forceDeterministic?: boolean, valuation?: object, worldRisk?: object, now?: ()=>number}} [options]
   */
  async processDocuments(input, options = {}) {
    const now = options.now ?? (() => Date.now());
    const pipeline = [];
    const findings = [];
    input = { ...input, documents: input.documents.map((document) => ({ ...document,
      ...evidenceMetadata(document, { now: now(), mode: 'fixture' }) })) };
    const documentStates = input.documents.map((document) => assessFreshness(document, now()));
    const firstDocument = [...documentStates].sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))[0] ?? assessFreshness(evidenceMetadata({}, { now: now() }), now());
    const documentFreshness = { ...firstDocument, fresh: documentStates.every((state) => state.fresh),
      source_status: documentStates.every((state) => state.fresh) ? firstDocument.source_status : 'stale' };
    if (!documentFreshness.fresh) findings.push({ kind: 'STALE_EVIDENCE', severity: 'high', detail: 'Uploaded evidence is expired, future-dated or unavailable; obtain a fresh verified document.' });
    const preferences = input.exporter_preferences ?? undefined;

    const run = async (step, fn) => {
      const started = now();
      let outcome;
      try {
        outcome = await fn();
      } catch (error) {
        pipeline.push({ step, status: 'FAIL', duration_ms: Math.max(0, now() - started) });
        await options.onStep?.(pipeline.at(-1));
        throw error;
      }
      const entry = {
        step,
        status: outcome?.status ?? 'PASS',
        duration_ms: Math.max(0, now() - started),
        ...(outcome?.provider ? { provider: outcome.provider } : {}),
        ...(outcome?.model_usage?.length ? { model_usage: outcome.model_usage } : {})
      };
      pipeline.push(entry);
      await options.onStep?.(entry);
      return outcome?.value;
    };

    const textDocuments = [];

    let extraction = [];
    const summaryOf = (action, reasoning, extra = {}) => ({
      action,
      reasoning_summary: reasoning,
      findings,
      pipeline,
      documents: input.documents.map(({ name, kind, sha256, mime_type: mimeType, observed_at, expires_at, source_status }) => ({ name, kind, sha256, mime_type: mimeType, observed_at, expires_at, source_status })),
      extraction,
      ...extra
    });
    const holdWithoutCase = (reasoning) => {
      const snapshot = { case_id: input.case_id, document_hashes: input.documents.map((document) => document.sha256).sort(), parsed: false };
      return summaryOf('HOLD_FOR_REVIEW', reasoning, {
        case_data: null,
        quote: null,
        freshness: documentFreshness,
        input_snapshot: snapshot,
        evidence_hash: hashSnapshot(snapshot),
        replay: { schema: 'agent-replay-v1', kind: 'ingest', snapshot: structuredClone(snapshot), no_quote: true, blocked: false }
      });
    };

    // 1. parse
    const parsing = await run('document_parse', async () => {
      const extracted = [], images = [];
      const extractionFailure = (document, error) => {
        findings.push({ kind: error.code === 'PROMPT_INJECTION_SUSPECTED' ? error.code
          : error.code === 'OCR_REQUIRED' ? 'OCR_REQUIRED' : 'DOCUMENT_UNPARSEABLE',
        severity: error.code === 'PROMPT_INJECTION_SUSPECTED' ? 'high' : 'warning', code: error.code,
        detail: `${document.name}: ${error.message}` });
      };
      for (const document of input.documents) {
        if (document.kind === 'image') { images.push(document); continue; }
        try {
          const resolved = await extractDocumentInput(document, options.parser);
          extracted.push(resolved);
          textDocuments.push({ name: document.name, text: `${document.name}\n${resolved.text}` });
        } catch (error) {
          if (!(error instanceof DocumentParseError)) throw error;
          extractionFailure(document, error);
        }
      }
      // Screen the WHOLE readable bundle before the first model request, including later documents.
      const preScreen = screenDocuments([...textDocuments, ...images.map((document) => ({ name: document.name, text: document.name }))]);
      if (preScreen.suspicious) findings.push(...preScreen.findings);
      for (const document of images) {
        if (preScreen.suspicious) {
          findings.push({ kind: 'OCR_REQUIRED', severity: 'warning', detail: `${document.name}: vision was blocked because the bundle contains suspected instructions.` });
          continue;
        }
        try {
          const resolved = await extractDocumentInput(document, options.parser);
          extracted.push(resolved);
          textDocuments.push({ name: document.name, text: resolved.text });
        } catch (error) {
          if (!(error instanceof DocumentParseError)) throw error;
          extractionFailure(document, error);
        }
      }
      const readable = [];
      const anySuspicion = preScreen.suspicious || findings.some((item) => item.kind === 'PROMPT_INJECTION_SUSPECTED');
      for (const resolved of extracted) {
        try {
          const document = await parseDocument(null, { ...(options.parser ?? {}), extracted: resolved,
            ...(anySuspicion ? { aiExtractor: undefined } : {}) });
          findings.push(...document.findings);
          readable.push(document);
        } catch (error) {
          if (!(error instanceof DocumentParseError)) throw error;
          extractionFailure({ name: resolved.filename }, error);
        }
      }
      if (readable.length === 0) return { status: 'REVIEW', value: null };
      const parsed = mergeParsedDocuments(readable, { templateCase: input.template_case ?? {} });
      return { status: parsed.requires_human_review || findings.length > 0 ? 'REVIEW' : 'PASS', value: parsed };
    });
    if (!parsing) {
      return holdWithoutCase('No uploaded document could be read as an eBL, invoice or insurance policy; a person needs to look at the upload.');
    }
    const visibleFields = new Set(['bl_id', 'bl_no', 'invoice_no', 'invoice_date', 'incoterms', 'carrier', 'shipper', 'consignee', 'document_hash', 'policy_no', 'provider', 'title_ref', 'cargo', 'quantity_mt', 'quantity_bbl', 'declared_value_usd', 'total_amount_usd', 'unit_price_usd_per_mt', 'unit_price_usd_per_bbl', 'currency', 'vessel', 'vessel_imo', 'voyage_no', 'port_of_loading', 'port_of_discharge', 'eta', 'issue_date', 'coverage_ratio', 'insured_value_usd', 'expires_at', 'receipt_no', 'warehouse', 'storage_date', 'pickup_deadline', 'hs_code', 'declared_value_cny', 'total_amount_cny', 'unit_price_cny_per_mt']);
    extraction = parsing.documents.map((document) => ({
      document_type: document.document_type, source: document.source,
      confidence: document.confidence, requires_human_review: document.requires_human_review,
      missing_fields: document.missing_fields,
      fields: Object.fromEntries(Object.entries(document.fields).filter(([name]) => visibleFields.has(name))),
      provenance: Object.fromEntries(Object.entries(document.provenance).filter(([name]) => visibleFields.has(name))
        .map(([name, { line, page, method, confidence }]) => [name, { line, ...(page ? { page } : {}), method, confidence }]))
    }));

    // 2. injection screen
    const screen = await run('injection_screen', async () => {
      const result = screenDocuments(textDocuments.map((document) => ({ name: document.name, text: document.text })));
      for (const item of result.findings) if (!findings.some((existing) => existing.evidence === item.evidence && existing.detail === item.detail)) findings.push(item);
      result.suspicious ||= findings.some((item) => item.kind === 'PROMPT_INJECTION_SUSPECTED');
      return { status: result.suspicious ? 'REVIEW' : 'PASS', value: result };
    });

    let caseData = { ...parsing.case_data, case_id: input.case_id };
    let compliance;
    const runCompliance = async () => run('compliance', async () => {
      const result = await this.checkCompliance(caseData, { documents: parsing.documents });
      for (const check of result.checks) {
        if (check.status === 'BLOCK' || check.status === 'block') {
          findings.push({ kind: 'COMPLIANCE_BLOCK', severity: 'critical', code: check.code, detail: `${check.label}: ${check.detail}`, evidence: check.evidence });
        } else if (check.status === 'REVIEW' || check.status === 'warning') {
          findings.push({ kind: 'COMPLIANCE_REVIEW', severity: 'high', code: check.code, detail: `${check.label}: ${check.detail}`, evidence: check.evidence });
        }
      }
      return { status: result.has_block ? 'FAIL' : result.has_warning ? 'REVIEW' : 'PASS', value: result };
    });
    if (caseData.commercial_invoice?.currency && caseData.commercial_invoice.currency !== 'USD') {
      findings.push({ kind: 'CURRENCY_REVIEW_REQUIRED', severity: 'high', detail: 'The uploaded invoice is not in USD. No currency conversion or USD financing is inferred.' });
      // Run warehouse/invoice checks even though this bundle cannot be priced in USD.
      await run('document_consistency', async () => {
        const report = this.checkDocuments(caseData);
        findings.push(...report.checks.filter((check) => check.status !== 'ok').map((check) => ({ kind: 'DOCUMENT_MISMATCH', severity: check.status === 'critical' ? 'high' : 'warning', detail: `${check.label}: ${check.detail}` })));
        return { status: report.has_critical ? 'FAIL' : report.ok ? 'PASS' : 'WARN', value: report };
      });
      compliance = await runCompliance();
      const result = holdWithoutCase('The warehouse and invoice fields were extracted; currency and financing need human review.');
      result.compliance = compliance;
      result.input_snapshot.compliance_report_hash = hashSnapshot(compliance);
      result.evidence_hash = hashSnapshot(result.input_snapshot);
      if (compliance.has_block) {
        result.action = 'REJECT'; result.reasoning_summary = 'Demo compliance screening blocked this document bundle.';
      }
      result.replay.snapshot = structuredClone(result.input_snapshot);
      result.replay.blocked = result.action === 'REJECT';
      return result;
    }
    if (!caseData.financing) caseData.financing = defaultFinancing(caseData, preferences);
    try {
      validateCaseForPricing(caseData);
    } catch (error) {
      findings.push({ kind: 'CASE_INCOMPLETE', severity: 'high', detail: error.message });
      compliance = await runCompliance();
      const result = holdWithoutCase(`The documents did not contain enough to price the case: ${error.message}`);
      result.compliance = compliance;
      result.input_snapshot.compliance_report_hash = hashSnapshot(compliance);
      result.evidence_hash = hashSnapshot(result.input_snapshot);
      if (compliance.has_block) { result.action = 'REJECT'; result.reasoning_summary = 'Demo compliance screening blocked this document bundle.'; }
      result.replay.snapshot = structuredClone(result.input_snapshot);
      result.replay.blocked = result.action === 'REJECT';
      return result;
    }

    // 3. consistency
    const documentReport = await run('document_consistency', async () => {
      const report = this.checkDocuments(caseData);
      for (const check of report.checks.filter((item) => item.status !== 'ok')) {
        findings.push({ kind: 'DOCUMENT_MISMATCH', severity: check.status === 'critical' ? 'high' : 'warning', detail: `${check.label}: ${check.detail}` });
      }
      return { status: report.has_critical ? 'FAIL' : report.ok ? 'PASS' : 'WARN', value: report };
    });

    // 4. Versioned demo screening. Every unresolved screening check requires review.
    compliance = await runCompliance();

    // 5. valuation
    const valuation = await run('cargo_valuation', async () => {
      const report = await this.runValuation(caseData, {
        ...(options.valuation ?? {}),
        forceDeterministic: screen.suspicious ? true : options.forceDeterministic ?? true
      });
      return { status: 'PASS', provider: report.provider, model_usage: report.model_usage, value: report };
    });
    caseData = enrichCaseWithValuation(caseData, valuation);

    // 6. world risk (offline fixtures unless xAPI is configured)
    const worldRisk = await run('world_risk', async () => {
      const assessment = await this.assessWorldRisk(caseData, { ...(options.worldRisk ?? {}), now, forceFallback: screen.suspicious ? true : options.forceDeterministic ?? true });
      // The offline fixture is one generic feed for every cargo, not evidence about THIS cargo: it is
      // recorded but never folded into the price. Only live signals change the quote.
      const metadata = evidenceMetadata(assessment, { now: now(), mode: assessment.live ? 'live' : 'fixture' });
      const freshness = assessFreshness(metadata, now());
      assessment.freshness = freshness;
      if (assessment.live && !freshness.fresh) findings.push({ kind: 'STALE_EVIDENCE', severity: 'high', detail: 'World-risk evidence is stale or unavailable; fresh evidence is required.' });
      const fresh = assessment.live === true && freshness.fresh ? newWorldEvents(caseData, assessment.events ?? []) : [];
      const status = fresh.some((event) => event.severity === 'critical') ? 'WARN' : 'PASS';
      return { status, provider: assessment.provider, value: { assessment, fresh } };
    });
    caseData = mergeWorldRiskIntoCase(caseData, worldRisk.fresh);
    if (worldRisk.fresh.length > 0) {
      findings.push({
        kind: 'WORLD_RISK',
        severity: worldRisk.fresh.some((event) => event.severity === 'critical') ? 'high' : 'warning',
        detail: `${worldRisk.fresh.length} live world-risk signal(s) were folded into pricing (${worldRisk.assessment.provider})`,
        evidence: worldRisk.assessment.evidence_hash
      });
    } else if ((worldRisk.assessment.events ?? []).length > 0) {
      findings.push({
        kind: 'WORLD_RISK',
        severity: 'info',
        detail: `${worldRisk.assessment.events.length} signal(s) came from ${worldRisk.assessment.provider}, which is not live evidence about this cargo, so they were recorded but not priced.`,
        evidence: worldRisk.assessment.evidence_hash
      });
    }

    // 7. three-speed pricing. A case the pricing engine cannot price (a figure the documents did not
    //    carry) is a reason to ask a person, not an error to retry.
    const comparison = await run('three_speed_pricing', async () => {
      try {
        const result = this.compareSpeeds(caseData, {
          requested_cash_usd: preferences?.target_financing_amount ?? caseData.financing.requested_cash_usd
        });
        for (const quote of result.quotes) assertPricingQuote(quote, caseData);
        return { status: 'PASS', value: result };
      } catch (error) {
        if (!/validation failed|must be|cannot be priced/iu.test(String(error?.message))) throw error;
        findings.push({ kind: 'CASE_INCOMPLETE', severity: 'high', detail: String(error.message).slice(0, 300) });
        return { status: 'FAIL', value: null };
      }
    });
    if (!comparison) {
      return holdWithoutCase('The documents did not carry enough figures for the pricing engine; a person needs to complete them.');
    }

    // 8. exporter constraints
    const chosen = await run('exporter_constraints', async () => {
      const floor = Number(preferences?.min_acceptable_issue_price);
      const preferred = comparison.quotes.find((quote) => quote.payout_speed === preferences?.payout_speed_preference);
      let quote = preferred ?? comparison.recommended_quote;
      if (Number.isFinite(floor) && quote.final_issue_price_usd < floor) {
        const alternative = [...comparison.quotes]
          .filter((candidate) => candidate.final_issue_price_usd >= floor)
          .sort((a, b) => b.final_issue_price_usd - a.final_issue_price_usd)[0];
        if (!alternative) {
          const best = Math.max(...comparison.quotes.map((candidate) => candidate.final_issue_price_usd));
          findings.push({
            kind: 'EXPORTER_FLOOR',
            severity: 'high',
            detail: `No payout speed reaches the exporter's minimum issue price of ${floor.toFixed(2)} (best ${best.toFixed(2)}).`
          });
          return { status: 'FAIL', value: { quote, below_floor: true } };
        }
        findings.push({ kind: 'EXPORTER_PREFERENCE', severity: 'info', detail: `Moved from ${quote.payout_speed} to ${alternative.payout_speed} to stay above the exporter's minimum price.` });
        quote = alternative;
      }
      return { status: 'PASS', value: { quote, below_floor: false } };
    });
    const recommended = chosen.quote;

    // 9. decision
    const decision = await run('decision', async () => {
      const kinds = new Set(findings.map((finding) => finding.kind));
      let action;
      let reason;
      if (kinds.has('COMPLIANCE_BLOCK')) {
        action = 'REJECT';
        reason = 'Compliance screening blocked this case.';
      } else if (kinds.has('PROMPT_INJECTION_SUSPECTED')) {
        action = 'HOLD_FOR_REVIEW';
        reason = 'The documents contain text that reads like instructions to an automated system.';
      } else if (kinds.has('STALE_EVIDENCE')) {
        action = 'HOLD_FOR_REVIEW'; reason = 'World-risk evidence is stale; refresh it before opening.';
      } else if (parsing.requires_human_review || kinds.has('OCR_REQUIRED') || kinds.has('DOCUMENT_UNPARSEABLE')) {
        action = 'HOLD_FOR_REVIEW';
        reason = 'Document extraction is incomplete or low-confidence.';
      } else if (documentReport.has_critical) {
        action = 'HOLD_FOR_REVIEW';
        reason = 'A critical cross-document inconsistency needs a person.';
      } else if (kinds.has('COMPLIANCE_REVIEW')) {
        action = 'HOLD_FOR_REVIEW';
        reason = 'Compliance screening asks for a manual check.';
      } else if (chosen.below_floor) {
        action = 'HOLD_FOR_REVIEW';
        reason = "Every payout speed prices below the exporter's minimum.";
      } else if (OPEN_FOR[recommended.pricing_action]) {
        action = OPEN_FOR[recommended.pricing_action];
        reason = recommended.investor_explanation;
      } else {
        action = 'HOLD_FOR_REVIEW';
        findings.push({ kind: 'RISK_TOO_HIGH', severity: 'high', detail: `The pricing engine's action for this cargo is ${recommended.pricing_action}; a new offering is not opened on that.` });
        reason = `The pricing engine would not open this cargo (${recommended.pricing_action}).`;
      }
      return { status: action, value: { action, reason } };
    });

    const inputSnapshot = {
      case_id: input.case_id,
      bl_id: caseData.bill_of_lading?.bl_id ?? null,
      document_hashes: input.documents.map((document) => document.sha256).sort(),
      parser_requires_review: parsing.requires_human_review,
      document_penalty_bps: documentReport.penalty_bps,
      compliance: compliance.status ?? (compliance.has_block ? 'BLOCK' : compliance.has_warning ? 'REVIEW' : 'CLEAR'),
      compliance_list_version: compliance.list_version ?? null,
      compliance_report_hash: hashSnapshot(compliance),
      injection_suspected: screen.suspicious,
      valuation_hash: hashSnapshot(valuation),
      world_risk_hash: worldRisk.assessment.evidence_hash,
      exporter_preferences: preferences ?? null,
      quote_hash: recommended.quote_hash
    };
    const replay = { schema: 'agent-replay-v1', kind: 'ingest', snapshot: structuredClone(inputSnapshot),
      case_data: structuredClone(caseData), pricing_options: { payout_speed: recommended.payout_speed,
        requested_cash_usd: preferences?.target_financing_amount ?? caseData.financing.requested_cash_usd },
      findings: structuredClone(findings), parser_review: parsing.requires_human_review, below_floor: chosen.below_floor };
    // The full valuation report (tool trace, comparables) is kept on the case file, not in the decision.
    const { ai_valuation: aiValuation, ...caseForStorage } = caseData;
    const documentSentence = documentReport.ok
      ? 'Trade documents agree on the material financing fields.'
      : `${documentReport.issues.length} document issue(s) produced ${documentReport.penalty_bps} bps of risk penalty.`;
    const collateral = Math.round(valuation.valuation?.ai_verified_collateral_value_usd ?? recommended.ai_verified_collateral_value_usd);
    const reasoning = `${documentSentence} Verified collateral is USD ${collateral}. `
      + `The ${recommended.payout_speed} quote is USD ${round(recommended.final_issue_price_usd, 4)} with ${recommended.risk_score_bps} bps risk. `
      + `${decision.action}: ${decision.reason}`;

    return summaryOf(decision.action, reasoning, {
      case_data: caseForStorage,
      replay,
      freshness: documentFreshness.fresh ? worldRisk.assessment.freshness : documentFreshness,
      valuation: aiValuation,
      quote: recommended,
      comparison,
      document_report: documentReport,
      compliance,
      contract_action: contractAction(decision.action === 'OPEN_WITH_WARNING' ? 'OPEN_WITH_WARNING' : 'OPEN_OFFERING', recommended),
      input_snapshot: inputSnapshot,
      evidence_hash: recommended.evidence_hash,
      quote_hash: recommended.quote_hash
    });
  }

  /**
   * @param {object} input structured case, or { case_data/template_case, documents }
   * @param {object} options parser/valuation/execution options
   */
  async processEbl(input, options = {}) {
    const wrapper = input?.documents || input?.case_data || input?.template_case ? input : { case_data: input };
    let parsing = null;
    let caseData = wrapper.case_data ?? wrapper.template_case ?? {};
    if (wrapper.documents) {
      parsing = await this.parseDocuments(wrapper.documents, {
        ...(options.parser ?? {}),
        templateCase: caseData
      });
      caseData = parsing.case_data;
    }
    validateCaseForPricing(caseData);

    const documentReport = this.checkDocuments(caseData);
    const valuation = await this.runValuation(caseData, {
      forceDeterministic: options.forceDeterministic ?? true,
      ...(options.valuation ?? {})
    });
    const pricedCase = enrichCaseWithValuation(caseData, valuation);
    const comparison = this.compareSpeeds(pricedCase, {
      requested_cash_usd: options.exporter_preferences?.target_financing_amount ?? options.requested_cash_usd ?? pricedCase.financing.requested_cash_usd
    });
    for (const quote of comparison.quotes) assertPricingQuote(quote, pricedCase);

    let recommended = comparison.recommended_quote;
    if (options.exporter_preferences?.payout_speed_preference) {
      const preferredQuote = comparison.quotes.find((q) => q.payout_speed === options.exporter_preferences.payout_speed_preference);
      if (preferredQuote) {
        recommended = preferredQuote;
      }
    }

    const selected = chooseAction({ parsing, documents: documentReport, recommended, preferences: options.exporter_preferences });
    const actionPayload = contractAction(selected.action, recommended);
    const inputSnapshot = {
      case_id: pricedCase.case_id,
      bl_id: pricedCase.bill_of_lading.bl_id,
      document_hashes: parsing?.documents.map((document) => document.text_hash)
        ?? [pricedCase.bill_of_lading.document_hash, pricedCase.insurance?.policy_hash].filter(Boolean),
      parser_requires_review: parsing?.requires_human_review ?? false,
      document_penalty_bps: documentReport.penalty_bps,
      valuation_hash: hashSnapshot(valuation),
      quote_hash: recommended.quote_hash
    };
    const decisionCore = {
      case_id: pricedCase.case_id,
      action: selected.action,
      input_snapshot: inputSnapshot,
      evidence_hash: recommended.evidence_hash
    };
    const decisionId = createDecisionId(decisionCore);
    const reasoningSummary = buildSummary(selected.action, documentReport, valuation, recommended);

    const result = {
      decision_id: decisionId,
      case_id: pricedCase.case_id,
      action: selected.action,
      can_auto_execute: OPEN_ACTIONS.has(selected.action) && !parsing?.requires_human_review && !documentReport.has_critical,
      reasoning_summary: reasoningSummary,
      evidence_hash: recommended.evidence_hash,
      quote_hash: recommended.quote_hash,
      input_snapshot: inputSnapshot,
      parsing,
      document_report: documentReport,
      valuation,
      pricing_comparison: comparison,
      recommended_quote: recommended,
      contract_action: actionPayload,
      pipeline: [
        { step: 'document_parse', status: parsing ? (parsing.requires_human_review ? 'REVIEW' : 'PASS') : 'STRUCTURED_INPUT' },
        { step: 'document_consistency', status: documentReport.has_critical ? 'CRITICAL' : documentReport.ok ? 'PASS' : 'WARNING' },
        { step: 'cargo_valuation', status: 'PASS', provider: valuation.provider },
        { step: 'three_speed_pricing', status: 'PASS', recommended: comparison.recommended_payout_speed },
        { step: 'decision', status: selected.action }
      ]
    };

    if (this.logger || options.logger) {
      const logger = options.logger ?? this.logger;
      if (!(logger instanceof DecisionLogger) && typeof logger?.record !== 'function') throw new TypeError('logger must implement record()');
      await logger.record({
        decision_id: decisionId,
        case_id: result.case_id,
        action: result.action,
        reasoning_summary: reasoningSummary,
        evidence_hash: result.evidence_hash,
        input_snapshot: inputSnapshot,
        decision: { contract_action: actionPayload, quote_hash: result.quote_hash },
        status: 'DECIDED'
      });
    }

    if (options.executeAction && result.can_auto_execute) {
      result.execution = await options.executeAction({
        decision_id: result.decision_id,
        idempotency_key: `orchestrator:${result.decision_id}`,
        ...result.contract_action
      });
    }
    return result;
  }
}

export async function orchestrateEbl(input, options = {}) {
  const orchestrator = options.orchestrator ?? new AgentOrchestrator(options);
  return orchestrator.processEbl(input, options);
}
