import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initTracing,
  recordChainTransaction,
  recordLLMCall,
  sanitizeAttributes,
  traceAgentWorkflow,
  tracePricingWorkflow,
  traceSpan
} from '../src/agent/tracing/tracer.js';

test('tracing helpers work whether or not @opentelemetry/api is installed', async () => {
  assert.equal(await traceSpan('answer', async (span) => {
    span.setAttribute('k', 'v');
    return 42;
  }), 42);
  await assert.rejects(traceSpan('boom', async () => { throw new Error('nope'); }), /nope/u);

  assert.deepEqual(await traceAgentWorkflow('w', { a: async () => 1, b: async () => 2 }), { a: 1, b: 2 });
  await assert.rejects(traceAgentWorkflow('w', { bad: async () => { throw new TypeError('x'); } }), /x/u);

  const pricing = await tracePricingWorkflow({ cargo: 'Copper', value: 1 });
  assert.equal(pricing.compliance_check.result, 'PASS');
  assert.doesNotThrow(() => initTracing());
});

test('LLM and chain metrics are recorded as span attributes', async () => {
  const attributes = {};
  const span = { setAttribute: (key, value) => { attributes[key] = value; } };
  recordLLMCall(span, { provider: 'deepseek', model: 'x-test-2', promptTokens: 10, completionTokens: 5, cost: 0.001 });
  recordChainTransaction(span, { chainId: 1439, txHash: `0x${'ab'.repeat(32)}`, gasUsed: 21000 });
  assert.equal(attributes['llm.total_tokens'], 15);
  assert.equal(attributes['llm.cost_usd'], 0.001);
  assert.equal(attributes['chain.id'], 1439);
  assert.equal(attributes['chain.gas_used'], 21000);
});

test('span attributes are sanitised: secrets redacted, long strings truncated, PII hashed', () => {
  const safe = sanitizeAttributes({ api_key: 'sk-secret', note: 'x'.repeat(300), email: 'someone@example.com', count: 5 });
  assert.equal(safe.api_key, '[REDACTED]');
  assert.ok(safe.note.endsWith('...[truncated]') && safe.note.length < 300);
  assert.ok(!JSON.stringify(safe).includes('someone@example.com'));
  assert.equal(safe.count, 5);
});
