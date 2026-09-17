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

test('桌面端按邮件接收时间识别带空格的三天内测评截止时间', async () => {
  const client = new FakeNativeMailClient();
  client.listMessages = async () => ({
    messages: [{
      id: 'tcl-assessment-1',
      from: { name: 'TCL招聘', address: 'tclzhaopin@example.com' },
      to: ['candidate@163.com'],
      subject: '人才测评通知',
      receivedAt: '2026-09-15T06:15:34.000Z',
    }],
    cursor: { uidValidity: '1', lastUid: 203 },
    hasMore: false,
  });
  client.getMessage = async () => ({
    id: 'tcl-assessment-1',
    accountId: 'account-1',
    from: { name: 'TCL招聘', address: 'tclzhaopin@example.com' },
    to: ['candidate@163.com'],
    subject: '人才测评通知',
    receivedAt: '2026-09-15T06:15:34.000Z',
    text: '感谢您申请TCL校招岗位，现邀请您参加在线测评，请在收到通知的 3 天 内 完成测评。',
    truncated: false,
  });

  const next = await new DesktopMailInboxService(client).scan({
    schemaVersion: 1,
    records: [record('AI应用开发工程师', 'https://jobs.tcl.com/1', 'TCL')],
    favoriteRecordIds: [],
    careerFairs: [],
    sync: { status: 'idle' },
  });

  assert.equal(next.mailInbox?.reviews[0]?.suggestedStage, 'assessment');
  assert.equal(next.mailInbox?.reviews[0]?.deadlineAt, '2026-09-18T06:15:34.000Z');
});

test('邮件主题中的金蝶优先于正文奖学金证书造成的金证误匹配', async () => {
  const kingdee = record(
    'AI agent开发工程师（深圳）',
    'https://app.mokahr.com/campus-recruitment/kingdeehr/job/1',
    '金蝶软件（中国）有限公司',
  );
  const kingsoft = record(
    '大模型应用开发工程师',
    'https://jobs.example.com/kingsoft',
    '金证科技',
  );
  const client = new FakeNativeMailClient();
  client.listMessages = async () => ({
    messages: [{
      id: 'kingdee-interview-1',
      from: { name: '招聘小秘书', address: 'kingdeehr-no-reply@mail.mokahr.com' },
      to: ['candidate@163.com'],
      subject: '金蝶2027届校园招聘业务初面邀请（邮件重要请仔细阅读）',
      receivedAt: '2026-09-15T12:16:34.000Z',
    }],
    cursor: { uidValidity: '1', lastUid: 204 },
    hasMore: false,
  });
  client.getMessage = async () => ({
    id: 'kingdee-interview-1',
    accountId: 'account-1',
    from: { name: '招聘小秘书', address: 'kingdeehr-no-reply@mail.mokahr.com' },
    to: ['candidate@163.com'],
    subject: '金蝶2027届校园招聘业务初面邀请（邮件重要请仔细阅读）',
    receivedAt: '2026-09-15T12:16:34.000Z',
    text: '恭喜你通过线上笔试，请参加金蝶业务初面。可补充奖学金证书等面试材料。面试时间：2026年9月16日 14:00。',
    truncated: false,
  });

  const next = await new DesktopMailInboxService(client).scan({
    schemaVersion: 1,
    records: [kingdee, kingsoft],
    favoriteRecordIds: [],
    careerFairs: [],
    sync: { status: 'idle' },
  });

  assert.equal(next.mailInbox?.reviews[0]?.companyName, '金蝶软件（中国）有限公司');
  assert.deepEqual(next.mailInbox?.reviews[0]?.candidateRecordIds, [kingdee.id]);
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

test('已有待审核邮件根据链接有效期补齐截止时间且不重新读取旧邮件', async () => {
  const client = new FakeNativeMailClient();
  client.listMessages = async (_accountId, options) => ({
    messages: [],
    cursor: options.cursor ?? { uidValidity: '1', lastUid: 0 },
    hasMore: false,
  });
  const next = await new DesktopMailInboxService(client).scan({
    schemaVersion: 1,
    records: [record('AI应用工程师-深圳', 'https://talent.anker-in.com/job', '安克创新')],
    favoriteRecordIds: [],
    careerFairs: [],
    sync: { status: 'idle' },
    mailInbox: {
      status: 'idle',
      accounts: [],
      cursors: { 'account-1': { uidValidity: '1', lastUid: 401 } },
      reviews: [{
        id: 'mail-401',
        accountId: 'account-1',
        messageId: '401',
        from: '安克创新招聘',
        subject: '【安克创新校招测评】2027届校园招聘',
        receivedAt: '2026-09-11T06:00:00.000Z',
        summary: '请用简历中的姓名、邮箱完成认证;链接有效期5天,请合理安排时间。',
        category: 'assessment_invite',
        suggestedStage: 'assessment',
        companyName: '安克创新',
        candidateRecordIds: [],
        state: 'pending',
      }],
    },
  });

  assert.equal(client.getMessageCalls, 0);
  assert.equal(next.mailInbox?.reviews[0]?.deadlineAt, '2026-09-16T06:00:00.000Z');
  assert.deepEqual(next.mailInbox?.cursors['account-1'], { uidValidity: '1', lastUid: 401 });
});

test('已有未匹配的金蝶邮件根据品牌简称补齐对应岗位且不重新读取旧邮件', async () => {
  const client = new FakeNativeMailClient();
  client.listMessages = async (_accountId, options) => ({
    messages: [],
    cursor: options.cursor ?? { uidValidity: '1', lastUid: 0 },
    hasMore: false,
  });
  const kingdee = record(
    'AI agent开发工程师（深圳）',
    'https://app.mokahr.com/job/kingdee',
    '金蝶软件（中国）有限公司',
  );
  const next = await new DesktopMailInboxService(client).scan({
    schemaVersion: 1,
    records: [kingdee],
    favoriteRecordIds: [],
    careerFairs: [],
    sync: { status: 'idle' },
    mailInbox: {
      status: 'idle',
      accounts: [],
      cursors: { 'account-1': { uidValidity: '1', lastUid: 501 } },
      reviews: [{
        id: 'mail-501',
        accountId: 'account-1',
        messageId: '501',
        from: '招聘小秘书 <kingdeehr-no-reply@mail.mokahr.com>',
        subject: '来自金蝶2027届校园招聘的笔试邀请',
        receivedAt: '2026-09-11T07:24:21.000Z',
        summary: '恭喜你通过简历筛选，进入金蝶2027届校招线上笔试环节。',
        category: 'assessment_invite',
        suggestedStage: 'writtenTest',
        candidateRecordIds: [],
        state: 'pending',
      }],
    },
  });

  assert.equal(client.getMessageCalls, 0);
  assert.equal(next.mailInbox?.reviews[0]?.companyName, '金蝶软件（中国）有限公司');
  assert.deepEqual(next.mailInbox?.reviews[0]?.candidateRecordIds, [kingdee.id]);
  assert.deepEqual(next.mailInbox?.cursors['account-1'], { uidValidity: '1', lastUid: 501 });
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
