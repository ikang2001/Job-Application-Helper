import assert from 'node:assert/strict';
import test from 'node:test';
import type { MailAccount } from '../accounts.ts';
import { NativeImapProvider, type NativeMessenger } from './nativeImap.ts';
import { MailProviderError } from '../provider.ts';
import { NativePortClient } from './nativePort.ts';

const account: MailAccount = {
  id: 'imap-1',
  provider: 'imap',
  emailAddress: 'candidate@example.com',
  enabled: true,
  imap: {
    provider: 'imap',
    host: 'imap.example.com',
    port: 993,
    secure: true,
    username: 'candidate@example.com',
  },
};

test('Native IMAP provider 同步账号、凭据并映射分页 cursor', async () => {
  const requests: Record<string, unknown>[] = [];
  const send: NativeMessenger = async (request) => {
    requests.push(request);
    if (request.type === 'LIST_MESSAGES') {
      return {
        protocolVersion: 1,
        requestId: String(request.requestId),
        success: true,
        data: {
          messages: [{
            id: '12',
            from: { name: 'HR', address: 'hr@example.com' },
            to: ['candidate@example.com'],
            subject: '面试邀请',
            receivedAt: '2026-09-03T08:00:00.000Z',
          }],
          cursor: { uidValidity: '7', lastUid: 12 },
          hasMore: true,
        },
      } as never;
    }
    return {
      protocolVersion: 1,
      requestId: String(request.requestId),
      success: true,
      data: { accountId: account.id },
    } as never;
  };
  const provider = new NativeImapProvider(account, send);

  await provider.upsertNativeAccount('app-password');
  const page = await provider.listHeaders({ limit: 10 });

  assert.deepEqual(requests.map(request => request.type), [
    'UPSERT_ACCOUNT', 'SET_CREDENTIAL', 'LIST_MESSAGES',
  ]);
  assert.equal(page.items[0]?.from, 'HR <hr@example.com>');
  assert.match(page.nextCursor ?? '', /^imap:/);
});

test('Native IMAP provider 将 host 缺失映射为不可用连接结果', async () => {
  const provider = new NativeImapProvider(account, async request => ({
    protocolVersion: 1,
    requestId: String(request.requestId),
    success: false,
    error: { code: 'INTERNAL_ERROR', message: '本地邮箱组件未安装', retryable: false },
  }));

  const result = await provider.testConnection();
  assert.equal(result.connected, false);
  assert.equal(result.errorCode, 'SERVICE_UNAVAILABLE');
  assert.match(result.message ?? '', /未安装/);
});

test('新版扫描明确要求会话能力，不回退到逐封登录', async () => {
  const types: unknown[] = [];
  const provider = new NativeImapProvider(account, async request => {
    types.push(request.type);
    return { protocolVersion: 1, requestId: String(request.requestId), success: true, data: { version: '1.1.1' } } as never;
  });
  await assert.rejects(provider.beginScan(), /升级本地邮箱组件/);
  assert.deepEqual(types, ['PING']);
});

test('会话握手、正文和关闭走相同通信入口，限流保留retryAt', async () => {
  const types: unknown[] = [];
  const retryAt = '2026-10-23T08:00:00Z';
  const provider = new NativeImapProvider(account, async request => {
    types.push(request.type);
    if (request.type === 'LIST_MESSAGES') return {
      protocolVersion: 1, requestId: String(request.requestId), success: false,
      error: { code: 'RATE_LIMITED', message: '等待自动重试，无需重新授权', retryable: true, retryAt },
    };
    return { protocolVersion: 1, requestId: String(request.requestId), success: true,
      data: { capabilities: ['imap-session-v1'] } } as never;
  });
  await provider.beginScan();
  await assert.rejects(provider.listHeaders({ limit: 50 }),
    (error: MailProviderError) => error.code === 'RATE_LIMITED' && error.retryAt === retryAt);
  await provider.endScan();
  assert.deepEqual(types, ['PING', 'BEGIN_SESSION', 'LIST_MESSAGES', 'END_SESSION']);
});

test('插件端口60次请求保持一个连接并匹配响应，断线拒绝待完成请求', async () => {
  let onMessage: (value: unknown) => void = () => undefined;
  let onDisconnect: () => void = () => undefined;
  let calls = 0;
  let disconnected = 0;
  const original = globalThis.chrome;
  globalThis.chrome = { runtime: {} } as typeof chrome;
  const port = {
    onMessage: { addListener: (callback: typeof onMessage) => { onMessage = callback; } },
    onDisconnect: { addListener: (callback: typeof onDisconnect) => { onDisconnect = callback; } },
    postMessage: (request: Record<string, unknown>) => {
      if (++calls > 60) return;
      onMessage({ protocolVersion: 1, requestId: request.requestId, success: true, data: { id: calls } });
    },
    disconnect: () => { disconnected++; },
  } as unknown as chrome.runtime.Port;
  const client = new NativePortClient(port);
  try {
    for (let index = 0; index < 60; index++) {
      const result = await client.send<{ id: number }>({ requestId: String(index) });
      assert.equal(result.data?.id, index + 1);
    }
    const pending = client.send({ requestId: 'disconnect' });
    onDisconnect();
    await assert.rejects(pending, /连接已关闭/);
    assert.equal(disconnected, 1);
  } finally { client.close(); globalThis.chrome = original; }
});
