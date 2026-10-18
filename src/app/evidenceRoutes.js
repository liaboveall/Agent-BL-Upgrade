import { EVIDENCE_SCHEMA, EVIDENCE_DATA } from '../evidence/schema.js';
import { CALIBRATION, CALIBRATION_HASH } from '../provenance/market.js';
import { resolveProvider } from '../agent/llm/openaiCompatClient.js';
import { sendJson } from './http.js';

export function createEvidenceRoutes({ env = process.env, getAnchoring = () => null } = {}) {
  return async (request, response, url) => {
    if (url.pathname !== '/api/evidence/status' || request.method !== 'GET') return false;
    const provider = resolveProvider(env);
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, { schema: EVIDENCE_SCHEMA, kinds: Object.keys(EVIDENCE_DATA),
      calibration: { ...CALIBRATION, hash: CALIBRATION_HASH },
      model: { configured: Boolean(provider), provider: provider?.provider ?? null, version: provider?.model ?? null, quality_accepted: false },
      screening: { configured: Boolean(env.COMPLIANCE_SCREENING_URL), quality_accepted: false },
      payment: { verification: 'independent_erc3009_receipt', confirmations: Number(env.X402_CONFIRMATIONS ?? 2), unknown_outcome: 'read_only_reconciliation' },
      anchor: getAnchoring()?.status() ?? null, source_truth_verified: false, business_enabled: false,
      human_review_required: true }); return true;
  };
}
