// Optional, explicit adapter. The default runtime never calls an external screening service.
import { z } from 'zod';
import { COMPLIANCE_DATA } from './data.js';
import { checkCompliance, complianceFacts, complianceReport, worstStatus } from './index.js';

const STATUS = z.enum(['CLEAR', 'REVIEW', 'BLOCK']);
const responseSchema = z.object({
  status: STATUS, list_version: z.string().min(1).max(100),
  checks: z.array(z.object({ id: z.string().min(1).max(100), status: STATUS,
    detail: z.string().min(1).max(600), field: z.string().min(1).max(100),
    entry_id: z.string().max(100).nullable(), score: z.number().min(0).max(1).nullable()
  }).strict()).min(1).max(100)
}).strict().refine((value) => value.status === worstStatus(value.checks.map((check) => check.status)), 'Inconsistent screening statuses');

/** Build an injected adapter; defining COMPLIANCE_SCREENING_URL alone does not enable requests. */
export function createExternalComplianceChecker({ env = {}, url = env.COMPLIANCE_SCREENING_URL,
  timeoutMs = Number(env.COMPLIANCE_SCREENING_TIMEOUT_MS ?? 1500), fetchImpl } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('An explicitly supplied screening transport is required');
  const endpoint = new URL(url);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new TypeError('Invalid screening service URL');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid screening timeout');
  return async (caseData, options = {}) => {
    const local = checkCompliance(caseData, options);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('screening_timeout')); }, timeoutMs); });
    let externalChecks, external;
    try {
      const request = {
        schema_version: 'agentbl-screening-v1', demo_list_version: local.list_version,
        // No documents, prompts, keys, prices or instructions are sent to this interface.
        facts: complianceFacts(caseData, options).filter((fact) => typeof fact.value === 'string' && fact.value.length <= 600)
      };
      const result = await Promise.race([timeout, (async () => {
        const response = await fetchImpl(endpoint.href, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(request) });
        if (!response.ok) throw new Error('screening_unavailable');
        const text = await response.text();
        if (text.length > 65536) throw new Error('screening_invalid');
        return responseSchema.parse(JSON.parse(text));
      })()]);
      externalChecks = result.checks.map((check) => ({ id: `external:${check.id}`, category: 'external', label: 'external', status: check.status,
        code: `EXTERNAL_${check.status}`, detail: check.detail,
        evidence: { list_version: result.list_version, field: check.field, entry_id: check.entry_id, score: check.score, source: 'external-provider' } }));
      external = { status: result.status, source: 'external-provider', list_version: result.list_version };
    } catch {
      externalChecks = [{ id: 'external:unavailable', category: 'external', label: 'external', status: 'REVIEW', code: 'EXTERNAL_UNAVAILABLE',
        detail: 'External screening was unavailable, timed out or returned invalid output; local demo evidence was retained and human review is required.',
        evidence: { list_version: local.list_version, field: 'external', entry_id: null, score: null } }];
      external = { status: 'UNAVAILABLE', source: 'external-provider' };
    } finally { clearTimeout(timer); }
    // An external CLEAR can never erase a local BLOCK or REVIEW.
    return complianceReport([...local.checks, ...externalChecks], COMPLIANCE_DATA, { external });
  };
}
