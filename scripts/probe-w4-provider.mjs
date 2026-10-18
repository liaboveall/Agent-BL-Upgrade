// Only a tiny public prompt is sent. Never print an endpoint, key, raw error or response body.
import '../src/env.js';
import fs from 'node:fs/promises';
import { chatCompletion, completionMetadata, resolveProvider } from '../src/agent/llm/openaiCompatClient.js';
import { createDocumentModel, MODEL_DOCUMENT_SCHEMA, FIELD_SCHEMAS } from '../src/agent/ingest/modelExtraction.js';
const cfg = resolveProvider(process.env), started = Date.now();
const result = { schema: 'agentbl-provider-connectivity-v1', executed_at: new Date().toISOString(),
  provider: cfg?.provider ?? null, model: cfg?.model ?? null, status: 'NOT_CONFIGURED' };
if (cfg) {
  try {
    if (process.argv.includes('--document')) {
      result.probe = 'public_document_schema';
      const model = createDocumentModel({ env: process.env, timeoutMs: 45000, maxTokens: 4096, completion: async (parameters, env) => {
        const message = await chatCompletion(parameters, env);
        result.metadata = completionMetadata(message);
        result.response_shape = { content_type: typeof message.content, characters: message.content?.length ?? 0,
          fenced: typeof message.content === 'string' && /^\s*```/u.test(message.content), tool_calls: message.tool_calls?.length ?? 0 };
        try {
          const parsed = JSON.parse(message.content), validation = MODEL_DOCUMENT_SCHEMA.safeParse(parsed);
          result.response_shape.valid_json = true;
          result.response_shape.schema_issues = validation.success ? [] : validation.error.issues.map((issue) => ({ code: issue.code, path: issue.path }));
          if (validation.success) result.response_shape.field_issues = parsed.fields.filter((field) => !FIELD_SCHEMAS[field.name]?.safeParse(field.value).success).map((field) => field.name);
        } catch { result.response_shape.valid_json = false; }
        return message;
      } });
      const response = await model.complete({ documentType: 'EBL', text: 'Electronic Bill of Lading - public research sample\nShipper: DCSA CTK\nConsignee: Global Retail Imports\nHS Code: 15152100' });
      result.status = 'SCHEMA_VALIDATED'; result.fields = response.fields.map((field) => field.name);
    } else {
      const message = await chatCompletion({ messages: [{ role: 'user', content: 'Reply with the single word READY.' }], timeoutMs: 45000, maxTokens: 256 }, process.env);
      result.status = typeof message.content === 'string' && message.content.trim() ? 'RESPONDED' : 'EMPTY_CONTENT';
      result.metadata = completionMetadata(message);
    }
  } catch (error) {
    result.status = 'FAILED'; result.error_type = /^[a-zA-Z0-9_]{1,80}$/u.test(error?.name ?? '') ? error.name : 'ProviderError';
    result.error_code = /^[A-Z_]{1,80}$/u.test(error?.code ?? '') ? error.code : null;
    result.http_status = Number.isInteger(error?.provider_status) ? error.provider_status : null;
    result.document_error = error?.details ?? null;
  }
}
result.latency_ms = Date.now() - started;
const file = `docs/evidence/w4-local-2026-10-17/provider-runs/${result.executed_at.replaceAll(/[:.]/gu, '-')}-connectivity.json`;
await fs.mkdir('docs/evidence/w4-local-2026-10-17/provider-runs', { recursive: true });
await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify(result));
