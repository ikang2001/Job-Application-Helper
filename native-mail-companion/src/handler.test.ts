import assert from 'node:assert/strict';
import test from 'node:test';
import { handleNativeMailRequest, parseNativeMailRequest } from './handler.js';
import { ImapMailService } from './imapService.js';
import { LocalApplicationRecordsStore } from './localRecordsStore.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AccountStore,
  CredentialStore,
  NativeMailAccountConfig,
} from './types.js';

class MemoryAccountStore implements AccountStore {
  readonly values = new Map<string, NativeMailAccountConfig>();
  async get(id: string) { return this.values.get(id) ?? null; }
  async upsert(account: NativeMailAccountConfig) { this.values.set(account.id, account); }
  async delete(id: string) { this.values.delete(id); }
}

class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();
  async get(id: string) { return this.values.get(id) ?? null; }
  async set(id: string, value: string) { this.values.set(id, value); }
  async delete(id: string) { this.values.delete(id); }
}

const account: NativeMailAccountConfig = {
  id: 'mail-1',
  provider: '163',
  emailAddress: 'user@163.com',
  host: 'imap.163.com',
  port: 993,
  secure: true,
  username: 'user@163.com',
};

function dependencies() {
  return {
    accounts: new MemoryAccountStore(),
    credentials: new MemoryCredentialStore(),
    imap: {
      testConnection: async () => undefined,
      listMessages: async () => ({ messages: [], cursor: { uidValidity: '1', lastUid: 0 }, hasMore: false }),
      getMessage: async () => ({
        id: '1', accountId: 'mail-1', provider: 'imap' as const,
        from: { address: 'hr@example.com' }, to: ['user@163.com'], subject: '面试',
        receivedAt: '2026-09-03T00:00:00.000Z', text: '正文', truncated: false,
      }),
    } as unknown as ImapMailService,
    localRecords: new LocalApplicationRecordsStore(join(tmpdir(), `jah-handler-${crypto.randomUUID()}.json`)),
  };
}

test('账号、凭据、连接和删除形成完整协议链', async () => {
  const deps = dependencies();
  const upsert = await handleNativeMailRequest({
    protocolVersion: 1, requestId: '1', type: 'UPSERT_ACCOUNT', account,
  }, deps);
  assert.equal(upsert.success, true);

  const credential = await handleNativeMailRequest({
    protocolVersion: 1, requestId: '2', type: 'SET_CREDENTIAL', accountId: account.id, credential: 'app-password',
  }, deps);
  assert.equal(credential.success, true);

  const connection = await handleNativeMailRequest({
    protocolVersion: 1, requestId: '3', type: 'TEST_CONNECTION', accountId: account.id,
  }, deps);
  assert.equal(connection.success, true);

  const deletion = await handleNativeMailRequest({
    protocolVersion: 1, requestId: '4', type: 'DELETE_ACCOUNT', accountId: account.id,
  }, deps);
  assert.equal(deletion.success, true);
  assert.equal(await deps.accounts.get(account.id), null);
  assert.equal(await deps.credentials.get(account.id), null);
});

test('账号不存在或缺少凭据时返回稳定错误', async () => {
  const deps = dependencies();
  const missingAccount = await handleNativeMailRequest({
    protocolVersion: 1, requestId: '1', type: 'TEST_CONNECTION', accountId: 'missing',
  }, deps);
  assert.equal(missingAccount.error?.code, 'ACCOUNT_NOT_FOUND');

  await deps.accounts.upsert(account);
  const missingCredential = await handleNativeMailRequest({
    protocolVersion: 1, requestId: '2', type: 'TEST_CONNECTION', accountId: account.id,
  }, deps);
  assert.equal(missingCredential.error?.code, 'CREDENTIAL_NOT_FOUND');
});

test('运行时校验拒绝非 TLS、非法邮箱和越界 limit', () => {
  assert.throws(() => parseNativeMailRequest({
    protocolVersion: 1,
    requestId: 'x',
    type: 'UPSERT_ACCOUNT',
    account: { ...account, secure: false },
  }), /必须启用 TLS/);

  assert.throws(() => parseNativeMailRequest({
    protocolVersion: 1,
    requestId: 'x',
    type: 'UPSERT_ACCOUNT',
    account: { ...account, emailAddress: 'bad' },
  }), /邮箱地址格式无效/);

  const parsed = parseNativeMailRequest({
    protocolVersion: 1,
    requestId: 'x',
    type: 'LIST_MESSAGES',
    accountId: account.id,
    limit: 999,
  });
  assert.equal(parsed.type === 'LIST_MESSAGES' ? parsed.limit : 0, 100);
});

test('协议版本不兼容时保留 requestId', async () => {
  const response = await handleNativeMailRequest({
    protocolVersion: 2, requestId: 'version-test', type: 'PING',
  }, dependencies());
  assert.equal(response.requestId, 'version-test');
  assert.equal(response.error?.code, 'UNSUPPORTED_PROTOCOL');
});

test('投递记录协议支持合并、元数据与分块读取', async () => {
  const deps = dependencies();
  const merged = await handleNativeMailRequest({
    protocolVersion: 1,
    requestId: 'merge',
    type: 'MERGE_APPLICATION_RECORDS',
    writer: 'edge',
    records: [{ id: 'record-1', updatedAt: '2026-09-04T00:00:00.000Z', companyName: '示例公司' }],
    tombstones: [],
  }, deps);
  assert.equal(merged.success, true);

  const meta = await handleNativeMailRequest({
    protocolVersion: 1, requestId: 'meta', type: 'GET_APPLICATION_RECORDS_META',
  }, deps);
  const revision = (meta.data as { revision: number }).revision;
  const chunk = await handleNativeMailRequest({
    protocolVersion: 1, requestId: 'chunk', type: 'GET_APPLICATION_RECORDS_CHUNK', revision, index: 0,
  }, deps);
  const document = JSON.parse(Buffer.from((chunk.data as { base64: string }).base64, 'base64').toString('utf8'));
  assert.equal(document.records[0].companyName, '示例公司');
});
