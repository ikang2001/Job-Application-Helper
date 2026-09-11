import assert from 'node:assert/strict';
import test from 'node:test';
import type { MailAccount } from '../accounts.ts';
import { NativeImapProvider, type NativeMessenger } from './nativeImap.ts';

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
