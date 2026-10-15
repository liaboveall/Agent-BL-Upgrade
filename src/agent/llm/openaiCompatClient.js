// OpenAI-compatible chat client for tool calling.
//
// Works with any provider that speaks the OpenAI /chat/completions schema:
//   - Tencent    (TokenHub / Hunyuan)                                Tencent_API_KEY + Tencent_BASE_URL
//   - DeepSeek   (https://api.deepseek.com)                           DEEPSEEK_API_KEY
//   - Qwen       (DashScope OpenAI-compatible mode)                   DASHSCOPE_API_KEY
//   - OpenAI     (https://api.openai.com/v1)                            OPENAI_API_KEY
//   - Custom     LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
//
// No SDK dependency: uses the global fetch shipped with Node >= 18.
// If no key is configured, isConfigured() returns false and the caller
// should fall back to the deterministic valuation path.

// One project-wide model for direct agents, document extraction, Copilot, the relay and CLI.
// LLM_MODEL remains an explicit operator override; no provider has a separate model lock.
export const DEFAULT_LLM_MODEL = 'x-test-2';

const PROVIDERS = {
  azure: {
    // Azure OpenAI Service - requires AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_KEY
    // Endpoint format: https://<resource>.openai.azure.com
    baseUrlEnv: 'AZURE_OPENAI_ENDPOINT',
    deploymentEnv: 'AZURE_OPENAI_DEPLOYMENT',
    keyEnv: 'AZURE_OPENAI_API_KEY',
    apiVersion: '2024-02-15-preview'
  },
  tencent: {
    // Tencent Cloud TokenHub (Hunyuan), OpenAI-compatible.
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    baseUrlEnv: 'Tencent_BASE_URL',
    keyEnv: 'Tencent_API_KEY'
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY'
  },
  qwen: {
    // DashScope OpenAI-compatible endpoint. Ali_API_KEY / Ali_BASE_URL are
    // accepted as aliases (they shipped in .env.example from the first commit).
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlEnv: 'DASHSCOPE_BASE_URL',
    baseUrlEnvAliases: ['Ali_BASE_URL'],
    keyEnv: 'DASHSCOPE_API_KEY',
    keyEnvAliases: ['Ali_API_KEY']
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY'
  }
};

const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

/**
 * Optional `reasoning_effort` for reasoning models (GLM, DeepSeek-R1, o-series, ...). It is opt-in through
 * LLM_REASONING_EFFORT because a provider that does not know the field may reject the request; an unset or
 * unknown value sends nothing. Hidden thinking counts against max_tokens, so on a reasoning model an explicit
 * effort also decides whether the visible answer fits (see docs/DEPLOYMENT.md).
 */
export function reasoningEffort(env = process.env) {
  const value = String(env.LLM_REASONING_EFFORT ?? '').trim().toLowerCase();
  return REASONING_EFFORTS.has(value) ? value : undefined;
}

/** First non-empty value among the given env var names (undefined entries are skipped). */
function firstEnv(env, names) {
  for (const name of names) {
    if (name && env[name]) return env[name];
  }
  return undefined;
}

/**
 * The URL + auth headers for a provider's /chat/completions call. Shared by
 * chatCompletion() and the browser-facing relay so both build requests alike.
 */
export function buildChatEndpoint(cfg) {
  const headers = { 'content-type': 'application/json' };
  if (cfg.provider === 'azure') {
    // Azure OpenAI uses a deployment-specific endpoint and an api-key header.
    headers['api-key'] = cfg.apiKey;
    return {
      url: `${cfg.baseUrl}/openai/deployments/${cfg.deployment}/chat/completions?api-version=${cfg.apiVersion}`,
      headers
    };
  }
  headers.authorization = `Bearer ${cfg.apiKey}`;
  return { url: `${cfg.baseUrl}/chat/completions`, headers };
}

/**
 * Resolve which provider to use from the environment.
 * Priority: explicit LLM_PROVIDER / custom LLM_* > first provider whose key is set
 * (Tencent is first among built-in non-Azure providers).
 * @returns {{provider:string, baseUrl:string, model:string, apiKey:string}|null}
 */
export function resolveProvider(env = process.env) {
  const model = String(env.LLM_MODEL ?? '').trim() || DEFAULT_LLM_MODEL;
  // Azure OpenAI Service (check first as it requires special handling)
  const azureCfg = PROVIDERS.azure;
  if (env[azureCfg.keyEnv] && env[azureCfg.baseUrlEnv] && env[azureCfg.deploymentEnv]) {
    return {
      provider: 'azure',
      baseUrl: env[azureCfg.baseUrlEnv].replace(/\/$/, ''),
      deployment: env[azureCfg.deploymentEnv],
      apiVersion: azureCfg.apiVersion,
      apiKey: env[azureCfg.keyEnv],
      // The deployment is an Azure routing identifier, not a second model setting.
      model
    };
  }

  // Fully custom OpenAI-compatible endpoint.
  if (env.LLM_BASE_URL && env.LLM_API_KEY) {
    return {
      provider: 'custom',
      baseUrl: env.LLM_BASE_URL.replace(/\/$/, ''),
      model,
      apiKey: env.LLM_API_KEY
    };
  }

  const explicit = env.LLM_PROVIDER && PROVIDERS[env.LLM_PROVIDER];
  const order = explicit ? [env.LLM_PROVIDER] : Object.keys(PROVIDERS).filter(p => p !== 'azure');

  for (const name of order) {
    const cfg = PROVIDERS[name];
    const apiKey = firstEnv(env, [cfg.keyEnv, ...(cfg.keyEnvAliases ?? [])]);
    if (apiKey) {
      const baseUrl = firstEnv(env, [cfg.baseUrlEnv, ...(cfg.baseUrlEnvAliases ?? [])]) ?? cfg.baseUrl;
      return {
        provider: name,
        baseUrl: baseUrl.replace(/\/$/, ''),
        model,
        apiKey
      };
    }
  }
  return null;
}

export function isConfigured(env = process.env) {
  return resolveProvider(env) !== null;
}

/**
 * Names of the built-in providers whose API key is present in `env`, in resolution order.
 * Used by callers that fan out over several providers (llmConsensus): they must only ever
 * contact providers the operator really configured.
 */
export function configuredProviders(env = process.env) {
  return Object.keys(PROVIDERS).filter((name) => {
    if (name === 'azure') {
      const cfg = PROVIDERS.azure;
      return Boolean(env[cfg.keyEnv] && env[cfg.baseUrlEnv] && env[cfg.deploymentEnv]);
    }
    const cfg = PROVIDERS[name];
    return Boolean(firstEnv(env, [cfg.keyEnv, ...(cfg.keyEnvAliases ?? [])]));
  });
}

/**
 * Single /chat/completions call with optional tools.
 * Returns the raw assistant message object: { role, content, tool_calls? }.
 */
const completionUsage = new WeakMap();
export const completionMetadata = (message) => structuredClone(completionUsage.get(message) ?? null);

export async function chatCompletion({ messages, tools, toolChoice = 'auto', temperature = 0.2, timeoutMs = 45000, maxTokens, responseFormat }, env = process.env) {
  const cfg = resolveProvider(env);
  if (!cfg) throw new Error('No LLM provider configured. Set DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY / AZURE_OPENAI_* or LLM_BASE_URL+LLM_API_KEY.');

  const body = { model: cfg.model, messages, temperature };
  if (responseFormat) body.response_format = responseFormat;
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
  const effort = reasoningEffort(env);
  if (effort) body.reasoning_effort = effort;
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }

  const { url, headers } = buildChatEndpoint(cfg);

  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`LLM HTTP ${response.status} from ${cfg.provider}: ${text.slice(0, 500)}`);
    }

    const json = await response.json();
    const message = json.choices?.[0]?.message;
    if (!message) throw new Error(`LLM returned no message: ${JSON.stringify(json).slice(0, 500)}`);
    const tokens = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].filter((key) =>
      Number.isSafeInteger(json.usage?.[key]) && json.usage[key] >= 0).map((key) => [key, json.usage[key]]));
    completionUsage.set(message, { provider: cfg.provider, model: cfg.model,
      latency_ms: Math.max(0, Date.now() - started), tokens: Object.keys(tokens).length ? tokens : null });
    return message;
  } finally {
    clearTimeout(timer);
  }
}
