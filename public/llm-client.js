// 浏览器端 LLM 客户端 —— 只与同源的 /api/llm/* 通信。
//
// API Key 保存在服务器（.env）里，永远不会下发到浏览器；服务器负责选择模型、
// 限制输出长度并转发到已配置的提供方（DeepSeek / 通义千问 / OpenAI 兼容端点…）。
//
// 支持：
// - 流式 SSE 响应
// - Function Calling（工具调用）
// - 超时与错误处理
//
// 依赖：fetch（浏览器原生）、TextDecoder

const LLM_CONFIG = {
  ENDPOINT: '/api/llm/chat',
  STATUS_ENDPOINT: '/api/llm/status',
  TIMEOUT_MS: 60000,
  // No max_tokens here on purpose: the server owns the output limit (LLM_MAX_TOKENS_CAP, default 2048, 0 = none),
  // so the browser must not hard-code a number that silently truncates a reasoning model's hidden thinking.
  TEMPERATURE: 0.3
};

/** 生成唯一 ID */
function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 将 tool 定义转换为 OpenAI function calling 格式
 * @param {Array<{name:string, description:string, parameters?:object}>} tools
 * @returns {Array} OpenAI tools 格式
 */
function toOpenAITools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {}, required: [] }
    }
  }));
}

/** 服务器返回的错误（如 503 未配置 LLM、429 限流）。message 可直接展示给用户。 */
export class LlmError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
  }
}

async function failFromResponse(response) {
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* 非 JSON 错误体 */ }
  throw new LlmError(payload?.error || `LLM relay HTTP ${response.status}`, {
    status: response.status,
    code: payload?.code
  });
}

/** 询问服务器是否已配置 LLM（不会暴露密钥）。网络失败视为未配置（reachable: false）。 */
export async function fetchLlmStatus() {
  try {
    const response = await fetch(LLM_CONFIG.STATUS_ENDPOINT);
    if (!response.ok) return { enabled: false, configured: false, reachable: false };
    return { ...(await response.json()), reachable: true };
  } catch (_) {
    return { enabled: false, configured: false, reachable: false };
  }
}

let _statusPromise = null;
/**
 * 每个页面只询问一次：服务器运行期间 LLM 配置不会变。没有配置时调用方可以直接走
 * 关键词回退，而不是先发一个注定 503 的请求；网络失败不缓存，下次再试。
 */
export function getLlmStatus() {
  if (!_statusPromise) {
    _statusPromise = fetchLlmStatus().then((status) => {
      if (!status.reachable) _statusPromise = null;
      return status;
    });
  }
  return _statusPromise;
}

function parseToolArguments(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return { _raw: raw };
  }
}

/**
 * LLM 聊天客户端（经服务器转发）
 */
export class LlmClient {
  constructor(config = {}) {
    this.endpoint = config.endpoint || LLM_CONFIG.ENDPOINT;
    this.timeout = config.timeout || LLM_CONFIG.TIMEOUT_MS;
  }

  _requestBody(messages, tools, stream) {
    const body = {
      messages,
      stream,
      temperature: LLM_CONFIG.TEMPERATURE
    };
    if (tools && tools.length > 0) body.tools = toOpenAITools(tools);
    return body;
  }

  /**
   * 流式聊天（支持 Function Calling）
   *
   * @param {Array<{role:string, content:string|object, tool_calls?:Array}>} messages - 对话历史
   * @param {Array<{name:string, description:string, parameters?:object}>} tools - 可用工具列表
   * @param {object} callbacks
   * @param {function(string):void} callbacks.onChunk - 收到文本增量
   * @param {function({name:string, args:object}):void} callbacks.onToolCall - 收到工具调用
   * @param {function(string):void} callbacks.onThinking - 收到思考内容（推理模型）
   * @returns {Promise<{content:string|null, tool_calls:Array|null}>} 完整响应
   */
  async streamChat(messages, tools, { onChunk, onToolCall, onThinking } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._requestBody(messages, tools, true)),
        signal: controller.signal
      });
      if (!response.ok) await failFromResponse(response);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let content = '';
      const toolCallMap = {}; // index -> { id, name, arguments }
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const delta = JSON.parse(dataStr).choices?.[0]?.delta;
            if (!delta) continue;

            // 文本内容
            if (delta.content) {
              content += delta.content;
              onChunk?.(delta.content);
            }

            // 思考内容（推理模型）
            if (delta.reasoning_content) {
              onThinking?.(delta.reasoning_content);
            }

            // 工具调用
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallMap[idx]) {
                  toolCallMap[idx] = { id: tc.id || uid(), name: tc.function?.name || '', arguments: '' };
                }
                if (tc.id) toolCallMap[idx].id = tc.id;
                if (tc.function?.name) toolCallMap[idx].name = tc.function.name;
                if (tc.function?.arguments) toolCallMap[idx].arguments += tc.function.arguments;

                onToolCall?.({
                  name: toolCallMap[idx].name,
                  args: toolCallMap[idx].arguments,
                  id: toolCallMap[idx].id,
                  partial: true
                });
              }
            }
          } catch (_) {
            // 无法解析的行，跳过
          }
        }
      }

      // 组装完整 tool_calls
      const toolCalls = Object.keys(toolCallMap)
        .sort((a, b) => Number(a) - Number(b))
        .map((i) => ({
          id: toolCallMap[i].id,
          name: toolCallMap[i].name,
          arguments: parseToolArguments(toolCallMap[i].arguments)
        }));

      return {
        content: content || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : null
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 非流式聊天（用于简单的单轮 tool 调用）
   */
  async chat(messages, tools) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._requestBody(messages, tools, false)),
        signal: controller.signal
      });
      if (!response.ok) await failFromResponse(response);

      const json = await response.json();
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new LlmError('LLM returned no message');

      const tool_calls = msg.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: parseToolArguments(tc.function.arguments)
      }));

      return {
        content: msg.content || null,
        tool_calls: tool_calls || null,
        finish_reason: json.choices?.[0]?.finish_reason ?? null
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 默认单例 */
let _instance = null;
export function getLlmClient() {
  if (!_instance) _instance = new LlmClient();
  return _instance;
}

export { LLM_CONFIG, toOpenAITools };
