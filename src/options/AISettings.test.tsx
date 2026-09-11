import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { LLMApiMode, LLMProvider } from '../services/llm/types.ts';
import { MessageService } from '../shared/message.ts';
import { AISettings } from './AISettings.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('AI 设置提供多模型选择和自定义模型入口', () => {
  const html = renderToStaticMarkup(<AISettings />);

  assert.match(html, /当前模型/);
  assert.match(html, /deepseek-v4-flash/);
  assert.match(html, /DeepSeek V4 Flash/);
  assert.match(html, /读取账号可用模型/);
  assert.match(html, /添加并切换/);
  assert.match(html, /aria-label="已保存模型"/);
  assert.match(html, /不会同时请求多个模型/);
});

test('自定义服务首次读取模型后自动选中第一项并可直接测试连接', async () => {
  const originalChrome = globalThis.chrome;
  const originalSendMessage = MessageService.sendMessage;
  let testedModel = '';

  globalThis.chrome = {
    storage: {
      onChanged: {
        addListener() {},
        removeListener() {},
      },
    },
  } as unknown as typeof chrome;
  MessageService.sendMessage = (async (message) => {
    if (message.type === 'GET_LLM_CONFIG') {
      return {
        success: true,
        data: {
          provider: LLMProvider.CUSTOM,
          apiKey: 'test-key',
          baseUrl: 'https://proxy.example.com/v1',
          model: '',
          models: [],
          apiMode: LLMApiMode.RESPONSES,
        },
      };
    }
    if (message.type === 'LIST_LLM_MODELS') {
      return {
        success: true,
        data: {
          models: [
            { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
            { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
          ],
        },
      };
    }
    if (message.type === 'TEST_LLM_CONNECTION') {
      testedModel = message.payload?.model ?? '';
      return { success: true };
    }
    return { success: true };
  }) as typeof MessageService.sendMessage;

  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<AISettings />);
    });

    const findButton = (label: string) => renderer.root.findAllByType('button')
      .find(button => button.children.join('') === label);
    await act(async () => {
      await findButton('读取账号可用模型')?.props.onClick();
    });

    assert.ok(renderer.root.findAllByType('select').some(select => select.props.value === 'gpt-5.6-sol'));

    await act(async () => {
      await findButton('测试连接')?.props.onClick();
    });
    assert.equal(testedModel, 'gpt-5.6-sol');
  } finally {
    if (renderer) {
      await act(async () => renderer.unmount());
    }
    MessageService.sendMessage = originalSendMessage;
    globalThis.chrome = originalChrome;
  }
});
