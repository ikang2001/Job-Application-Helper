import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMProvider, type LLMConfig } from './types.ts';
import { supportsVisionInput } from './visionCapabilities.ts';

test('OpenAI 当前推荐模型被识别为支持视觉输入', () => {
  const config: LLMConfig = {
    provider: LLMProvider.OPENAI,
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-terra',
  };

  assert.deepEqual(supportsVisionInput(config), { supported: true });
});

test('custom 服务商未显式开启视觉能力时被阻断', () => {
  const config: LLMConfig = {
    provider: LLMProvider.CUSTOM,
    apiKey: 'sk-test',
    baseUrl: 'https://example.com/v1',
    model: 'my-vision-model',
  };

  assert.deepEqual(supportsVisionInput(config), {
    supported: false,
    reason: 'CUSTOM_VISION_DISABLED',
  });
});

test('custom 服务商显式开启视觉能力后允许通过', () => {
  const config: LLMConfig = {
    provider: LLMProvider.CUSTOM,
    apiKey: 'sk-test',
    baseUrl: 'https://example.com/v1',
    model: 'my-vision-model',
    visionEnabled: true,
  };

  assert.deepEqual(supportsVisionInput(config), { supported: true });
});

test('未填写模型时返回 NO_MODEL', () => {
  const config: LLMConfig = {
    provider: LLMProvider.OPENAI,
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    model: '   ',
  };

  assert.deepEqual(supportsVisionInput(config), {
    supported: false,
    reason: 'NO_MODEL',
  });
});

test('内置服务商未登记视觉能力的模型返回 PROVIDER_UNSUPPORTED', () => {
  const config: LLMConfig = {
    provider: LLMProvider.QWEN,
    apiKey: 'sk-test',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-turbo',
  };

  assert.deepEqual(supportsVisionInput(config), {
    supported: false,
    reason: 'PROVIDER_UNSUPPORTED',
  });
});

test('国产服务商当前多模态模型可通过视觉预检查', () => {
  const models: Array<[LLMConfig['provider'], string]> = [
    [LLMProvider.DEEPSEEK, 'deepseek-v4-flash-vision-exp'],
    [LLMProvider.QWEN, 'qwen3.8-flash'],
    [LLMProvider.GLM, 'glm-5.3-flash'],
    [LLMProvider.MINIMAX, 'MiniMax-M3'],
    [LLMProvider.MIMO, 'mimo-v2.5'],
    [LLMProvider.KIMI, 'kimi-k3'],
  ];

  for (const [provider, model] of models) {
    assert.deepEqual(supportsVisionInput({
      provider,
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/v1',
      model,
    }), { supported: true }, `${provider}/${model} 应支持视觉输入`);
  }
});
