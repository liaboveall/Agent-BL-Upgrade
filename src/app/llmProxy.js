// Same-origin relay for the browser assistant. The provider API key stays on the
// server (it used to be injected into every HTML page); the browser only ever
// talks to /api/llm/*. The server picks the model, caps output size, bounds the
// request, limits concurrency and never echoes upstream error bodies.
import { once } from 'node:events';
import { buildChatEndpoint, reasoningEffort, resolveProvider } from '../agent/llm/openaiCompatClient.js';
import { HttpError, readJsonBody, sendJson } from './http.js';

export const LLM_BODY_LIMIT_BYTES = 256 * 1024;
const MAX_MESSAGES = 60;
const MAX_TOOLS = 16;
const MAX_TOOL_CALLS = 8;
const MAX_CONTENT_CHARS = 32_000;
export const DEFAULT_MAX_TOKENS_CAP = 2048;
const MAX_TOKENS_CAP_RANGE = Object.freeze({ min: 256, max: 32_768 });
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const UPSTREAM_TIMEOUT_MS = 60_000;

let inflight = 0;

/**
 * Largest output (max_tokens) a browser request may ask for, or null for no cap. 2048 suits ordinary chat models
 * on a paid key, where the cap is what bounds the spend. A reasoning model spends most of max_tokens on hidden
 * thinking, so the same prompt can come back with no answer at all; raise it with LLM_MAX_TOKENS_CAP (256-32768),
 * or set 0 to remove the cap on a free gateway (the upstream timeout, the concurrency limit and the per-client
 * rate limit still bound a request). An unset or out-of-range value keeps the default.
 */
export function maxTokensCap(env = process.env) {
  const raw = String(env.LLM_MAX_TOKENS_CAP ?? '').trim();
  const value = Number(raw);
  if (raw !== '' && value === 0) return null;
  return raw !== '' && Number.isInteger(value) && value >= MAX_TOKENS_CAP_RANGE.min && value <= MAX_TOKENS_CAP_RANGE.max
    ? value
    : DEFAULT_MAX_TOKENS_CAP;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message) {
  return new HttpError(400, 'invalid_llm_request', message);
}

function text(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw invalid(`${label} must be a string`);
  if (value.length > MAX_CONTENT_CHARS) throw invalid(`${label} exceeds ${MAX_CONTENT_CHARS} characters`);
  return value;
}

function normalizeToolCall(raw, index) {
  if (!isRecord(raw) || !isRecord(raw.function)) throw invalid(`messages tool_calls[${index}] is malformed`);
  const name = String(raw.function.name ?? '');
  if (!TOOL_NAME.test(name)) throw invalid(`messages tool_calls[${index}] has an invalid function name`);
  return {
    id: text(String(raw.id ?? `call_${index}`), 'tool_call id'),
    type: 'function',
    function: { name, arguments: text(String(raw.function.arguments ?? '{}'), 'tool_call arguments') }
  };
}

function normalizeMessage(raw, index) {
  if (!isRecord(raw) || !ROLES.has(raw.role)) throw invalid(`messages[${index}].role must be one of ${[...ROLES].join(', ')}`);
  const message = { role: raw.role };
  if (raw.role === 'assistant' && Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
    if (raw.tool_calls.length > MAX_TOOL_CALLS) throw invalid(`messages[${index}] has too many tool_calls`);
    message.tool_calls = raw.tool_calls.map(normalizeToolCall);
    message.content = text(raw.content ?? '', `messages[${index}].content`, { nullable: true }) || null;
    return message;
  }
  message.content = text(raw.content, `messages[${index}].content`);
  if (raw.role === 'tool') message.tool_call_id = text(String(raw.tool_call_id ?? ''), `messages[${index}].tool_call_id`);
  return message;
}

function normalizeTool(raw, index) {
  // Accept both the OpenAI shape and the flat { name, description, parameters } shape.
  const fn = isRecord(raw?.function) ? raw.function : raw;
  const name = String(fn?.name ?? '');
  if (!TOOL_NAME.test(name)) throw invalid(`tools[${index}] has an invalid name`);
  const parameters = fn.parameters === undefined ? { type: 'object', properties: {} } : fn.parameters;
  if (!isRecord(parameters)) throw invalid(`tools[${index}].parameters must be an object`);
  return {
    type: 'function',
    function: { name, description: text(fn.description ?? '', `tools[${index}].description`), parameters }
  };
}

/** Validate + normalize a browser chat request. Anything not listed here is dropped. */
export function normalizeChatRequest(body, { maxTokensCap: cap = DEFAULT_MAX_TOKENS_CAP } = {}) {
  if (!isRecord(body)) throw invalid('Request body must be a JSON object');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid('messages must be a non-empty array');
  if (body.messages.length > MAX_MESSAGES) throw invalid(`messages is limited to ${MAX_MESSAGES} entries`);

  const request = {
    messages: body.messages.map(normalizeMessage),
    stream: body.stream === true,
    temperature: 0.3,
    maxTokens: cap ?? undefined // no cap configured: send no max_tokens unless the browser asks for one
  };
  if (body.temperature !== undefined) {
    const temperature = Number(body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1.5) throw invalid('temperature must be between 0 and 1.5');
    request.temperature = temperature;
  }
  if (body.max_tokens !== undefined) {
    const maxTokens = Number(body.max_tokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1) throw invalid('max_tokens must be a positive integer');
    request.maxTokens = cap === null ? maxTokens : Math.min(maxTokens, cap);
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) throw invalid(`tools must be an array of at most ${MAX_TOOLS} entries`);
    request.tools = body.tools.map(normalizeTool);
  }
  return request;
}

/**
 * The browser-facing relay is opt-in (LLM_HTTP_RELAY=true). No page of this app calls it any more, and
 * left open it lets anyone who can reach the server spend the provider key on arbitrary prompts.
 * Server-side model features (Copilot, narration) do not use it and follow LLM_PROXY_ENABLED alone.
 */
export const relayEnabled = (env = process.env) => String(env.LLM_HTTP_RELAY ?? 'false').toLowerCase() === 'true';

/** What the UI is allowed to know about the relay (never the key). */
export function llmStatus(env = process.env) {
  if (String(env.LLM_PROXY_ENABLED ?? 'true').toLowerCase() === 'false') {
    return { enabled: false, configured: false, relay: false };
  }
  const provider = resolveProvider(env);
  return provider
    ? { enabled: true, configured: true, relay: relayEnabled(env), provider: provider.provider, model: provider.model }
    : { enabled: true, configured: false, relay: relayEnabled(env) };
}

function upstreamBody(request, model, env) {
  const body = {
    model,
    messages: request.messages,
    temperature: request.temperature,
    stream: request.stream
  };
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  const effort = reasoningEffort(env);
  if (effort) body.reasoning_effort = effort;
  if (request.tools?.length) {
    body.tools = request.tools;
    body.tool_choice = 'auto';
  }
  return body;
}

async function failUpstream(upstream, provider, logger) {
  const detail = (await upstream.text().catch(() => '')).slice(0, 300);
  logger.error(`[agentbl] LLM upstream ${provider} answered HTTP ${upstream.status}: ${detail}`);
  if (upstream.status === 429) {
    throw new HttpError(429, 'llm_rate_limited', 'The LLM provider is rate limiting requests; retry shortly');
  }
  throw new HttpError(502, 'llm_upstream_error', `LLM provider returned HTTP ${upstream.status}`);
}

// Reasoning models return their hidden thinking next to the answer. The page never shows it, and it can echo
// the system prompt and tool definitions, so the relay drops it before anything reaches the browser.
const HIDDEN_MESSAGE_FIELDS = ['reasoning', 'reasoning_content', 'reasoning_details', 'thinking'];

export function stripHiddenReasoning(message) {
  if (!message || typeof message !== 'object') return message;
  const visible = { ...message };
  for (const field of HIDDEN_MESSAGE_FIELDS) delete visible[field];
  return visible;
}

/** Rewrite one SSE line so streamed deltas carry no hidden reasoning; anything that is not JSON passes through. */
export function stripReasoningFromSseLine(line) {
  const match = /^data:\s?(.*)$/u.exec(line);
  if (!match || match[1].trim() === '[DONE]') return line;
  let event;
  try { event = JSON.parse(match[1]); } catch { return line; }
  if (!Array.isArray(event?.choices)) return line;
  let changed = false;
  event.choices = event.choices.map((choice) => {
    if (!choice?.delta || !HIDDEN_MESSAGE_FIELDS.some((field) => field in choice.delta)) return choice;
    changed = true;
    return { ...choice, delta: stripHiddenReasoning(choice.delta) };
  });
  return changed ? `data: ${JSON.stringify(event)}` : line;
}

/**
 * POST /api/llm/chat — relay one chat completion (optionally streamed) to the
 * provider configured on the server.
 */
export async function relayChat(request, response, { env = process.env, fetchImpl = fetch, logger = console } = {}) {
  const status = llmStatus(env);
  if (!status.enabled) throw new HttpError(404, 'llm_proxy_disabled', 'The LLM relay is disabled on this server');
  if (!status.relay) throw new HttpError(404, 'llm_relay_not_enabled', 'The browser LLM relay is off; set LLM_HTTP_RELAY=true to expose it');
  const provider = resolveProvider(env);
  if (!provider) {
    throw new HttpError(503, 'llm_not_configured', 'No LLM provider is configured on the server (set DEEPSEEK_API_KEY, DASHSCOPE_API_KEY, OPENAI_API_KEY or LLM_BASE_URL + LLM_API_KEY)');
  }

  const chat = normalizeChatRequest(await readJsonBody(request, { limit: LLM_BODY_LIMIT_BYTES }), { maxTokensCap: maxTokensCap(env) });

  const maxConcurrent = Number(env.LLM_PROXY_MAX_CONCURRENCY) > 0 ? Number(env.LLM_PROXY_MAX_CONCURRENCY) : 4;
  if (inflight >= maxConcurrent) {
    response.setHeader('retry-after', '2');
    throw new HttpError(429, 'llm_busy', 'Too many concurrent LLM requests; retry shortly');
  }

  inflight += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const abortOnClientClose = () => { if (!response.writableEnded) controller.abort(); };
  response.on('close', abortOnClientClose);
  try {
    const { url, headers } = buildChatEndpoint(provider);
    let upstream;
    try {
      upstream = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody(chat, provider.model, env)),
        signal: controller.signal
      });
    } catch (cause) {
      logger.error(`[agentbl] LLM upstream ${provider.provider} unreachable: ${cause.message}`);
      throw new HttpError(502, 'llm_upstream_unreachable', 'The LLM provider could not be reached');
    }
    if (!upstream.ok) await failUpstream(upstream, provider.provider, logger);

    if (!chat.stream) {
      const json = await upstream.json().catch(() => null);
      const choice = json?.choices?.[0];
      const message = choice?.message;
      if (!message) throw new HttpError(502, 'llm_upstream_error', 'The LLM provider returned no message');
      // finish_reason + usage let the UI tell "the model ran out of max_tokens while thinking" (an empty
      // message with finish_reason "length") from a real answer; they carry no provider detail or secret.
      sendJson(response, 200, {
        ok: true,
        provider: provider.provider,
        model: provider.model,
        choices: [{ message: stripHiddenReasoning(message), finish_reason: choice.finish_reason ?? null }],
        usage: json.usage ?? null
      });
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    // Forward whole lines only, so each SSE event can be cleaned before it is sent.
    const decoder = new TextDecoder();
    let pending = '';
    const forward = async (text) => { if (text && !response.write(text)) await once(response, 'drain'); };
    for await (const chunk of upstream.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      await forward(lines.map((line) => `${stripReasoningFromSseLine(line.replace(/\r$/u, ''))}\n`).join(''));
    }
    pending += decoder.decode();
    await forward(pending ? stripReasoningFromSseLine(pending) : '');
    response.end();
  } catch (error) {
    if (controller.signal.aborted && response.headersSent) {
      // Client left or the upstream stalled mid-stream: nothing more to say.
      if (!response.writableEnded) response.end();
      return;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    response.off('close', abortOnClientClose);
    inflight -= 1;
  }
}
