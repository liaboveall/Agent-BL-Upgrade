// Stateless PRD §9.2 operations. Never access runtime stores, file paths supplied by callers,
// chain readers, signers or event queues. Every downstream result is computed again from inputs.
import { z } from 'zod';
import crypto from 'node:crypto';
import { extractDocumentInput, parseDocument, mergeParsedDocuments, DOCUMENT_TYPES, DocumentParseError } from './documentParser.js';
import { validateDocumentInput, MAX_DOCUMENTS_PER_UPLOAD } from './ingest/ingestService.js';
import { createDocumentModel } from './ingest/modelExtraction.js';
import { screenDocuments, screenDocumentText } from './ingest/injectionScreen.js';
import { checkDocumentConsistency } from './documentConsistency.js';
import { checkCompliance } from './complianceChecker.js';
import { hashSnapshot } from './decisionLogger.js';
import { narratePricing } from './pricingNarrator.js';
import { quoteFromCase, PAYOUT_SPEEDS } from '../core/pricingEngine.js';
import { assertPricingQuote } from '../core/pricingSchema.js';
import { loadAgentConfig } from './runtime/config.js';

export const AGENT_API_OPERATIONS = Object.freeze([
  'extract-documents', 'verify-documents', 'price-rwa', 'generate-investor-brief', 'generate-evidence-graph'
]);

export class AgentApiError extends Error {
  constructor(code, message, status = 400, issues) {
    super(message);
    Object.assign(this, { name: 'AgentApiError', code, status, expose: true, issues });
  }
}

const label = z.string().trim().min(1).max(2000);
const amount = z.number().min(0).max(1e12);
const positive = amount.positive();
const ratio = z.number().gt(0).max(1);
const caseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/u);
const date = label.refine((value) => Number.isFinite(Date.parse(value)), 'Invalid date');
const section = (fields) => z.object(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.optional()]))).passthrough();
const tradeCase = section({
  case_id: caseId,
  bill_of_lading: section({ bl_id: label, cargo: label, quantity_mt: positive, declared_value_usd: positive,
    shipper: label, consignee: label, carrier: label, vessel: label, port_of_loading: label, port_of_discharge: label,
    incoterms: label, issue_date: date, eta: date }),
  commercial_invoice: section({ quantity_mt: positive, total_amount_usd: positive, total_amount_cny: positive,
    unit_price_usd_per_mt: positive, unit_price_usd_per_bbl: positive, incoterms: label, receipt_no: label, currency: label }),
  insurance: section({ insured_value_usd: amount, provider: label, expires_at: date }),
  warehouse_receipt: section({ receipt_no: label, currency: label, quantity_mt: positive, declared_value_cny: positive, hs_code: label }),
  cargo: section({ quantity_mt: positive, quantity: positive, bbl_per_mt: positive, commodity: label }),
  market: section({ commodity: label, landed_price_usd_per_mt: positive, reference_price_usd_per_mt: positive,
    regional_premium_usd_per_mt: amount, landed_price_usd_per_bbl: positive, reference_price_usd_per_bbl: positive,
    bbl_per_mt: positive, initial_price_usd_per_mt: positive, current_price_usd_per_mt: positive,
    initial_price_usd_per_bbl: positive, current_price_usd_per_bbl: positive }),
  financing: section({ requested_cash_usd: positive, currency: z.enum(['USD', 'USDC', 'CNY']),
    payout_speed: z.enum(PAYOUT_SPEEDS), redemption_coverage_limit: ratio, target_redemption_value_usd: z.literal(1) }),
  trade_economics: section({ cost_of_goods_usd: amount, cost_basis_usd_per_mt: amount,
    cost_basis_usd_per_unit: amount, gross_margin_pct: z.number().min(0).max(1) }),
  shipment_events: z.array(z.object({ type: label, severity: z.enum(['info', 'warning', 'critical']), delay_days: amount.optional() }).passthrough()).max(200),
  macro_risk_events: z.array(z.object({ type: label, severity: z.enum(['info', 'warning', 'critical']), region: label.optional(), description: label.optional() }).passthrough()).max(200)
});
const document = z.object({ name: label, mime_type: label, text: z.string().optional(), content_base64: z.string().optional(),
  declared_type: z.enum(DOCUMENT_TYPES).optional() }).strict();
const documents = z.array(document).min(1).max(MAX_DOCUMENTS_PER_UPLOAD);
const requestSchemas = {
  'extract-documents': z.object({ documents, case_id: caseId.optional() }).strict(),
  'verify-documents': z.object({ case_data: tradeCase.optional(), documents: documents.optional() }).strict(),
  'price-rwa': z.object({ case_data: tradeCase, documents: documents.optional(), payout_speed: z.enum(PAYOUT_SPEEDS).optional(),
    min_acceptable_issue_price: z.number().min(0.5).max(0.97).optional() }).strict()
};
requestSchemas['generate-investor-brief'] = requestSchemas['price-rwa'].extend({ use_llm: z.boolean().optional() });
requestSchemas['generate-evidence-graph'] = requestSchemas['price-rwa'];

function checked(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AgentApiError('invalid_agent_request', 'Invalid Agent API input', 400,
    result.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })));
  return result.data;
}

// Keep canonical hashing, schema validation and recursive merging bounded, and reject prototype keys.
function checkTree(input) {
  const pending = [[input, 0]];
  let count = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++count > 20_000 || depth > 20) throw new AgentApiError('input_complexity_limit', 'Input nesting or item count exceeds the limit');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new AgentApiError('invalid_agent_request', 'Numbers must be finite');
    if (!value || typeof value !== 'object') continue;
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new AgentApiError('invalid_agent_request', 'Reserved object key');
      pending.push([item, depth + 1]);
    }
  }
}

function conflictsBetween(previous, incoming, prefix = '') {
  const conflicts = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (previous?.[key] === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) conflicts.push(...conflictsBetween(previous[key], value, path));
    else if (hashSnapshot(previous[key]) !== hashSnapshot(value)) conflicts.push({ kind: 'SOURCE_FIELD_CONFLICT', field: path });
  }
  return conflicts;
}

function missingVerificationFields(data) {
  const paths = data.warehouse_receipt
    ? ['warehouse_receipt.receipt_no', 'warehouse_receipt.quantity_mt', 'commercial_invoice.quantity_mt', 'commercial_invoice.currency']
    : ['bill_of_lading.quantity_mt', 'bill_of_lading.declared_value_usd', 'bill_of_lading.eta',
      'commercial_invoice.quantity_mt', 'commercial_invoice.total_amount_usd', 'insurance.insured_value_usd', 'insurance.expires_at'];
  return paths.filter((path) => path.split('.').reduce((value, key) => value?.[key], data) === undefined);
}

async function extract(inputs, template, { config, env, completion }) {
  const extracted = [], hashes = [], findings = [];
  let merged = structuredClone(template);
  const model = config.visionEnabled || config.documentLlm ? createDocumentModel({ env, completion }) : null;
  const parser = {
    visionEnabled: config.visionEnabled,
    ...(config.visionEnabled && model?.configured ? { visionExtractor: model.vision } : {}),
    ...(config.documentLlm && model?.configured ? { aiExtractor: model.complete } : {})
  };
  // Validate every upload and extract all readable text before any model request. Keep the
  // original order for merging and commitments even though images are transcribed separately.
  const prepared = (inputs ?? []).map((input) => {
    const validated = validateDocumentInput(input, config.uploadMaxBytes);
    const { name, mime, buffer } = validated;
    const digest = `0x${crypto.createHash('sha256').update(buffer).digest('hex')}`;
    hashes.push(digest);
    return { input, ...validated, kind: validated.allowed.kind, digest, descriptor: { name, mime_type: mime, buffer } };
  });
  const resolve = async (document) => {
    try { document.resolved = await extractDocumentInput(document.descriptor, parser); }
    catch (error) {
      if (!(error instanceof DocumentParseError)) throw error;
      document.error = error;
    }
  };
  for (const document of prepared) if (document.kind !== 'image') await resolve(document);
  const preScreen = screenDocuments([
    { name: 'caller-supplied case', text: JSON.stringify(template) },
    ...prepared.map(({ name, resolved }) => ({ name, text: `${name}\n${resolved?.text ?? ''}` }))
  ]);
  findings.push(...preScreen.findings);
  let anySuspicion = preScreen.suspicious;
  for (const document of prepared) if (document.kind === 'image') {
    if (anySuspicion) document.error = new DocumentParseError('Vision was blocked because the bundle contains suspected instructions.', 'OCR_REQUIRED');
    else await resolve(document);
    if (document.error?.code === 'PROMPT_INJECTION_SUSPECTED') anySuspicion = true;
  }
  // A suspicious image transcription also blocks text completion throughout the bundle.
  for (const { input, name, mime, digest, resolved, error: extractionError } of prepared) {
    try {
      if (extractionError) throw extractionError;
      // Only constructed in-memory descriptors reach the parser; callers cannot supply a local path.
      const parsed = await parseDocument(null, {
        ...parser, extracted: resolved,
        documentType: input.declared_type,
        ...(anySuspicion ? { aiExtractor: undefined } : {})
      });
      findings.push(...conflictsBetween(merged, parsed.case_fragment), ...parsed.findings);
      extracted.push({ ...parsed, content_hash: digest });
      merged = mergeParsedDocuments(extracted, { templateCase: template }).case_data;
    } catch (error) {
      if (!(error instanceof DocumentParseError)) throw error;
      // Unknown, unreadable and scanned documents remain explicit review evidence.
      findings.push({ kind: error.code, document_name: name, requires_human_review: true });
      extracted.push({ document_type: input.declared_type ?? 'UNKNOWN', source: { filename: name, mime_type: mime, extractor: 'unavailable' },
        fields: {}, provenance: {}, case_fragment: {}, content_hash: digest, text_hash: null, confidence: 0,
        requires_human_review: true, warnings: [error.code], findings: [{ kind: error.code }] });
    }
  }
  const result = extracted.length ? mergeParsedDocuments(extracted, { templateCase: template }) : { case_data: template, documents: [], requires_human_review: false, warnings: [] };
  checked(tradeCase, result.case_data);
  return { ...result, findings, input_case_hash: hashSnapshot(template), input_document_hashes: hashes };
}

function assess(extraction) {
  const data = extraction.case_data;
  const verification = checkDocumentConsistency(data);
  const compliance = checkCompliance(data, { documents: extraction.documents });
  const injection = screenDocumentText(JSON.stringify(data)).suspicious;
  const missing = missingVerificationFields(data);
  const review = extraction.requires_human_review || extraction.findings.length > 0 || missing.length > 0 || !verification.ok || injection || compliance.status === 'REVIEW';
  return { verification, compliance, missing_fields: missing, findings: extraction.findings,
    requires_human_review: review || compliance.status === 'BLOCK',
    status: compliance.status === 'BLOCK' ? 'REJECT' : review ? 'HOLD_FOR_REVIEW' : 'READY_FOR_PRICING',
    input_source: 'caller-supplied', registry_verified: false };
}

function price(data, body) {
  const required = {
    case_id: data.case_id, bl_id: data.bill_of_lading?.bl_id,
    quantity_mt: data.cargo?.quantity_mt ?? data.bill_of_lading?.quantity_mt ?? data.cargo?.quantity,
    declared_value_usd: data.commercial_invoice?.total_amount_usd ?? data.bill_of_lading?.declared_value_usd,
    insured_value_usd: data.insurance?.insured_value_usd, requested_cash_usd: data.financing?.requested_cash_usd
  };
  if (Object.values(required).some((value) => value === undefined) || data.financing?.currency === 'CNY' || data.commercial_invoice?.currency === 'CNY') {
    throw new AgentApiError('pricing_inputs_required', 'Pricing requires an identified USD/USDC trade case, quantity, invoice value, insurance and financing. No currency conversion is inferred.', 422);
  }
  const quote = quoteFromCase(data, { payout_speed: body.payout_speed, min_acceptable_issue_price: body.min_acceptable_issue_price });
  assertPricingQuote(quote);
  return quote;
}

function acceptsPolish(text, grounded, quote) {
  if (text.length > 3000) return false;
  const words = (value) => value.toLowerCase().match(/[a-z]+/gu) ?? [];
  // A conservative vocabulary bound prevents new names, authorities or unsupported facts.
  const allowed = new Set([...words(grounded), ...words('the a an and or in on for of to is are with at by from has have this that it its as currently offers represents remains investors investor')]);
  if (words(text).some((word) => !allowed.has(word))) return false;
  const numbers = (value) => value.replaceAll(',', '').match(/[+-]?\d+(?:\.\d+)?/gu) ?? [];
  const groundedNumbers = new Set(numbers(grounded).map(Number));
  if (numbers(text).some((value) => !groundedNumbers.has(Number(value)))) return false;
  if (!text.includes(quote.final_issue_price_usd.toFixed(2)) || !text.includes(quote.risk_level) || !text.includes(quote.pricing_action)) return false;
  if ([...text.matchAll(/\b(LOW|MEDIUM|WARNING|CRITICAL)\b/gu)].some((match) => match[1] !== quote.risk_level)) return false;
  if (!/target[^.]*not (?:a )?guarantee/iu.test(text)) return false;
  const withoutCaution = text.replace(/not (?:a )?guarantee(?:d)?/giu, '');
  return !/guarantee|risk.free/iu.test(withoutCaution);
}

export function createAgentApi({ env = process.env, completion } = {}) {
  const config = loadAgentConfig(env);
  return async function run(operation, input) {
    if (!AGENT_API_OPERATIONS.includes(operation)) throw new AgentApiError('unknown_agent_operation', 'Unknown Agent API operation', 404);
    checkTree(input);
    const body = checked(requestSchemas[operation], input);
    if (!body.case_data && !body.documents) throw new AgentApiError('source_required', 'Supply case_data or documents');
    const extraction = await extract(body.documents, body.case_data ?? (body.case_id ? { case_id: body.case_id } : {}), { config, env, completion });
    const assessment = assess(extraction);
    const base = { stateless: true, chain_action_executed: false, assessment };
    if (operation === 'extract-documents') return { ...base, extraction };
    if (operation === 'verify-documents') return base;
    const quote = price(extraction.case_data, body);
    if (operation === 'price-rwa') return { ...base, quote, indicative_only: true };
    if (operation === 'generate-investor-brief') {
      const narrative = await narratePricing({ recommended_quote: quote }, {
        env, useLlm: body.use_llm === true && String(env.LLM_PROXY_ENABLED ?? 'true').toLowerCase() !== 'false' && !assessment.requires_human_review,
        ...(completion ? { chat: completion } : {}), acceptText: (text, grounded) => acceptsPolish(text, grounded, quote)
      });
      const caution = 'Indicative analysis of caller-supplied inputs. No offering or transaction was executed. ';
      return { ...base, quote, brief: { text: narrative.text, grounded: narrative.grounded, provider: narrative.provider,
        warning: caution + `Assessment: ${assessment.status}. ` + assessment.compliance.disclaimer,
        quote_hash: quote.quote_hash, risk_level: quote.risk_level } };
    }
    // The first nodes are the pricing engine's buildEvidenceGraph output. Append the actual
    // parsed document commitments, consistency and versioned compliance; hash the whole graph.
    const nodes = [
      ...quote.evidence_graph.map((node) => ({ ...node, id: `pricing:${node.component}`, type: 'pricing' })),
      { id: 'inputs', type: 'caller-supplied-case', hash: extraction.input_case_hash,
        merged_case_hash: hashSnapshot(extraction.case_data), registry_verified: false },
      ...extraction.documents.map((doc, index) => ({ id: `document:${index}`, type: 'document', document_type: doc.document_type,
        name: doc.source.filename, content_hash: doc.content_hash, text_hash: doc.text_hash, confidence: doc.confidence,
        fields_hash: hashSnapshot(doc.fields), requires_human_review: doc.requires_human_review })),
      { id: 'verification', type: 'document-consistency', ...assessment.verification, missing_fields: assessment.missing_fields, findings: assessment.findings },
      { id: 'compliance', type: 'compliance', ...assessment.compliance }
    ];
    const graph = { version: 1, case_id: extraction.case_data.case_id, quote_hash: quote.quote_hash,
      nodes, edges: nodes.filter((node) => node.type !== 'pricing').map((node) => ({ from: node.id, to: 'pricing:risk_discount', relation: 'supports-assessment' })),
      assessment: assessment.status };
    return { ...base, quote, evidence_graph: graph, graph_hash: hashSnapshot(graph), hash_algorithm: 'sha256-canonical-json',
      quote_evidence_hash: quote.evidence_hash, anchoring: 'offchain-only' };
  };
}
