import assert from 'node:assert/strict';
import test from 'node:test';
import { listAvailableLLMModels } from './modelCatalog.ts';
import {
  LLMProvider,
  MODEL_PRESETS_UPDATED_AT,
  PROVIDER_PRESETS,
  normalizeLLMModelList,
  type LLMConfig,
} from './types.ts';

function catalogConfig(provider: LLMConfig['provider'], baseUrl: string): LLMConfig {
  return {
    provider,
    apiKey: 'test-key',
    baseUrl,
    model: PROVIDER_PRESETS[provider].defaultModel,
  };
}

test('内置推荐模型已统一校准到 2026-09-04 官方 API ID', () => {
  assert.equal(MODEL_PRESETS_UPDATED_AT, '2026-09-04');
  assert.deepEqual(allPresetModels(LLMProvider.OPENAI), [
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-6-astra',
  ]);
  assert.deepEqual(allPresetModels(LLMProvider.CLAUDE), [
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-haiku-4-5-20251001',
    'claude-fable-5-1',
  ]);
  assert.deepEqual(allPresetModels(LLMProvider.DEEPSEEK), [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
  ]);
  assert.deepEqual(allPresetModels(LLMProvider.QWEN), ['qwen3.8-flash', 'qwen3.8-max']);
  assert.deepEqual(allPresetModels(LLMProvider.GLM), ['glm-5.3-flash', 'glm-5.3']);
  assert.deepEqual(allPresetModels(LLMProvider.MINIMAX), ['MiniMax-M3']);
  assert.deepEqual(allPresetModels(LLMProvider.MIMO), ['mimo-v2.5', 'mimo-v2.5-pro']);
  assert.deepEqual(allPresetModels(LLMProvider.KIMI), [
    'kimi-k2.6',
    'kimi-k3',
    'kimi-k2.7-code',
    'kimi-k2.7-code-highspeed',
  ]);

  const presets = JSON.stringify(PROVIDER_PRESETS);
  assert.doesNotMatch(presets, /deepseek-chat|deepseek-reasoner|moonshot-v1|glm-4-flash/);
});

test('OpenAI 模型目录只保留可对话模型并保留展示名', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';

  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return jsonResponse({
      data: [
        { id: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra' },
        { id: 'gpt-image-2' },
        { id: 'text-embedding-3-large' },
        { id: 'o3' },
        { id: 'gpt-5.6-terra' },
      ],
    });
  }) as typeof globalThis.fetch;

  try {
    const models = await listAvailableLLMModels(
      catalogConfig(LLMProvider.OPENAI, 'https://api.openai.com/v1/'),
    );
    assert.equal(requestedUrl, 'https://api.openai.com/v1/models');
    assert.deepEqual(models, [
      { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
      { id: 'o3' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Claude 模型目录使用原生鉴权、端点和 display_name', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedHeaders = new Headers();

  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    requestedHeaders = new Headers(init?.headers);
    return jsonResponse({
      data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }],
    });
  }) as typeof globalThis.fetch;

  try {
    const models = await listAvailableLLMModels(
      catalogConfig(LLMProvider.CLAUDE, 'https://api.anthropic.com/v1/'),
    );
    assert.equal(requestedUrl, 'https://api.anthropic.com/v1/models?limit=1000');
    assert.equal(requestedHeaders.get('x-api-key'), 'test-key');
    assert.equal(requestedHeaders.get('anthropic-version'), '2023-06-01');
    assert.equal(requestedHeaders.get('anthropic-dangerous-direct-browser-access'), 'true');
    assert.equal(requestedHeaders.has('authorization'), false);
    assert.deepEqual(models, [{ id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DeepSeek 旧版官方 /v1 地址读取根路径 /models', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';

  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return jsonResponse({
      data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
    });
  }) as typeof globalThis.fetch;

  try {
    const models = await listAvailableLLMModels(
      catalogConfig(LLMProvider.DEEPSEEK, 'https://api.deepseek.com/v1'),
    );
    assert.equal(requestedUrl, 'https://api.deepseek.com/models');
    assert.deepEqual(models.map(model => model.id), ['deepseek-v4-flash', 'deepseek-v4-pro']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Qwen 使用原生模型目录并只接收文本生成模型结构', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';

  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return jsonResponse({
      success: true,
      output: {
        models: [
          { model: 'qwen3.8-max', name: '通义千问3.8-Max' },
          { model: 'qwen-image-max', name: 'Qwen Image Max' },
          { model: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        ],
      },
    });
  }) as typeof globalThis.fetch;

  try {
    const models = await listAvailableLLMModels(
      catalogConfig(LLMProvider.QWEN, 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    );
    const url = new URL(requestedUrl);
    assert.equal(url.pathname, '/api/v1/models');
    assert.equal(url.searchParams.get('providers'), 'qwen');
    assert.equal(url.searchParams.get('capabilities'), 'TG');
    assert.equal(url.searchParams.get('page_size'), '100');
    assert.deepEqual(models, [{ id: 'qwen3.8-max', displayName: '通义千问3.8-Max' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MiMo 模型目录过滤 ASR/TTS，保留两个对话模型', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => jsonResponse({
    data: [
      { id: 'mimo-v2.5' },
      { id: 'mimo-v2.5-pro' },
      { id: 'mimo-v2.5-asr' },
      { id: 'mimo-v2.5-tts' },
      { id: 'mimo-v2.5-tts-voiceclone' },
    ],
  })) as typeof globalThis.fetch;

  try {
    const models = await listAvailableLLMModels(
      catalogConfig(LLMProvider.MIMO, 'https://api.xiaomimimo.com/v1'),
    );
    assert.deepEqual(models.map(model => model.id), ['mimo-v2.5', 'mimo-v2.5-pro']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('模型目录失败返回可读错误且不伪造空成功', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => jsonResponse(
    { error: { message: 'invalid api key' } },
    401,
  )) as typeof globalThis.fetch;

  try {
    await assert.rejects(
      listAvailableLLMModels(catalogConfig(LLMProvider.KIMI, 'https://api.moonshot.cn/v1')),
      /模型列表接口错误 \(401\): invalid api key/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function allPresetModels(provider: LLMConfig['provider']): string[] {
  const preset = PROVIDER_PRESETS[provider];
  return normalizeLLMModelList([
    ...preset.models,
    ...(preset.reasoningModels ?? []),
  ]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
