import { z } from 'zod';
import { createAgentApi } from '../agent/api.js';
import { hashSnapshot } from '../agent/decisionLogger.js';
import { assertPricingQuote, PAYOUT_SPEEDS } from '../core/pricingSchema.js';
import { injectPaidReportEvidence } from '../x402/reportEvidence.js';
import { HttpError } from '../app/http.js';
import { checkedInterop } from './validation.js';

export const delegatePricingSchema = z.object({
  request_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u).optional(),
  case_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/u).optional(),
  case_data: z.record(z.string(), z.unknown()).optional(),
  payout_speed: z.enum(PAYOUT_SPEEDS).optional(),
  min_acceptable_issue_price: z.number().min(0.5).max(0.97).optional(),
  paid_report_ids: z.array(z.string().regex(/^rpt_[0-9a-f]{64}$/u)).max(3).optional()
}).strict().refine((body) => Boolean(body.case_id) !== Boolean(body.case_data), 'Supply exactly one of case_id or case_data');

export const delegatePricingJsonSchema = {
  ...z.toJSONSchema(delegatePricingSchema, { target: 'draft-7' }),
  oneOf: [{ required: ['case_id'], not: { required: ['case_data'] } }, { required: ['case_data'], not: { required: ['case_id'] } }]
};

/** Synchronous, stateless quotation. Paid evidence is read from the delivery cache, never minted or purchased here. */
export function createPricingDelegate({ loadCase, readReport = async () => null, env = process.env, now = () => Date.now() } = {}) {
  const run = createAgentApi({ env: { ...env, AGENT_VISION_ENABLED: 'false', AGENT_DOCUMENT_LLM: 'false' } });
  const maximum = Math.min(64, Math.max(1, Number(env.AGENT_API_MAX_CONCURRENCY) || 4));
  let active = 0;
  return async (input) => {
    const body = checkedInterop(delegatePricingSchema, input);
    if (active >= maximum) throw new HttpError(429, 'delegation_busy', 'Too many concurrent pricing delegations');
    active += 1;
    try {
      const data = body.case_data ?? await loadCase?.(body.case_id);
      if (!data) throw new HttpError(404, 'case_not_found', 'Unknown trade case');
      const result = await run('price-rwa', { case_data: data,
        ...(body.payout_speed ? { payout_speed: body.payout_speed } : {}),
        ...(body.min_acceptable_issue_price !== undefined ? { min_acceptable_issue_price: body.min_acceptable_issue_price } : {}) });
      const reports = [];
      for (const id of new Set(body.paid_report_ids ?? [])) {
        const record = await readReport(id);
        if (!record?.envelope || record.envelope.report_id !== id) throw new HttpError(404, 'paid_report_not_cached', 'No unexpired delivered report matches the supplied id');
        reports.push(record);
      }
      const quote = injectPaidReportEvidence(result.quote, reports.map((record) => record.envelope), { caseId: data.case_id, now: now() });
      assertPricingQuote(quote);
      // Match the JSON transport projection, including omission of optional undefined fields.
      return JSON.parse(JSON.stringify({
        ...result, quote, request_id: body.request_id ?? null,
        input_hash: hashSnapshot(data), result_hash: hashSnapshot({ quote, assessment: result.assessment }),
        payment_evidence: reports.map(({ envelope, report }) => ({
          report_id: envelope.report_id, report_hash: envelope.report_hash, case_id: envelope.case_id,
          payment_tx: envelope.payment_tx, network: envelope.network, asset: envelope.asset, amount: envelope.amount,
          expires_at: envelope.expires_at, source: 'server-delivery-cache',
          mode: report?.payment?.live === true ? 'live' : 'demo',
          onchain_reverified: false, neutral_to_pricing: true
        })),
        authorization: { quotation_only: true, payment_executed: false, offering_created: false, chain_action_executed: false }
      }));
    } finally { active -= 1; }
  };
}
