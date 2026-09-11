import {
  LLMProvider,
  PROVIDER_PRESETS,
  type LLMConfig,
  type LLMModelInfo,
  type LLMModelListMode,
} from './types.ts';

interface ModelListRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * 从服务商目录读取当前 API Key 可见的对话模型。
 *
 * 这里只负责模型目录协议；对话仍严格使用 LLMConfig.apiMode，不能根据模型名
 * 改写 Responses / Chat Completions transport。
 */
export async function listAvailableLLMModels(
  config: LLMConfig,
  signal?: AbortSignal,
): Promise<LLMModelInfo[]> {
  const mode = PROVIDER_PRESETS[config.provider].modelListMode;
  if (!mode) {
    throw new Error(`${PROVIDER_PRESETS[config.provider].label} 暂未提供可用的官方模型列表接口`);
  }

  const request = buildModelListRequest(config, mode);
  const response = await fetch(request.url, {
    method: 'GET',
    headers: request.headers,
    signal,
  });
  const raw = await response.text();

  if (!response.ok) {
    throw new Error(
      `模型列表接口错误 (${response.status}): ${extractModelListError(raw)}`,
    );
  }

  const payload = parseModelListResponse(raw);
  const entries = extractModelEntries(payload, mode);
  const inlineError = extractInlineError(payload);
  if (inlineError && entries.length === 0) {
    throw new Error(`模型列表接口错误: ${inlineError}`);
  }

  const models = normalizeModelEntries(entries)
    .filter(model => isConversationModel(config.provider, model.id));

  if (models.length === 0) {
    throw new Error('服务商未返回可用于对话的模型；内置推荐和已保存模型均未被修改');
  }

  return models;
}

function buildModelListRequest(
  config: LLMConfig,
  mode: LLMModelListMode,
): ModelListRequest {
  const commonHeaders = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (mode === 'anthropic') {
    return {
      url: `${stripTrailingV1(config.baseUrl)}/v1/models?limit=1000`,
      headers: {
        ...commonHeaders,
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    };
  }

  return {
    url: mode === 'qwen'
      ? buildQwenModelListUrl(config.baseUrl)
      : buildOpenAICompatibleModelListUrl(config),
    headers: {
      ...commonHeaders,
      Authorization: `Bearer ${config.apiKey}`,
    },
  };
}

function buildOpenAICompatibleModelListUrl(config: LLMConfig): string {
  const baseUrl = trimTrailingSlashes(config.baseUrl);
  if (config.provider !== LLMProvider.DEEPSEEK) return `${baseUrl}/models`;

  try {
    const url = new URL(baseUrl);
    if (url.hostname === 'api.deepseek.com' && url.pathname.replace(/\/+$/, '') === '/v1') {
      return `${url.origin}/models`;
    }
  } catch {
    // 非标准代理地址仍按用户填写值拼接，错误由实际请求返回。
  }

  return `${baseUrl}/models`;
}

function buildQwenModelListUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error('API 地址格式无效，无法读取 Qwen 模型列表');
  }

  url.pathname = '/api/v1/models';
  url.search = '';
  url.searchParams.append('providers', 'qwen');
  url.searchParams.append('capabilities', 'TG');
  url.searchParams.set('page_no', '1');
  url.searchParams.set('page_size', '100');
  return url.toString();
}

function stripTrailingV1(baseUrl: string): string {
  return trimTrailingSlashes(baseUrl).replace(/\/v1$/, '');
}

function trimTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function parseModelListResponse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`模型列表接口返回的不是 JSON。响应开头：${raw.slice(0, 80)}`);
  }
}

function extractModelEntries(payload: unknown, mode: LLMModelListMode): unknown[] {
  const root = asRecord(payload);
  if (!root) return [];

  if (mode === 'qwen') {
    const output = asRecord(root.output);
    return Array.isArray(output?.models) ? output.models : [];
  }

  if (Array.isArray(root.data)) return root.data;
  if (Array.isArray(root.models)) return root.models;
  return [];
}

function normalizeModelEntries(entries: readonly unknown[]): LLMModelInfo[] {
  const seen = new Set<string>();
  const models: LLMModelInfo[] = [];

  for (const entry of entries) {
    const record = asRecord(entry);
    const id = readString(record?.id) ?? readString(record?.model);
    if (!id || seen.has(id)) continue;

    const displayName = readString(record?.display_name) ?? readString(record?.name);
    seen.add(id);
    models.push({
      id,
      ...(displayName && displayName !== id ? { displayName } : {}),
    });
  }

  return models;
}

function isConversationModel(provider: LLMProvider, modelId: string): boolean {
  const id = modelId.toLowerCase();

  if (provider === LLMProvider.OPENAI) return isOpenAIConversationModel(id);
  if (provider === LLMProvider.CLAUDE) return id.startsWith('claude-');
  if (provider === LLMProvider.DEEPSEEK) return id.startsWith('deepseek-');
  if (provider === LLMProvider.QWEN) return isQwenConversationModel(id);
  if (provider === LLMProvider.MINIMAX) return id.startsWith('minimax-m');
  if (provider === LLMProvider.MIMO) {
    return id.startsWith('mimo-') && !/(?:-asr|-tts(?:-|$))/.test(id);
  }
  if (provider === LLMProvider.KIMI) return id.startsWith('kimi-') || id.startsWith('moonshot-');
  return true;
}

function isOpenAIConversationModel(id: string): boolean {
  if (!(id.startsWith('gpt-') || /^o\d/.test(id) || id.startsWith('ft:gpt-'))) return false;

  const nonConversationHints = [
    'audio',
    'embedding',
    'image',
    'moderation',
    'realtime',
    'search',
    'transcribe',
    'tts',
  ];
  return !nonConversationHints.some(hint => id.includes(hint));
}

function isQwenConversationModel(id: string): boolean {
  if (!id.startsWith('qwen')) return false;
  const nonConversationHints = ['-asr', '-audio', '-embedding', '-image', '-rerank', '-tts'];
  return !nonConversationHints.some(hint => id.includes(hint));
}

function extractInlineError(payload: unknown): string | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;

  const error = asRecord(root.error);
  const baseResponse = asRecord(root.base_resp);
  return readString(error?.message)
    ?? readString(baseResponse?.status_msg)
    ?? (root.success === false ? readString(root.message) : undefined);
}

function extractModelListError(raw: string): string {
  try {
    const root = asRecord(JSON.parse(raw) as unknown);
    const error = asRecord(root?.error);
    const baseResponse = asRecord(root?.base_resp);
    return readString(error?.message)
      ?? readString(baseResponse?.status_msg)
      ?? readString(root?.message)
      ?? raw;
  } catch {
    return raw;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}
