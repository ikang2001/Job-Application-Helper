import type {
  ChatContentPart,
  LLMChatOptions,
  LLMConfig,
  ChatMessage,
  LLMResponse,
} from './types';
import {
  LLMApiMode,
  LLMProvider,
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_CEILING,
  normalizeLLMConfig,
} from './types.ts';

/** 输出被 max_tokens 截断且正文为空时抛出，供上层决定是否加大额度重试 */
export class TruncatedEmptyOutputError extends Error {
  attemptedMaxTokens: number;

  constructor(attemptedMaxTokens: number) {
    super(
      `模型在 max_tokens=${attemptedMaxTokens} 下于思考阶段耗尽额度，未产出正文。`,
    );
    this.name = 'TruncatedEmptyOutputError';
    this.attemptedMaxTokens = attemptedMaxTokens;
  }
}

export class LLMService {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = normalizeLLMConfig(config);
  }

  /**
   * 发起对话。
   *
   * 输出额度从 DEFAULT_MAX_TOKENS 起算。若模型因思考耗尽额度而返回空正文，
   * 自动加倍重试，直到 MAX_TOKENS_CEILING 为止——推理模型的思考长度无法预估，
   * 界面上也不再暴露该设置，所以由这里自动试探。
   * 到上限仍失败即放弃，由调用方回退到本地规则解析。
   */
  async chat(
    messages: ChatMessage[],
    signal?: AbortSignal,
    options: LLMChatOptions = {},
  ): Promise<LLMResponse> {
    // 旧配置里可能存有更小的 maxTokens，不能让它把额度压到默认值以下
    let budget = Math.min(
      Math.max(this.config.maxTokens ?? 0, DEFAULT_MAX_TOKENS),
      MAX_TOKENS_CEILING,
    );

    for (;;) {
      try {
        if (this.config.provider === LLMProvider.CLAUDE) {
          return await this.callClaude(messages, signal, budget);
        }
        return this.config.apiMode === LLMApiMode.RESPONSES
          ? await this.callOpenAIResponses(messages, signal, budget, options)
          : await this.callOpenAICompatible(messages, signal, budget);
      } catch (error) {
        if (!(error instanceof TruncatedEmptyOutputError)) throw error;

        if (budget >= MAX_TOKENS_CEILING) {
          throw new Error(
            `模型已在 max_tokens 提升至上限 ${MAX_TOKENS_CEILING} 后仍未产出正文，`
            + '已停止使用 AI 解析。该模型的思考过程过长，请在「AI 模型设置」中改用非推理模型。',
          );
        }

        budget = Math.min(budget * 2, MAX_TOKENS_CEILING);
        console.warn(`Output truncated with empty content, retrying with max_tokens=${budget}`);
      }
    }
  }

  /** 去掉用户粘贴地址时常见的结尾斜杠，避免出现 //chat/completions */
  private trimmedBaseUrl(): string {
    return this.config.baseUrl.trim().replace(/\/+$/, '');
  }

  /**
   * Claude 的端点固定为 {base}/v1/messages。用户和旧配置里常把 /v1 写进 baseUrl，
   * 这里统一剥掉，避免拼成 /v1/v1/messages。
   */
  private claudeBaseUrl(): string {
    return this.trimmedBaseUrl().replace(/\/v1$/, '');
  }

  private async callOpenAICompatible(
    messages: ChatMessage[],
    signal: AbortSignal | undefined,
    maxTokens: number,
  ): Promise<LLMResponse> {
    const response = await fetch(`${this.trimmedBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: messages.map(message => ({
          ...message,
          content: toOpenAIContent(message.content),
        })),
        ...openAICompatibleSampling(this.config),
        ...openAICompatibleThinking(this.config),
        ...openAICompatibleTokenLimit(this.config.provider, maxTokens),
      }),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw normalizeLLMRequestError(
        `LLM API error (${response.status}): ${extractErrorMessage(error)}`,
      );
    }

    const data = await response.json();

    // 部分国产平台（如智谱、MiniMax）在 HTTP 200 下用 body 内的错误码报错
    const inlineError = data.error?.message ?? data.base_resp?.status_msg;
    if (inlineError && !data.choices?.length) {
      throw normalizeLLMRequestError(`LLM API error: ${inlineError}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      // 推理模型（如 mimo-v2.5-pro、DeepSeek V4 思考模式）可能因 max_tokens
      // 在思考阶段就耗尽，导致正文为空。抛专用错误让上层加大额度重试。
      const finishReason = data.choices?.[0]?.finish_reason;
      if (finishReason === 'length') {
        throw new TruncatedEmptyOutputError(maxTokens);
      }
      throw new Error('LLM 返回内容为空，请检查模型名称是否正确');
    }

    return {
      content,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
      } : undefined,
    };
  }

  private async callOpenAIResponses(
    messages: ChatMessage[],
    signal: AbortSignal | undefined,
    maxTokens: number,
    options: LLMChatOptions,
  ): Promise<LLMResponse> {
    const instructions = messages
      .filter(message => message.role === 'system')
      .map(message => toSystemText(message.content))
      .filter(Boolean)
      .join('\n\n');
    const input = messages
      .filter(message => message.role !== 'system')
      .map((message) => {
        const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user';
        return {
          role,
          content: toOpenAIResponsesContent(message.content),
        };
      });
    const response = await fetch(`${this.trimmedBaseUrl()}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input,
        ...(instructions ? { instructions } : {}),
        max_output_tokens: maxTokens,
        ...(options.reasoningEffort ? {
          reasoning: { effort: options.reasoningEffort },
        } : {}),
        // 求职资料可能包含个人信息；本地客户端默认不请求服务端持久化响应。
        store: false,
        ...(options.jsonSchema ? {
          text: {
            format: {
              type: 'json_schema',
              name: options.jsonSchema.name,
              strict: true,
              schema: options.jsonSchema.schema,
            },
          },
        } : {}),
      }),
      signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw normalizeLLMRequestError(
        `OpenAI Responses API error (${response.status}): ${extractErrorMessage(raw)}`,
      );
    }

    let data: OpenAIResponsesResult;
    try {
      data = JSON.parse(raw) as OpenAIResponsesResult;
    } catch {
      throw new Error(`OpenAI Responses API 返回的不是 JSON。响应开头：${raw.slice(0, 80)}`);
    }

    if (data.status === 'failed' || data.status === 'cancelled') {
      throw new Error(
        `OpenAI Responses API 请求${data.status === 'failed' ? '失败' : '已取消'}：`
        + (data.error?.message || '未返回具体原因'),
      );
    }

    const content = extractOpenAIResponsesText(data);
    if (!content) {
      if (data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens') {
        throw new TruncatedEmptyOutputError(maxTokens);
      }
      throw new Error('OpenAI Responses API 返回内容为空，请检查模型名称是否正确');
    }

    return {
      content,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
      } : undefined,
    };
  }

  private async callClaude(
    messages: ChatMessage[],
    signal: AbortSignal | undefined,
    maxTokens: number,
  ): Promise<LLMResponse> {
    const systemMsg = toSystemText(messages.find(m => m.role === 'system')?.content);
    const nonSystemMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: toClaudeContent(m.content),
      }));

    const response = await fetch(`${this.claudeBaseUrl()}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        // 官方 API 默认拒绝浏览器发起的请求，扩展环境需显式声明
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this.config.model,
        system: systemMsg,
        messages: nonSystemMessages,
        max_tokens: maxTokens,
        // Claude 4.7+ 只接受默认 temperature；Claude 5 又默认开启 adaptive thinking。
        // 省略此参数同时兼容新模型与旧模型，避免固定 0.7 被官方接口拒绝。
      }),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw normalizeLLMRequestError(
        `Claude API error (${response.status}): ${extractErrorMessage(error)}`,
      );
    }

    // 中转站地址填错时常返回 200 + 网站 HTML，这里给出可定位的提示而非 JSON 解析错误
    const raw = await response.text();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `Claude API 返回的不是 JSON，请检查 Base URL 是否正确（当前请求 ${this.claudeBaseUrl()}/v1/messages）。响应开头：${raw.slice(0, 80)}`,
      );
    }

    // Claude 开启 thinking 时首个 block 可能是 thinking，需取文本 block
    const content = Array.isArray(data.content)
      ? data.content.find((block: any) => block?.type === 'text')?.text
        ?? data.content[0]?.text
      : undefined;

    if (typeof content !== 'string' || content.trim() === '') {
      if (data.stop_reason === 'max_tokens') {
        throw new TruncatedEmptyOutputError(maxTokens);
      }
      throw new Error(
        `Claude 返回内容为空或格式异常，请检查模型名称是否正确。${extractErrorMessage(raw)}`,
      );
    }

    return {
      content,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
      } : undefined,
    };
  }

  /** 连通性测试：失败时抛出原始错误，便于界面显示具体原因 */
  async testConnection(): Promise<void> {
    await this.chat([{ role: 'user', content: 'Hi. Reply with just "ok".' }]);
  }
}

/** 各家平台的错误体格式不一，尽量抽出可读的一句话，否则退回原始文本 */
function extractErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return (
      parsed.error?.message ??
      parsed.base_resp?.status_msg ??
      parsed.message ??
      raw
    );
  } catch {
    return raw;
  }
}

function normalizeLLMRequestError(message: string): Error {
  return isImageUnsupportedError(message)
    ? new Error('当前模型不支持图片输入')
    : new Error(message);
}

/** 当前 Kimi 模型只接受固定温度，省略比发送旧默认值 0.7 更兼容。 */
function openAICompatibleSampling(config: LLMConfig): Record<string, number> {
  return config.provider === LLMProvider.KIMI
    ? {}
    : { temperature: config.temperature ?? 0.7 };
}

/**
 * 求职解析与填表需要稳定正文，而不是长思维链。对官方明确支持关闭思考的
 * 当前混合模型显式关闭；Kimi K3 无法关闭，只把推理强度降到 low。
 */
function openAICompatibleThinking(config: LLMConfig): Record<string, unknown> {
  const model = config.model.trim().toLowerCase();

  if (config.provider === LLMProvider.DEEPSEEK && model.startsWith('deepseek-v4-')) {
    return { thinking: { type: 'disabled' } };
  }
  if (config.provider === LLMProvider.QWEN && model.startsWith('qwen3.8-')) {
    return { enable_thinking: false, preserve_thinking: false };
  }
  if (config.provider === LLMProvider.GLM && model.startsWith('glm-5.3')) {
    // GLM-5.3 系列只允许开启思考，通过 low 控制正文所需的输出预算。
    return { thinking: { type: 'enabled' }, reasoning_effort: 'low' };
  }
  if (config.provider === LLMProvider.MINIMAX && model === 'minimax-m3') {
    return { thinking: { type: 'disabled' } };
  }
  if (config.provider === LLMProvider.MIMO && /^mimo-v2\.5(?:-pro)?$/.test(model)) {
    return { thinking: { type: 'disabled' } };
  }
  if (config.provider === LLMProvider.KIMI && model === 'kimi-k2.6') {
    return { thinking: { type: 'disabled' } };
  }
  if (config.provider === LLMProvider.KIMI && model === 'kimi-k3') {
    return { reasoning_effort: 'low' };
  }

  return {};
}

/** Kimi、MiniMax 与 MiMo 的当前 API 已把 max_tokens 替换为该字段。 */
function openAICompatibleTokenLimit(
  provider: LLMProvider,
  maxTokens: number,
): Record<string, number> {
  const usesCompletionLimit = provider === LLMProvider.KIMI
    || provider === LLMProvider.MINIMAX
    || provider === LLMProvider.MIMO;
  return usesCompletionLimit
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function isImageUnsupportedError(message: string): boolean {
  const normalized = message.toLowerCase();
  const hints = [
    'does not support image',
    'doesn\'t support image',
    'unsupported image',
    'image input',
    'image_url',
    'vision',
    'multimodal',
    'multi-modal',
    'input_image',
    'unsupported content type',
  ];
  return hints.some(hint => normalized.includes(hint));
}

function toOpenAIContent(content: ChatMessage['content']) {
  if (typeof content === 'string') return content;

  return content.map(part => (
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image_url',
          image_url: { url: `data:${part.mimeType};base64,${part.data}` },
        }
  ));
}

interface OpenAIResponsesResult {
  status?: string;
  error?: { message?: string } | null;
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  incomplete_details?: { reason?: string } | null;
  usage?: { input_tokens: number; output_tokens: number };
}

function extractOpenAIResponsesText(data: OpenAIResponsesResult): string {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  return (data.output ?? [])
    .filter(item => item.type === 'message')
    .flatMap(item => item.content ?? [])
    .filter(part => part.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

function toOpenAIResponsesContent(
  content: ChatMessage['content'],
) {
  if (typeof content === 'string') return content;

  return content.map(part => (
    part.type === 'text'
      ? { type: 'input_text', text: part.text }
      : {
          type: 'input_image',
          image_url: `data:${part.mimeType};base64,${part.data}`,
        }
  ));
}

function toSystemText(content: ChatMessage['content'] | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;

  return content
    .filter((part): part is Extract<ChatContentPart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

function toClaudeContent(content: ChatMessage['content']) {
  if (typeof content === 'string') return content;

  return content.map(part => (
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mimeType,
            data: part.data,
          },
        }
  ));
}
