import { hashSnapshot } from '../agent/decisionLogger.js';
import { parseDocument } from '../agent/documentParser.js';
import { runBlind } from '../agent/evaluation/runner.js';
import { supportedField } from '../agent/ingest/modelExtraction.js';

export async function evaluateProviderCorpus(corpus, { model = null, providerVersion = null, live = false, now = () => Date.now() } = {}) {
  const { corpus_hash, ...body } = corpus;
  if (corpus.schema !== 'agentbl-provider-corpus-v1' || hashSnapshot(body) !== corpus_hash || !Array.isArray(corpus.samples) || !corpus.samples.length) throw new Error('Frozen provider corpus integrity failure');
  const rows = [];
  for (const sample of corpus.samples) {
    let output, providerResult = null, code = null, providerAttempted = false, providerError = null;
    const start = now();
    try {
      output = await runBlind(sample.input, async (input) => parseDocument({ text: input.text, filename: `${sample.id}.txt` }, {
        documentType: input.documentType, completeAllFields: true,
        ...(model ? { aiExtractor: async ({ text, documentType }) => {
          providerAttempted = true;
          try { providerResult = await model({ text, documentType }); return providerResult; }
          catch (error) { providerError = { code: /^[A-Z0-9_]{1,80}$/u.test(error?.code ?? '') ? error.code : 'PROVIDER_FAILED',
            category: error?.details?.category ?? null, http_status: error?.details?.http_status ?? null }; throw error; }
        } } : {})
      }));
    } catch (error) { code = /^[A-Z0-9_]{1,80}$/u.test(error?.code ?? '') ? error.code : 'EXTRACTION_FAILED'; }
    const mismatches = Object.entries(sample.gold.fields).filter(([key, value]) => output?.fields[key] !== value).map(([key]) => key);
    const unsupported = (providerResult?.fields ?? []).filter((field) => !supportedField(field, sample.input.text)).map((field) => field.name);
    const drift = Boolean(providerVersion && providerResult && (providerResult.provider !== providerVersion.provider || providerResult.model !== providerVersion.model));
    const review = !output || output.requires_human_review || unsupported.length > 0 || drift || !corpus.approved_thresholds;
    rows.push({ sample_id: sample.id, origin: sample.origin, input_hash: hashSnapshot(sample.input),
      output_hash: hashSnapshot(output ?? null), latency_ms: Math.max(0, now() - start),
      field_errors: mismatches, scored_fields: Object.keys(sample.gold.fields).length, unsupported_fields: unsupported,
      extraction_requires_review: output?.requires_human_review ?? true,
      extraction_false_clear: Boolean(sample.gold.review && output && !output.requires_human_review),
      false_clear: sample.gold.review && !review, false_reject: !sample.gold.review && review,
      review_required: review, provider_called: Boolean(providerResult), provider_version_drift: drift,
      provider_attempted: providerAttempted, provider_error: providerError,
      findings: output?.findings?.map((item) => item.kind) ?? [], failure_code: code ?? providerError?.code ?? null,
      // A caught provider failure must remain visible even though deterministic extraction returned.
      provider_failed: Boolean(model && output?.findings?.some((item) => item.kind === 'MODEL_EXTRACTION_FAILED')) });
  }
  const count = (fn) => rows.filter(fn).length, totalFields = rows.reduce((sum, row) => sum + row.scored_fields, 0);
  const result = { schema: 'agentbl-provider-evaluation-v1', corpus_hash, scope: live ? 'real_provider_public_specimens' : 'local_deterministic_or_injected',
    provider: providerVersion, independence: corpus.independence, approved_thresholds: corpus.approved_thresholds,
    metrics: { samples: rows.length, scored_fields: totalFields, field_errors: rows.reduce((sum, row) => sum + row.field_errors.length, 0),
      false_clear: count((row) => row.false_clear), false_reject: count((row) => row.false_reject),
      provider_attempts: count((row) => row.provider_attempted), successful_provider_responses: count((row) => row.provider_called),
      review_positive_samples: corpus.samples.filter((sample) => sample.gold.review).length,
      clear_negative_samples: corpus.samples.filter((sample) => !sample.gold.review).length,
      provider_quality_measurable: count((row) => row.provider_called) > 0,
      extraction_false_clear: count((row) => row.extraction_false_clear),
      human_review_rate: count((row) => row.review_required) / rows.length, provider_failures: count((row) => row.provider_failed),
      version_drift: count((row) => row.provider_version_drift), supported_field_failures: rows.reduce((sum, row) => sum + row.unsupported_fields.length, 0) },
    rows, business_accepted: false, human_review_required: true };
  return { ...result, report_hash: hashSnapshot(result) };
}
