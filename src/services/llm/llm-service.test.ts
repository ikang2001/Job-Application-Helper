import assert from 'node:assert/strict';
import test from 'node:test';
import { LLMService } from './llmService.ts';
import {
  LLMApiMode,
  LLMProvider,
  PROVIDER_PRESETS,
  PROVIDER_ORDER,
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_CEILING,
  defaultApiModeForProvider,
  normalizeLLMConfig,
  normalizeLLMModelList,
} from './types.ts';

const baseConfig = {
  provider: LLMProvider.MIMO,
  apiKey: 'test-key',
  baseUrl: 'https://example.com/v1',
  model: 'mimo-v2.5-pro',
};

/** 记录每次请求的 max_tokens，并按 handler 决定返回体 */
function stubFetch(handler: (maxTokens: number, call: number) => unknown) {
  const budgets: number[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    const budget = body.max_tokens ?? body.max_completion_tokens;
    budgets.push(budget);
    return new Response(JSON.stringify(handler(budget, budgets.length)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  return { budgets, restore: () => { globalThis.fetch = originalFetch; } };
}

/** 推理模型思考耗尽额度时的响应：finish_reason=length 且正文为空 */
const truncated = { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
const ok = { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] };

test('默认输出上限不再是导致推理模型返回空正文的 4096', () => {
  assert.ok(DEFAULT_MAX_TOKENS >= 8192, `默认额度过低：${DEFAULT_MAX_TOKENS}`);
});

test('未配置 maxTokens 时使用默认额度', async () => {
  const stub = stubFetch(() => ok);
  try {
    await new LLMService(baseConfig).chat([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(stub.budgets, [DEFAULT_MAX_TOKENS]);
  } finally {
    stub.restore();
  }
});

test('思考耗尽额度返回空正文时自动加倍重试', async () => {
  const stub = stubFetch((_max, call) => (call === 1 ? truncated : ok));
  try {
    const result = await new LLMService(baseConfig).chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.content, '{"ok":true}');
    assert.deepEqual(stub.budgets, [DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS * 2]);
  } finally {
    stub.restore();
  }
});

test('加倍到 32768 上限即停止使用 AI 解析', async () => {
  const stub = stubFetch(() => truncated);
  try {
    await assert.rejects(
      new LLMService(baseConfig).chat([{ role: 'user', content: 'hi' }]),
      (error: Error) => {
        assert.match(error.message, new RegExp(String(MAX_TOKENS_CEILING)));
        assert.match(error.message, /已停止使用 AI 解析/);
        assert.match(error.message, /非推理模型/);
        return true;
      }
    );
    // 8192 → 16384 → 32768 后停止，不会无限重试
    assert.deepEqual(stub.budgets, [8192, 16384, 32768]);
  } finally {
    stub.restore();
  }
});

test('旧配置里较小的 maxTokens 不会把额度压到 8192 以下', async () => {
  const stub = stubFetch(() => ok);
  try {
    await new LLMService({ ...baseConfig, maxTokens: 2048 })
      .chat([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(stub.budgets, [DEFAULT_MAX_TOKENS]);
  } finally {
    stub.restore();
  }
});

test('额度请求不超过上限', async () => {
  const stub = stubFetch(() => ok);
  try {
    await new LLMService({ ...baseConfig, maxTokens: 999999 })
      .chat([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(stub.budgets, [MAX_TOKENS_CEILING]);
  } finally {
    stub.restore();
  }
});

test('非截断类错误不触发重试', async () => {
  const stub = stubFetch(() => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }));
  try {
    await assert.rejects(
      new LLMService(baseConfig).chat([{ role: 'user', content: 'hi' }]),
      /返回内容为空/
    );
    assert.equal(stub.budgets.length, 1, '不应重试');
  } finally {
    stub.restore();
  }
});

test('Claude 开启 thinking 时取文本 block 而非思考 block', async () => {
  const stub = stubFetch(() => ({
    content: [
      { type: 'thinking', thinking: '让我想想…' },
      { type: 'text', text: '{"ok":true}' },
    ],
    stop_reason: 'end_turn',
  }));
  try {
    const result = await new LLMService({
      ...baseConfig,
      provider: LLMProvider.CLAUDE,
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5',
    }).chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.content, '{"ok":true}');
  } finally {
    stub.restore();
  }
});

test('Claude 5 请求不发送与 adaptive thinking 冲突的 temperature', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await new LLMService({
      provider: LLMProvider.CLAUDE,
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-opus-5',
      temperature: 0.7,
    }).chat([{ role: 'user', content: 'hi' }]);

    assert.equal(Object.hasOwn(requestBody, 'temperature'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('各服务商默认模型都存在于内置候选中', () => {
  for (const provider of PROVIDER_ORDER) {
    const preset = PROVIDER_PRESETS[provider];
    if (!preset.defaultModel) continue;
    const candidates = [...preset.models, ...(preset.reasoningModels ?? [])];
    assert.ok(
      candidates.includes(preset.defaultModel),
      `${preset.label} 的默认模型 ${preset.defaultModel} 不在内置候选中`
    );
  }
});

test('仅有推理模型的服务商被标记出来', () => {
  for (const provider of PROVIDER_ORDER) {
    const preset = PROVIDER_PRESETS[provider];
    if (provider === LLMProvider.CUSTOM) continue;

    if (preset.models.length === 0) {
      assert.equal(
        preset.reasoningOnly, true,
        `${preset.label} 没有非推理模型候选，应标记 reasoningOnly 以便界面提示`
      );
    }
  }
});

test('Claude 因 max_tokens 截断时同样自动重试', async () => {
  const stub = stubFetch((_max, call) => (call === 1
    ? { content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'max_tokens' }
    : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }));
  try {
    const result = await new LLMService({
      ...baseConfig,
      provider: LLMProvider.CLAUDE,
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5',
    }).chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.content, 'done');
    assert.deepEqual(stub.budgets, [DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS * 2]);
  } finally {
    stub.restore();
  }
});

test('openai 兼容接口会把图片消息序列化为 image_url block', async () => {
  let requestBody = '';
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }],
    }), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const llm = new LLMService({
      provider: LLMProvider.OPENAI,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-terra',
    });

    await llm.chat([{
      role: 'user',
      content: [
        { type: 'text', text: '看图并返回 JSON' },
        { type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' },
      ],
    }]);

    assert.match(requestBody, /image_url/);
    assert.match(requestBody, /data:image\/png;base64,ZmFrZQ==/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Claude 接口会把图片消息序列化为 image base64 block', async () => {
  let requestBody = '';
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"ok":true}' }],
      stop_reason: 'end_turn',
    }), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const llm = new LLMService({
      provider: LLMProvider.CLAUDE,
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5',
    });

    await llm.chat([{
      role: 'user',
      content: [
        { type: 'text', text: '看图并返回 JSON' },
        { type: 'image', mimeType: 'image/jpeg', data: 'Y2xhdWRl' },
      ],
    }]);

    assert.match(requestBody, /"type":"image"/);
    assert.match(requestBody, /"media_type":"image\/jpeg"/);
    assert.match(requestBody, /"data":"Y2xhdWRl"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('即使模型未在本地白名单中，收到 image part 也会继续发请求', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const llm = new LLMService({
      provider: LLMProvider.QWEN,
      apiKey: 'sk-test',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
    });

    const result = await llm.chat([{
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' },
      ],
    }]);
    assert.equal(result.content, 'ok');
    assert.equal(fetchCalled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('服务端返回图片能力不支持时统一提示当前模型不支持图片输入', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => (
    new Response(JSON.stringify({
      error: {
        message: 'This model does not support image input or image_url content.',
      },
    }), { status: 400 })
  )) as typeof globalThis.fetch;

  try {
    const llm = new LLMService({
      provider: LLMProvider.MIMO,
      apiKey: 'sk-test',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      model: 'mimo-v2.5',
    });

    await assert.rejects(
      llm.chat([{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' },
        ],
      }]),
      /当前模型不支持图片输入/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('旧单模型配置规范化为模型列表并保留 Chat Completions 协议', () => {
  const normalized = normalizeLLMConfig({
    provider: LLMProvider.OPENAI,
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
  });

  assert.deepEqual(normalized.models, ['gpt-4.1-mini']);
  assert.equal(normalized.model, 'gpt-4.1-mini');
  assert.equal(normalized.apiMode, LLMApiMode.CHAT_COMPLETIONS);
  assert.deepEqual(normalizeLLMConfig(normalized), normalized);
});

test('模型列表会去空白和重复，并把当前模型放在首位', () => {
  assert.deepEqual(
    normalizeLLMModelList(['gpt-4.1', ' gpt-4.1-mini ', 'gpt-4.1', ''], 'gpt-4.1-mini'),
    ['gpt-4.1-mini', 'gpt-4.1'],
  );
});

test('新 OpenAI 配置默认走 Responses，其他兼容服务保持 Chat Completions', () => {
  assert.equal(defaultApiModeForProvider(LLMProvider.OPENAI), LLMApiMode.RESPONSES);
  assert.equal(defaultApiModeForProvider(LLMProvider.DEEPSEEK), LLMApiMode.CHAT_COMPLETIONS);
  assert.equal(defaultApiModeForProvider(LLMProvider.CUSTOM), LLMApiMode.CHAT_COMPLETIONS);
});

test('当前国产模型使用各家兼容参数并避免长思考耗尽正文额度', async () => {
  const cases: Array<{
    provider: LLMProvider;
    model: string;
    expected: Record<string, unknown>;
  }> = [
    {
      provider: LLMProvider.DEEPSEEK,
      model: 'deepseek-v4-flash',
      expected: { thinking: { type: 'disabled' }, max_tokens: DEFAULT_MAX_TOKENS },
    },
    {
      provider: LLMProvider.QWEN,
      model: 'qwen3.8-flash',
      expected: {
        enable_thinking: false,
        preserve_thinking: false,
        max_tokens: DEFAULT_MAX_TOKENS,
      },
    },
    {
      provider: LLMProvider.GLM,
      model: 'glm-5.3-flash',
      expected: {
        thinking: { type: 'enabled' },
        reasoning_effort: 'low',
        max_tokens: DEFAULT_MAX_TOKENS,
      },
    },
    {
      provider: LLMProvider.MINIMAX,
      model: 'MiniMax-M3',
      expected: { thinking: { type: 'disabled' }, max_completion_tokens: DEFAULT_MAX_TOKENS },
    },
    {
      provider: LLMProvider.MIMO,
      model: 'mimo-v2.5',
      expected: { thinking: { type: 'disabled' }, max_completion_tokens: DEFAULT_MAX_TOKENS },
    },
    {
      provider: LLMProvider.KIMI,
      model: 'kimi-k2.6',
      expected: { thinking: { type: 'disabled' }, max_completion_tokens: DEFAULT_MAX_TOKENS },
    },
    {
      provider: LLMProvider.KIMI,
      model: 'kimi-k3',
      expected: { reasoning_effort: 'low', max_completion_tokens: DEFAULT_MAX_TOKENS },
    },
  ];
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];

  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(ok), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    for (const item of cases) {
      await new LLMService({
        provider: item.provider,
        apiKey: 'sk-test',
        baseUrl: 'https://example.com/v1',
        model: item.model,
      }).chat([{ role: 'user', content: 'hi' }]);
    }

    cases.forEach((item, index) => {
      const body = bodies[index];
      for (const [key, value] of Object.entries(item.expected)) {
        assert.deepEqual(body[key], value, `${item.provider}/${item.model} 的 ${key} 不正确`);
      }
      if (item.provider === LLMProvider.KIMI) {
        assert.equal(Object.hasOwn(body, 'temperature'), false);
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI Responses API 使用独立端点、请求结构并解析文本和 usage', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestBody: Record<string, unknown> = {};

  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      status: 'completed',
      output: [
        { type: 'reasoning', content: [] },
        {
          type: 'message',
          content: [
            { type: 'output_text', text: '第一段' },
            { type: 'output_text', text: '第二段' },
          ],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 7 },
    }), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const result = await new LLMService({
      provider: LLMProvider.OPENAI,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1/',
      model: 'gpt-5.6-terra',
      models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
      apiMode: LLMApiMode.RESPONSES,
    }).chat([
      { role: 'system', content: '只返回 JSON' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' },
        ],
      },
    ]);

    assert.equal(requestedUrl, 'https://api.openai.com/v1/responses');
    assert.equal(requestBody.model, 'gpt-5.6-terra');
    assert.equal(requestBody.max_output_tokens, DEFAULT_MAX_TOKENS);
    assert.equal(requestBody.store, false);
    assert.equal(requestBody.instructions, '只返回 JSON');
    assert.equal(Object.hasOwn(requestBody, 'max_tokens'), false);
    assert.equal(Object.hasOwn(requestBody, 'temperature'), false);
    assert.match(JSON.stringify(requestBody.input), /"type":"input_text"/);
    assert.match(JSON.stringify(requestBody.input), /"type":"input_image"/);
    assert.match(JSON.stringify(requestBody.input), /data:image\/png;base64,ZmFrZQ==/);
    assert.equal(result.content, '第一段\n第二段');
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 7 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI Responses API 可为表单映射启用严格 JSON Schema', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: {
    reasoning?: { effort?: string };
    text?: {
      format?: {
        type?: string;
        name?: string;
        strict?: boolean;
        schema?: { required?: string[] };
      };
    };
  } = {};

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
    return new Response(JSON.stringify({
      status: 'completed',
      output_text: '{"mappings":[]}',
    }), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await new LLMService({
      provider: LLMProvider.OPENAI,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-terra',
      apiMode: LLMApiMode.RESPONSES,
    }).chat(
      [{ role: 'user', content: 'fill' }],
      undefined,
      {
        reasoningEffort: 'low',
        jsonSchema: {
          name: 'field_mappings',
          schema: {
            type: 'object',
            properties: { mappings: { type: 'array', items: { type: 'object' } } },
            required: ['mappings'],
            additionalProperties: false,
          },
        },
      },
    );

    assert.equal(requestBody.text?.format?.type, 'json_schema');
    assert.equal(requestBody.reasoning?.effort, 'low');
    assert.equal(requestBody.text?.format?.name, 'field_mappings');
    assert.equal(requestBody.text?.format?.strict, true);
    assert.deepEqual(requestBody.text?.format?.schema?.required, ['mappings']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI Responses API 截断空输出时沿用有界加倍重试', async () => {
  const originalFetch = globalThis.fetch;
  const budgets: number[] = [];

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { max_output_tokens: number };
    budgets.push(body.max_output_tokens);
    const data = budgets.length === 1
      ? { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }
      : { status: 'completed', output_text: 'ok' };
    return new Response(JSON.stringify(data), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const result = await new LLMService({
      provider: LLMProvider.OPENAI,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-terra',
      apiMode: LLMApiMode.RESPONSES,
    }).chat([{ role: 'user', content: 'hi' }]);

    assert.equal(result.content, 'ok');
    assert.deepEqual(budgets, [DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS * 2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Responses API 的历史 assistant 文本也转换为 input_text', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = '';

  globalThis.fetch = (async (_input, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({ status: 'completed', output_text: 'ok' }), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await new LLMService({
      provider: LLMProvider.OPENAI,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-terra',
      apiMode: LLMApiMode.RESPONSES,
    }).chat([
      { role: 'assistant', content: [{ type: 'text', text: '历史回答' }] },
      { role: 'user', content: '继续' },
    ]);

    assert.match(requestBody, /"type":"input_text"/);
    assert.doesNotMatch(requestBody, /"type":"output_text"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('旧 OpenAI 配置仍请求 Chat Completions 端点', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';

  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await new LLMService({
      provider: LLMProvider.OPENAI,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    }).chat([{ role: 'user', content: 'hi' }]);
    assert.equal(requestedUrl, 'https://api.openai.com/v1/chat/completions');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
