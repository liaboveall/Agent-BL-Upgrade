import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chatCompletion, resolveProvider, buildChatEndpoint } from '../src/agent/llm/openaiCompatClient.js';
import { relayChat, llmStatus } from '../src/app/llmProxy.js';
import { listen, requestJson } from './helpers/http.js';
import { sendError } from '../src/app/http.js';

const providers = [
  ['custom', { LLM_BASE_URL: 'https://fixture.invalid/v1', LLM_API_KEY: 'fixture-key' }],
  ['tencent', { Tencent_API_KEY: 'fixture-key' }],
  ['deepseek', { DEEPSEEK_API_KEY: 'fixture-key' }],
  ['qwen', { DASHSCOPE_API_KEY: 'fixture-key' }],
  ['qwen-alias', { Ali_API_KEY: 'fixture-key', Ali_BASE_URL: 'https://fixture.invalid/v1' }],
  ['openai', { OPENAI_API_KEY: 'fixture-key' }],
  ['azure', { AZURE_OPENAI_API_KEY: 'fixture-key', AZURE_OPENAI_ENDPOINT: 'https://fixture.invalid', AZURE_OPENAI_DEPLOYMENT: 'existing-deployment-route' }]
];
const completion = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'local fixture response' } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } });

test('every provider resolves the project model, including blank overrides and Azure deployment routing', async (t) => {
  for (const [name, env] of providers) await t.test(name, () => {
    assert.equal(resolveProvider(env).model, 'x-test-2');
    assert.equal(resolveProvider({ ...env, LLM_MODEL: '  ' }).model, 'x-test-2');
    assert.equal(llmStatus(env).model, 'x-test-2');
    assert.equal(resolveProvider({ ...env, LLM_MODEL: ' explicit-operator-override ' }).model, 'explicit-operator-override');
    if (name === 'azure') assert.match(buildChatEndpoint(resolveProvider(env)).url, /\/deployments\/existing-deployment-route\//u);
  });
});

test('direct agent API calls transmit x-test-2 across every provider (intercepted, zero real calls)', async (t) => {
  const received = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    received.push({ url, body: JSON.parse(request.body) });
    return completion();
  });
  for (const [name, env] of providers) await t.test(name, async () => {
    await chatCompletion({ messages: [{ role: 'user', content: 'fixture' }] }, env);
    assert.equal(received.at(-1).body.model, 'x-test-2');
  });
});

test('browser relay transmits x-test-2 across providers and ignores client model injection', async (t) => {
  for (const [name, env] of providers) await t.test(name, async () => {
    let sent;
    const app = await listen(http.createServer(async (request, response) => {
      try { await relayChat(request, response, { env, fetchImpl: async (url, options) => { sent = JSON.parse(options.body); return completion(); } }); }
      catch (error) { sendError(response, error); }
    }));
    try {
      const response = await requestJson(app.base, 'POST', '/', { model: 'client-forged-model', messages: [{ role: 'user', content: 'fixture' }] });
      assert.equal(response.status, 200, response.text);
      assert.equal(sent.model, 'x-test-2');
      assert.equal(response.data.model, 'x-test-2');
    } finally { await app.close(); }
  });
});
