import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateWithConsensus } from '../src/agent/llmConsensus.js';

const mockFallback = () => ({ riskLevel: 'HIGH', issues: ['Fallback used'] });
const THREE = ['tencent', 'deepseek', 'qwen'];

test('AI-20: all succeed and reach consensus', async () => {
  const mockChatFn = async () => {
    // All return MEDIUM
    return { content: JSON.stringify({ riskLevel: 'MEDIUM', issues: ['Some minor issue'] }) };
  };

  const res = await evaluateWithConsensus([], mockFallback, { providers: THREE, chatFn: mockChatFn });
  assert.equal(res.usedFallback, false);
  assert.equal(res.consensus.riskLevel, 'MEDIUM');
  assert.equal(res.details.length, 3);
});

test('AI-20: single provider fails but others reach consensus', async () => {
  const mockChatFn = async (args, env) => {
    if (env.LLM_PROVIDER === 'deepseek') throw new Error('API down');
    return { content: JSON.stringify({ riskLevel: 'LOW' }) };
  };

  const res = await evaluateWithConsensus([], mockFallback, { providers: THREE, chatFn: mockChatFn });
  assert.equal(res.usedFallback, false);
  assert.equal(res.consensus.riskLevel, 'LOW');
  assert.equal(res.details.length, 2); // 2 successful
});

test('AI-20: extreme outlier causes disagreement fallback', async () => {
  const mockChatFn = async (args, env) => {
    if (env.LLM_PROVIDER === 'tencent') return { content: JSON.stringify({ riskLevel: 'LOW' }) };
    if (env.LLM_PROVIDER === 'deepseek') return { content: JSON.stringify({ riskLevel: 'CRITICAL' }) }; // Outlier
    return { content: JSON.stringify({ riskLevel: 'MEDIUM' }) };
  };

  const res = await evaluateWithConsensus([], mockFallback, { providers: THREE, chatFn: mockChatFn, maxDisagreement: 2 });
  // CRITICAL(4) vs LOW(1) => 3 difference. maxDisagreement = 2, so it falls back
  assert.equal(res.usedFallback, true);
  assert.equal(res.consensus.riskLevel, 'HIGH'); // from fallback
  assert.equal(res.warning, true);
});

test('AI-20: all fail triggers fallback', async () => {
  const mockChatFn = async () => {
    throw new Error('Timeout');
  };

  const res = await evaluateWithConsensus([], mockFallback, { providers: THREE, chatFn: mockChatFn });
  assert.equal(res.usedFallback, true);
  assert.equal(res.consensus.riskLevel, 'HIGH');
  assert.equal(res.reason, 'All providers failed.');
});

test('WP0.2: with no provider configured nothing is called and the fallback is used', async () => {
  let calls = 0;
  const res = await evaluateWithConsensus([], mockFallback, {
    providers: [],
    chatFn: async () => { calls += 1; return { content: '{}' }; }
  });
  assert.equal(calls, 0);
  assert.equal(res.usedFallback, true);
  assert.equal(res.reason, 'No LLM provider is configured.');
});

test('WP0.2: the default provider list is only the providers with a real key', async () => {
  const saved = { ...process.env };
  for (const name of ['Tencent_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'Ali_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY']) delete process.env[name];
  process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
  try {
    const seen = [];
    const res = await evaluateWithConsensus([], mockFallback, {
      chatFn: async (_args, env) => { seen.push(env.LLM_PROVIDER); return { content: JSON.stringify({ riskLevel: 'LOW' }) }; }
    });
    assert.deepEqual(seen, ['deepseek']);
    assert.equal(res.consensus.riskLevel, 'LOW');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('WP0.2: no placeholder credentials are injected and a custom endpoint cannot hijack a provider', async () => {
  const saved = { ...process.env };
  for (const name of ['DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'Ali_API_KEY', 'Tencent_API_KEY']) delete process.env[name];
  process.env.LLM_BASE_URL = 'https://example.invalid/v1';
  process.env.LLM_API_KEY = 'custom-key-not-real';
  try {
    const envs = [];
    await evaluateWithConsensus([], mockFallback, {
      providers: THREE,
      chatFn: async (_args, env) => { envs.push(env); return { content: JSON.stringify({ riskLevel: 'LOW' }) }; }
    });
    assert.equal(envs.length, 3);
    for (const env of envs) {
      assert.ok(!Object.values(env).includes('dummy'), 'no dummy key is injected');
      assert.equal(env.DEEPSEEK_API_KEY, undefined);
      assert.equal(env.LLM_BASE_URL, undefined);
      assert.equal(env.LLM_API_KEY, undefined);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('WP0.2: an unconfigured provider fails by itself, it is not called with a fake key', async () => {
  const saved = { ...process.env };
  for (const name of ['DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'Ali_API_KEY', 'Tencent_API_KEY', 'OPENAI_API_KEY', 'LLM_BASE_URL', 'LLM_API_KEY']) delete process.env[name];
  try {
    const res = await evaluateWithConsensus([], mockFallback, { providers: ['deepseek'] });
    assert.equal(res.usedFallback, true);
    assert.match(res.details[0].error, /No LLM provider configured/u);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('WP0.2: HIGH from a provider is read as WARNING and the consensus uses the engine vocabulary', async () => {
  const levels = { tencent: 'HIGH', deepseek: 'WARNING', qwen: 'MEDIUM' };
  const res = await evaluateWithConsensus([], mockFallback, {
    providers: THREE,
    chatFn: async (_args, env) => ({ content: JSON.stringify({ riskLevel: levels[env.LLM_PROVIDER] }) })
  });
  assert.equal(res.usedFallback, false);
  assert.equal(res.consensus.riskLevel, 'WARNING');
  assert.equal(res.consensus.score, 3);
});
