import { LLMProvider, type LLMConfig } from './types.ts';

export type VisionSupportReason =
  | 'NO_MODEL'
  | 'PROVIDER_UNSUPPORTED'
  | 'CUSTOM_VISION_DISABLED';

export type VisionSupportResult =
  | { supported: true }
  | { supported: false; reason: VisionSupportReason };

type BuiltinVisionMatrix = Record<Exclude<LLMProvider, 'custom'>, readonly string[]>;

const BUILTIN_VISION_MODELS: BuiltinVisionMatrix = {
  [LLMProvider.OPENAI]: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  [LLMProvider.CLAUDE]: [
    'claude-fable-5-1',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
  ],
  [LLMProvider.DEEPSEEK]: ['deepseek-v4-flash-vision-exp'],
  [LLMProvider.QWEN]: ['qwen3.8-max', 'qwen3.8-flash'],
  [LLMProvider.GLM]: ['glm-5.3-flash'],
  [LLMProvider.MINIMAX]: ['MiniMax-M3'],
  [LLMProvider.MIMO]: ['mimo-v2.5'],
  [LLMProvider.KIMI]: ['kimi-k3', 'kimi-k2.6'],
};

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}

function getBuiltinVisionModels(provider: Exclude<LLMProvider, 'custom'>): Set<string> {
  return new Set(BUILTIN_VISION_MODELS[provider].map(normalizeModelName));
}

export function supportsVisionInput(config: LLMConfig): VisionSupportResult {
  const model = normalizeModelName(config.model);
  if (!model) {
    return { supported: false, reason: 'NO_MODEL' };
  }

  if (config.provider === LLMProvider.CUSTOM) {
    return config.visionEnabled
      ? { supported: true }
      : { supported: false, reason: 'CUSTOM_VISION_DISABLED' };
  }

  return getBuiltinVisionModels(config.provider).has(model)
    ? { supported: true }
    : { supported: false, reason: 'PROVIDER_UNSUPPORTED' };
}
