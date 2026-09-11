/**
 * 服务商标识。
 *
 * 用 const 对象而非 enum：enum 需要运行时代码生成，Node 的
 * --experimental-strip-types 无法执行，会让本模块无法被测试直接加载。
 * 常量与类型同名可以合并声明，`LLMProvider.CLAUDE` 与 `provider: LLMProvider`
 * 两种用法保持不变。
 */
export const LLMProvider = {
  OPENAI: 'openai',
  CLAUDE: 'claude',
  DEEPSEEK: 'deepseek',
  QWEN: 'qwen',
  GLM: 'glm',
  MINIMAX: 'minimax',
  MIMO: 'mimo',
  KIMI: 'kimi',
  CUSTOM: 'custom',
} as const;

export type LLMProvider = typeof LLMProvider[keyof typeof LLMProvider];

/**
 * OpenAI 兼容服务的请求协议。
 *
 * 旧配置没有该字段，运行时会继续按 Chat Completions 处理；新选择的
 * OpenAI 配置默认使用官方 Responses API。
 */
export const LLMApiMode = {
  RESPONSES: 'responses',
  CHAT_COMPLETIONS: 'chat-completions',
} as const;

export type LLMApiMode = typeof LLMApiMode[keyof typeof LLMApiMode];

/** 服务商官方模型目录的协议；仅影响读取模型列表，不影响对话 transport。 */
export type LLMModelListMode = 'openai-compatible' | 'anthropic' | 'qwen';

/** 模型目录中的展示信息。请求始终使用 id，displayName 只用于界面。 */
export interface LLMModelInfo {
  id: string;
  displayName?: string;
}

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  /** 当前使用的模型；保留该字段以兼容现有调用方和旧备份。 */
  model: string;
  /** 可切换的模型列表，model 始终指向其中一项。 */
  models?: string[];
  /** Claude 使用原生 Messages API，此字段只作用于 OpenAI 兼容服务。 */
  apiMode?: LLMApiMode;
  temperature?: number;
  maxTokens?: number;
  visionEnabled?: boolean;
}

export function normalizeLLMModelList(models: readonly string[] | undefined, activeModel = ''): string[] {
  const seen = new Set<string>();
  return [activeModel, ...(models ?? [])]
    .map(model => model.trim())
    .filter((model) => {
      if (!model || seen.has(model)) return false;
      seen.add(model);
      return true;
    });
}

export function normalizeLLMConfig(config: LLMConfig): LLMConfig {
  const models = normalizeLLMModelList(config.models, config.model);
  return {
    ...config,
    model: models[0] ?? '',
    models,
    // 兼容旧版：原实现统一调用 /chat/completions。
    apiMode: config.apiMode ?? LLMApiMode.CHAT_COMPLETIONS,
  };
}

export function defaultApiModeForProvider(provider: LLMProvider): LLMApiMode {
  return provider === LLMProvider.OPENAI
    ? LLMApiMode.RESPONSES
    : LLMApiMode.CHAT_COMPLETIONS;
}

/**
 * 输出上限默认值。
 *
 * 推理模型（DeepSeek V4 思考模式、mimo-v2.5-pro、MiniMax-M3 思考模式等）会先消耗
 * 大量 token 思考，思考内容也计入 max_tokens。简历解析的 JSON 本身就要
 * 1500~2500 token，若上限只有 4096，思考阶段就耗尽，正文返回空。
 */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * 截断重试允许自动提升到的上限。到此仍拿不到正文即放弃 AI 解析，
 * 回退本地规则，避免无限重试推高费用。
 */
export const MAX_TOKENS_CEILING = 32768;

/** 内置推荐模型最后一次按各服务商官方文档校准的日期。 */
export const MODEL_PRESETS_UPDATED_AT = '2026-09-04';

export const PROVIDER_PRESETS: Record<LLMProvider, {
  /** 下拉框中展示的名称 */
  label: string;
  /** OpenAI 兼容协议的 API 根地址（不含 /chat/completions） */
  baseUrl: string;
  /**
   * 选中该服务商时自动填入的默认模型，优先选择当前通用且成本可控的型号。
   */
  defaultModel: string;
  /** 当前推荐模型；账号实际可用范围以官方模型目录接口为准。 */
  models: string[];
  /** 已知的推理密集型补充模型，仅用于在界面上提示输出额度风险。 */
  reasoningModels?: string[];
  /** 该服务商当前在售模型均为推理模型时置为 true */
  reasoningOnly?: boolean;
  /** 官方模型目录协议；未配置表示该服务商没有可安全调用的列表接口。 */
  modelListMode?: LLMModelListMode;
  /** 营销显示名与真实 API model ID 分离，避免把显示名直接发给接口。 */
  modelLabels?: Readonly<Record<string, string>>;
  /** 获取 API Key 的控制台地址 */
  consoleUrl?: string;
}> = {
  [LLMProvider.OPENAI]: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6-terra',
    models: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol'],
    // Astra 正在分阶段开放，保留为可选项而不设为默认。
    reasoningModels: ['gpt-6-astra'],
    modelListMode: 'openai-compatible',
    modelLabels: {
      'gpt-6-astra': 'GPT-6 Astra',
      'gpt-5.6-sol': 'GPT-5.6 Sol',
      'gpt-5.6-terra': 'GPT-5.6 Terra',
      'gpt-5.6-luna': 'GPT-5.6 Luna',
    },
    consoleUrl: 'https://platform.openai.com/api-keys',
  },
  [LLMProvider.CLAUDE]: {
    label: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
    // Fable 5.1 的 adaptive thinking 始终开启，单列提示输出额度风险。
    reasoningModels: ['claude-fable-5-1'],
    modelListMode: 'anthropic',
    modelLabels: {
      'claude-fable-5-1': 'Claude Fable 5.1',
      'claude-opus-5': 'Claude Opus 5',
      'claude-sonnet-5': 'Claude Sonnet 5',
      'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
    },
    consoleUrl: 'https://console.anthropic.com/settings/keys',
  },
  [LLMProvider.DEEPSEEK]: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    modelListMode: 'openai-compatible',
    modelLabels: {
      'deepseek-v4-flash': 'DeepSeek V4 Flash',
      'deepseek-v4-pro': 'DeepSeek V4 Pro',
    },
    consoleUrl: 'https://platform.deepseek.com/api_keys',
  },
  [LLMProvider.QWEN]: {
    label: 'Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.8-flash',
    models: ['qwen3.8-flash', 'qwen3.8-max'],
    modelListMode: 'qwen',
    modelLabels: {
      'qwen3.8-flash': 'Qwen3.8 Flash',
      'qwen3.8-max': 'Qwen3.8 Max',
    },
    consoleUrl: 'https://bailian.console.aliyun.com/',
  },
  [LLMProvider.GLM]: {
    label: 'GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3-flash',
    models: [],
    reasoningModels: ['glm-5.3-flash', 'glm-5.3'],
    reasoningOnly: true,
    modelLabels: {
      'glm-5.3-flash': 'GLM-5.3-Flash',
      'glm-5.3': 'GLM-5.3',
    },
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  [LLMProvider.MINIMAX]: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M3',
    models: ['MiniMax-M3'],
    modelListMode: 'openai-compatible',
    modelLabels: { 'MiniMax-M3': 'MiniMax M3' },
    consoleUrl: 'https://platform.minimax.io/',
  },
  [LLMProvider.MIMO]: {
    label: 'MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5',
    models: ['mimo-v2.5'],
    reasoningModels: ['mimo-v2.5-pro'],
    modelListMode: 'openai-compatible',
    modelLabels: {
      'mimo-v2.5': 'MiMo V2.5',
      'mimo-v2.5-pro': 'MiMo V2.5 Pro',
    },
    consoleUrl: 'https://mimo.mi.com/',
  },
  [LLMProvider.KIMI]: {
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k2.6'],
    reasoningModels: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed'],
    modelListMode: 'openai-compatible',
    modelLabels: {
      'kimi-k3': 'Kimi K3',
      'kimi-k2.6': 'Kimi K2.6',
      'kimi-k2.7-code': 'Kimi K2.7 Code',
      'kimi-k2.7-code-highspeed': 'Kimi K2.7 Code Highspeed',
    },
    consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  [LLMProvider.CUSTOM]: {
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    defaultModel: '',
    models: [],
    modelListMode: 'openai-compatible',
  },
};

/** 下拉框渲染顺序 */
export const PROVIDER_ORDER: LLMProvider[] = [
  LLMProvider.DEEPSEEK,
  LLMProvider.QWEN,
  LLMProvider.GLM,
  LLMProvider.MINIMAX,
  LLMProvider.MIMO,
  LLMProvider.KIMI,
  LLMProvider.OPENAI,
  LLMProvider.CLAUDE,
  LLMProvider.CUSTOM,
];

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface LLMChatOptions {
  /** OpenAI Responses API 可用的严格 JSON Schema；其他服务商继续依赖提示词。 */
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
  };
  /** OpenAI Responses 推理强度；字段映射等简单任务使用 low 减少等待。 */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface LLMResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
}
