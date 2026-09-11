import assert from 'node:assert/strict';
import test from 'node:test';
import { ImapMailService, type ImapClientPort } from './imapService.js';
import type { NativeMailAccountConfig } from './types.js';

const account: NativeMailAccountConfig = {
  id: 'mail-1',
  provider: 'imap',
  emailAddress: 'candidate@example.com',
  host: 'imap.example.com',
  port: 993,
  secure: true,
  username: 'candidate@example.com',
};

function fakeClient(overrides: Partial<ImapClientPort> = {}): ImapClientPort {
  return {
    mailbox: { uidValidity: 7n, uidNext: 15, exists: 14 },
    connect: async () => undefined,
    logout: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async () => [10, 11, 12, 13, 14],
    fetchAll: async (uids) => (Array.isArray(uids) ? uids : []).map(uid => ({
      uid,
      envelope: {
        subject: `邮件 ${uid}`,
        messageId: `<${uid}@example.com>`,
        date: new Date(`2026-09-${String(uid).padStart(2, '0')}T08:00:00.000Z`),
        from: [{ name: 'HR', address: 'hr@example.com' }],
        to: [{ address: 'candidate@example.com' }],
      },
      size: 100,
    })),
    fetchOne: async uid => ({
      uid: Number(uid),
      envelope: {
        subject: '面试邀请',
        messageId: '<12@example.com>',
        date: new Date('2026-09-03T08:00:00.000Z'),
        from: [{ name: '招聘团队', address: 'hr@example.com' }],
        to: [{ address: 'candidate@example.com' }],
      },
      size: 180,
      source: Buffer.from([
        'From: 招聘团队 <hr@example.com>',
        'To: candidate@example.com',
        'Subject: =?UTF-8?B?6Z2i6K+V6YKA6K+3?=',
        'Date: Thu, 03 Sep 2026 08:00:00 +0000',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '请参加面试。',
      ].join('\r\n'), 'utf8'),
    }),
    ...overrides,
  };
}

test('按 UID cursor 增量读取且不跳过剩余邮件', async () => {
  const client = fakeClient();
  const service = new ImapMailService(() => client);
  const result = await service.listMessages(account, 'secret', {
    cursor: { uidValidity: '7', lastUid: 10 },
    limit: 2,
  });

  assert.deepEqual(result.messages.map(message => message.id), ['11', '12']);
  assert.deepEqual(result.cursor, { uidValidity: '7', lastUid: 12 });
  assert.equal(result.hasMore, true);
});

test('已删除邮件形成 UID 空洞时直接搜索 cursor 之后实际存在的邮件', async () => {
  let searchedUid = '';
  const client = fakeClient({
    mailbox: { uidValidity: 7n, exists: 4 },
    search: async query => {
      searchedUid = query.uid ?? '';
      return [18, 19];
    },
  });
  const service = new ImapMailService(() => client);
  const result = await service.listMessages(account, 'secret', {
    cursor: { uidValidity: '7', lastUid: 10 },
    limit: 4,
  });

  assert.equal(searchedUid, '11:*');
  assert.deepEqual(result.messages.map(message => message.id), ['18', '19']);
  assert.deepEqual(result.cursor, { uidValidity: '7', lastUid: 19 });
  assert.equal(result.hasMore, false);
});

test('UIDVALIDITY 变化时按时间窗口重新建立 cursor', async () => {
  let searched = false;
  const client = fakeClient({ search: async () => { searched = true; return [13, 14]; } });
  const service = new ImapMailService(() => client);
  const result = await service.listMessages(account, 'secret', {
    cursor: { uidValidity: 'old', lastUid: 99 },
    since: '2026-09-01T00:00:00.000Z',
    limit: 10,
  });

  assert.equal(searched, true);
  assert.deepEqual(result.cursor, { uidValidity: '7', lastUid: 14 });
});

test('读取正文只返回纯文本和必要字段', async () => {
  const service = new ImapMailService(() => fakeClient());
  const message = await service.getMessage(account, 'secret', '12');

  assert.equal(message.id, '12');
  assert.equal(message.provider, 'imap');
  assert.equal(message.subject, '面试邀请');
  assert.match(message.text, /请参加面试/);
  assert.equal(message.truncated, false);
  assert.equal('attachments' in message, false);
});

test('认证失败映射为不可重试错误', async () => {
  const service = new ImapMailService(() => fakeClient({
    connect: async () => { throw new Error('Authentication failed'); },
  }));

  await assert.rejects(
    service.testConnection(account, 'bad'),
    (error: { code?: string; retryable?: boolean }) => {
      assert.equal(error.code, 'AUTH_FAILED');
      assert.equal(error.retryable, false);
      return true;
    },
  );
});
