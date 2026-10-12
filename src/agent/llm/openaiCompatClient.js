// OpenAI-compatible chat client for tool calling.
//
// Works with any provider that speaks the OpenAI /chat/completions schema:
//   - Tencent    (TokenHub / Hunyuan, model hy3-preview ONLY)  Tencent_API_KEY + Tencent_BASE_URL
//   - DeepSeek   (https://api.deepseek.com, model deepseek-chat)        DEEPSEEK_API_KEY
//   - Qwen       (DashScope OpenAI-compatible mode, model qwen-plus)    DASHSCOPE_API_KEY
//   - OpenAI     (https://api.openai.com/v1)                            OPENAI_API_KEY
//   - Custom     LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
//
// No SDK dependency: uses the global fetch shipped with Node >= 18.
// If no key is configured, isConfigured() returns false and the caller
// should fall back to the deterministic valuation path.

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
    // Tencent Cloud TokenHub (Hunyuan), OpenAI-compatible. ONLY hy3-preview is
    // permitted on this account, so the model is locked and ignores LLM_MODEL.
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    baseUrlEnv: 'Tencent_BASE_URL',
    model: 'hy3-preview',
    keyEnv: 'Tencent_API_KEY',
    lockModel: true
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    keyEnv: 'DEEPSEEK_API_KEY'
  },
  qwen: {
    // DashScope OpenAI-compatible endpoint. Ali_API_KEY / Ali_BASE_URL are
    // accepted as aliases (they shipped in .env.example from the first commit).
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrlEnv: 'DASHSCOPE_BASE_URL',
    baseUrlEnvAliases: ['Ali_BASE_URL'],
    model: 'qwen-plus',
    keyEnv: 'DASHSCOPE_API_KEY',
    keyEnvAliases: ['Ali_API_KEY']
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
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
 * (Tencent hy3-preview is first, so it wins when configured).
 * @returns {{provider:string, baseUrl:string, model:string, apiKey:string}|null}
 */
export function resolveProvider(env = process.env) {
  // Azure OpenAI Service (check first as it requires special handling)
  const azureCfg = PROVIDERS.azure;
  if (env[azureCfg.keyEnv] && env[azureCfg.baseUrlEnv] && env[azureCfg.deploymentEnv]) {
    return {
      provider: 'azure',
      baseUrl: env[azureCfg.baseUrlEnv].replace(/\/$/, ''),
      deployment: env[azureCfg.deploymentEnv],
      apiVersion: azureCfg.apiVersion,
      apiKey: env[azureCfg.keyEnv],
      model: env[azureCfg.deploymentEnv] // Azure uses deployment name as model
    };
  }

  // Fully custom OpenAI-compatible endpoint.
  if (env.LLM_BASE_URL && env.LLM_API_KEY) {
    return {
      provider: 'custom',
      baseUrl: env.LLM_BASE_URL.replace(/\/$/, ''),
      model: env.LLM_MODEL ?? 'gpt-4o-mini',
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
        // A lockModel provider (Tencent: only hy3-preview is allowed) never honours LLM_MODEL.
        model: cfg.lockModel ? cfg.model : (env.LLM_MODEL ?? cfg.model),
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
 * Single /chat/completions call with optional tools.
 * Returns the raw assistant message object: { role, content, tool_calls? }.
 */
export async function chatCompletion({ messages, tools, toolChoice = 'auto', temperature = 0.2, timeoutMs = 45000 }, env = process.env) {
  const cfg = resolveProvider(env);
  if (!cfg) throw new Error('No LLM provider configured. Set DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY / AZURE_OPENAI_* or LLM_BASE_URL+LLM_API_KEY.');

  const body = { model: cfg.model, messages, temperature };
  const effort = reasoningEffort(env);
  if (effort) body.reasoning_effort = effort;
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }

  const { url, headers } = buildChatEndpoint(cfg);

  const controller = new AbortController();
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
    return message;
  } finally {
    clearTimeout(timer);
  }
}
