import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import { saveDesktopRecord } from '../domain/records.ts';
import type { DesktopData } from './desktopStore.ts';
import { DesktopMailInboxService } from './desktopMailInboxService.ts';
import type {
  DesktopNativeMailMessage,
  DesktopNativeMailPage,
  DesktopNativeMailPort,
} from './desktopNativeMailClient.ts';

const NOW = '2026-09-09T12:00:00.000Z';

function record(jobTitle: string, sourceUrl: string, companyName = '锐捷网络'): ApplicationRecord {
  return saveDesktopRecord([], {
    companyName,
    jobTitle,
    sourceSite: new URL(sourceUrl).hostname,
    sourceUrl,
    status: '已投递',
    notes: '',
    appliedAt: '2026-09-01',
    location: '武汉',
  }, NOW).record;
}

class FakeNativeMailClient implements DesktopNativeMailPort {
  tested = 0;
  getMessageCalls = 0;
  lastListOptions?: Parameters<DesktopNativeMailPort['listMessages']>[1];

  async listAccounts() {
    return [{ id: 'account-1', provider: '163', emailAddress: 'candidate@163.com' }];
  }

  async ping() { return { host: 'test', version: '1.1.0' }; }

  async testConnection() { this.tested += 1; }

  async listMessages(
    _accountId: string,
    options: Parameters<DesktopNativeMailPort['listMessages']>[1],
  ): Promise<DesktopNativeMailPage> {
    this.lastListOptions = options;
    return {
      messages: [{
        id: '101',
        from: { name: '锐捷招聘', address: 'recruit@example.com' },
        to: ['candidate@163.com'],
        subject: '锐捷网络 AI面试邀约',
        receivedAt: '2026-09-09T10:00:00.000Z',
      }],
      cursor: { uidValidity: '1', lastUid: 101 },
      hasMore: false,
    };
  }

  async getMessage(_accountId: string, _messageId: string): Promise<DesktopNativeMailMessage> {
    this.getMessageCalls += 1;
    return {
      id: '101',
      accountId: 'account-1',
      from: { name: '锐捷招聘', address: 'recruit@example.com' },
      to: ['candidate@163.com'],
      subject: '锐捷网络 AI面试邀约',
      receivedAt: '2026-09-09T10:00:00.000Z',
      text: '请在 2026年9月12日 19:00 完成 AI面试：https://meeting.example.com/ai',
      truncated: false,
    };
  }
}

test('桌面招聘邮箱扫描只创建待审核项并按公司列出全部岗位', async () => {
  const first = record('AI 开发工程师', 'https://jobs.example.com/1');
  const second = record('AI 算法工程师', 'https://jobs.example.com/2');
  const data: DesktopData = {
    schemaVersion: 1,
    records: [first, second],
    favoriteRecordIds: [],
    careerFairs: [],
    sync: { status: 'idle' },
  };
  const client = new FakeNativeMailClient();
  const next = await new DesktopMailInboxService(client).scan(data);
  const pending = next.mailInbox?.reviews[0];

  assert.equal(client.tested, 1);
  assert.equal(client.getMessageCalls, 1);
  assert.equal(pending?.state, 'pending');
  assert.equal(pending?.companyName, '锐捷网络');
  assert.deepEqual(new Set(pending?.candidateRecordIds), new Set([first.id, second.id]));
  assert.equal(pending?.suggestedStage, 'ai');
  assert.equal(next.records[0]?.status, '已投递');
  assert.equal(next.records[1]?.status, '已投递');
  assert.deepEqual(next.mailInbox?.cursors['account-1'], { uidValidity: '1', lastUid: 101 });
});

test('包含测评笔试或面试安排的邮件进入待审核，普通投递确认仍被过滤', async () => {
  const target = record('技术支持工程师', 'https://jobs.example.com/h3c', '新华三集团');
  const messages: DesktopNativeMailMessage[] = [
    {
      id: '201',
      accountId: 'account-1',
      from: { name: '新华三技术有限公司', address: 'recruit@example.com' },
      to: ['candidate@163.com'],
      subject: '感谢您投递本公司职位',
      receivedAt: '2026-09-10T05:47:07.000Z',
      text: '新华三技术有限公司已收到你的简历，通过筛选后会安排面试。',
      truncated: false,
    },
    {
      id: '202',
      accountId: 'account-1',
      from: { name: 'iTalent招聘助手', address: 'recruit@example.com' },
      to: ['candidate@163.com'],
      subject: '请参加新华三技术有限公司的在线测评',
      receivedAt: '2026-09-10T05:47:08.000Z',
      text: '请按邮件说明完成在线测评。',
      truncated: false,
    },
  ];
  const client = new FakeNativeMailClient();
  client.listMessages = async () => ({
    messages: messages.map(({ accountId: _accountId, text: _text, truncated: _truncated, ...header }) => header),
    cursor: { uidValidity: '1', lastUid: 202 },
    hasMore: false,
  });
  client.getMessage = async (_accountId, messageId) => {
    const message = messages.find(item => item.id === messageId);
    return message ?? assert.fail(`未找到邮件：${messageId}`);
  };
  const next = await new DesktopMailInboxService(client).scan({
    schemaVersion: 1,
    records: [target],
    favoriteRecordIds: [],
    careerFairs: [],
    sync: { status: 'idle' },
  });

  assert.deepEqual(next.mailInbox?.reviews.map(review => review.subject), [
    '请参加新华三技术有限公司的在线测评',
  ]);
  assert.equal(next.mailInbox?.reviews[0]?.companyName, '新华三集团');
  assert.equal(next.mailInbox?.reviews[0]?.suggestedStage, 'assessment');
});

test('无法匹配公司的测评邮件仍进入人工审核', async () => {
  const client = new FakeNativeMailClient();
  client.listMessages = async () => ({
    messages: [{
      id: '301',
      from: { name: '招聘平台', address: 'notice@example.com' },
      to: ['candidate@163.com'],
      subject: '在线测评邀请——尚未登记公司2027届校园招聘',
      receivedAt: '2026-09-10T10:09:02.000Z',
    }],
    cursor: { uidValidity: '1', lastUid: 301 },
    hasMore: false,
  });
  client.getMessage = async () => ({
    id: '301',
    accountId: 'account-1',
    from: { name: '招聘平台', address: 'notice@example.com' },
    to: ['candidate@163.com'],
    subject: '在线测评邀请——尚未登记公司2027届校园招聘',
    receivedAt: '2026-09-10T10:09:02.000Z',
    text: '请在规定时间内完成在线测评。',
    truncated: false,
  });

  const next = await new DesktopMailInboxService(client).scan({
    schemaVersion: 1,
    records: [record('开发工程师', 'https://jobs.example.com/other', '其他公司')],
    favoriteRecordIds: [],
    careerFairs: [],
    sync: { status: 'idle' },
  });

  assert.equal(next.mailInbox?.reviews[0]?.state, 'pending');
  assert.equal(next.mailInbox?.reviews[0]?.companyName, undefined);
  assert.deepEqual(next.mailInbox?.reviews[0]?.candidateRecordIds, []);
});

test('已有扫描游标会原样传给邮箱组件且不会读取旧邮件正文', async () => {
  const client = new FakeNativeMailClient();
  client.listMessages = async (_accountId, options) => {
    client.lastListOptions = options;
    return {
      messages: [],
      cursor: options.cursor ?? { uidValidity: '1', lastUid: 0 },
      hasMore: false,
    };
  };
  const next = await new DesktopMailInboxService(client).scan({
    schemaVersion: 1,
    records: [record('AI 开发工程师', 'https://jobs.example.com/1')],
    favoriteRecordIds: [],
    careerFairs: [],
    sync: { status: 'idle' },
    mailInbox: {
      status: 'idle',
      accounts: [],
      reviews: [],
      cursors: { 'account-1': { uidValidity: '1', lastUid: 300 } },
    },
  });

  assert.deepEqual(client.lastListOptions?.cursor, { uidValidity: '1', lastUid: 300 });
  assert.equal(client.getMessageCalls, 0);
  assert.deepEqual(next.mailInbox?.cursors['account-1'], { uidValidity: '1', lastUid: 300 });
});
