import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import type { DesktopMailReview } from '../shared/contracts.ts';
import {
  confirmDesktopMailReview,
  ignoreDesktopMailReviews,
  matchDesktopMailCompany,
  statusForStage,
  suggestedDesktopMailStage,
} from './desktopMail.ts';
import { saveDesktopRecord } from './records.ts';

const NOW = '2026-09-09T12:00:00.000Z';

test('拒绝邮件合并到主动放弃状态', () => {
  assert.equal(statusForStage('rejection'), '主动放弃');
});

function record(companyName: string, jobTitle: string, sourceUrl: string): ApplicationRecord {
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

function review(overrides: Partial<DesktopMailReview> = {}): DesktopMailReview {
  return {
    id: 'review-1',
    accountId: 'account-1',
    messageId: '100',
    from: 'hr@example.com',
    subject: '锐捷网络 AI面试邀约',
    receivedAt: '2026-09-09T10:00:00.000Z',
    summary: '请于指定时间前完成 AI 面试。',
    category: 'interview_invite',
    suggestedStage: 'ai',
    companyName: '锐捷网络',
    candidateRecordIds: [],
    extractedAt: '2026-09-12T19:00:00',
    actionUrl: 'https://meeting.example.com/ai',
    state: 'pending',
    ...overrides,
  };
}

test('桌面招聘邮箱只按公司匹配并返回该公司的全部投递岗位', () => {
  const records = [
    record('锐捷网络', 'AI 开发工程师', 'https://jobs.example.com/1'),
    record('锐捷网络股份有限公司', 'AI 算法工程师', 'https://jobs.example.com/2'),
    record('汇川技术', 'IT 开发工程师', 'https://jobs.example.com/3'),
  ];
  const match = matchDesktopMailCompany('锐捷网络 2027 届 AI 面试邀约', undefined, records);
  assert.equal(match.companyName, '锐捷网络');
  assert.deepEqual(new Set(match.recordIds), new Set(records.slice(0, 2).map(item => item.id)));
});

test('集团名可匹配技术公司法人名且不会在同简称公司之间猜测', () => {
  const h3c = record('新华三集团', '技术支持工程师', 'https://jobs.example.com/h3c');
  const match = matchDesktopMailCompany(
    '请参加新华三技术有限公司的在线测评',
    '新华三技术有限公司',
    [h3c],
  );
  assert.equal(match.companyName, '新华三集团');
  assert.deepEqual(match.recordIds, [h3c.id]);

  const first = record('星云技术有限公司', '开发工程师', 'https://jobs.example.com/nebula-tech');
  const second = record('星云科技有限公司', '算法工程师', 'https://jobs.example.com/nebula-science');
  assert.deepEqual(matchDesktopMailCompany('星云集团招聘通知', undefined, [first, second]), {
    recordIds: [],
  });
});

test('邮件简称可匹配带地域前缀和法律后缀的公司名称', () => {
  const transsion = record(
    '深圳传音控股股份有限公司',
    'AI Agent 工程开发工程师',
    'https://career.transsion.com/job/1',
  );
  const match = matchDesktopMailCompany(
    '在线测评邀请——传音控股2027届校园招聘',
    '传音控股',
    [transsion],
  );

  assert.equal(match.companyName, '深圳传音控股股份有限公司');
  assert.deepEqual(match.recordIds, [transsion.id]);
});

test('邮件中的品牌简称可匹配公司名括号内含地域的投递记录', () => {
  const kingdee = record(
    '金蝶软件（中国）有限公司',
    'AI agent开发工程师（深圳）',
    'https://app.mokahr.com/job/kingdee',
  );
  const match = matchDesktopMailCompany(
    '来自金蝶2027届校园招聘的笔试邀请',
    undefined,
    [kingdee],
  );

  assert.equal(match.companyName, '金蝶软件（中国）有限公司');
  assert.deepEqual(match.recordIds, [kingdee.id]);
});

test('纯测评通知和 AI 面试邀约可给出建议，但仍需人工选择', () => {
  assert.equal(suggestedDesktopMailStage('assessment_invite', '汇川技术校园招聘测评通知'), 'assessment');
  assert.equal(suggestedDesktopMailStage('assessment_invite', '编程笔试通知'), 'writtenTest');
  assert.equal(suggestedDesktopMailStage('interview_invite', '锐捷网络 AI面试邀约'), 'ai');
  assert.equal(suggestedDesktopMailStage('interview_invite', '第三轮面试安排'), 'third');
  assert.equal(suggestedDesktopMailStage(
    'assessment_invite',
    '邮件正文同时介绍后续编程笔试流程',
    '请参加新华三技术有限公司的在线测评',
  ), 'assessment');
});

test('人工确认 AI 面后才修改所选公司岗位状态和 AI 面安排', () => {
  const target = record('锐捷网络', 'AI 算法工程师', 'https://jobs.example.com/1');
  const other = record('锐捷网络', 'AI 开发工程师', 'https://jobs.example.com/2');
  const pending = review({ candidateRecordIds: [target.id, other.id] });
  const result = confirmDesktopMailReview([target, other], [pending], {
    reviewId: pending.id,
    recordId: target.id,
    stage: 'ai',
  }, '2026-09-09T12:30:00.000Z');

  const updated = result.records.find(item => item.id === target.id);
  assert.equal(updated?.status, '面试中');
  assert.deepEqual(updated?.recruitmentSchedule?.interviews?.ai, {
    scheduledAt: '2026-09-12T19:00',
    url: 'https://meeting.example.com/ai',
    timeKind: 'deadline',
  });
  assert.match(updated?.notes ?? '', /AI 面截止/);
  assert.equal(result.records.find(item => item.id === other.id)?.status, '已投递');
  assert.equal(updated?.events.some(event => event.source === 'email'), true);
  assert.equal(result.reviews[0]?.state, 'confirmed');
});

test('人工确认时把只有日期的截止时间转换为桌面安排时间', () => {
  const target = record('汇川技术', 'IT 开发工程师', 'https://jobs.example.com/3');
  const pending = review({
    companyName: '汇川技术',
    candidateRecordIds: [target.id],
    category: 'assessment_invite',
    suggestedStage: 'assessment',
    extractedAt: undefined,
    deadlineAt: '2026-09-15',
    actionUrl: 'https://assessment.example.com/start',
  });
  const result = confirmDesktopMailReview([target], [pending], {
    reviewId: pending.id,
    recordId: target.id,
    stage: 'assessment',
  });

  assert.deepEqual(result.records[0]?.recruitmentSchedule?.assessment, {
    scheduledAt: '2026-09-15T23:59',
    url: 'https://assessment.example.com/start',
    timeKind: 'deadline',
  });
  assert.match(result.records[0]?.notes ?? '', /测评截止/);
});

test('人工审核可修正时间含义、链接并追加截止提示和补充说明', () => {
  const target = record('新华三集团', 'AI 大模型算法工程师', 'https://jobs.example.com/h3c');
  const pending = review({
    companyName: '新华三集团',
    candidateRecordIds: [target.id],
    category: 'assessment_invite',
    suggestedStage: 'assessment',
    deadlineAt: '2026-09-24T13:47:00',
  });
  const result = confirmDesktopMailReview([target], [pending], {
    reviewId: pending.id,
    recordId: target.id,
    stage: 'assessment',
    scheduledAt: '2026-09-24T13:47',
    scheduleType: 'deadline',
    actionUrl: 'https://assessment.example.com/h3c',
    notes: '完成前先检查摄像头。',
  });

  assert.deepEqual(result.records[0]?.recruitmentSchedule?.assessment, {
    scheduledAt: '2026-09-24T13:47',
    url: 'https://assessment.example.com/h3c',
    timeKind: 'deadline',
  });
  assert.match(result.records[0]?.notes ?? '', /测评截止/);
  assert.match(result.records[0]?.notes ?? '', /完成前先检查摄像头/);
});

test('人工选择其他公司岗位时拒绝更新', () => {
  const reviewItem = review();
  const wrong = record('汇川技术', 'IT 开发工程师', 'https://jobs.example.com/3');
  assert.throws(() => confirmDesktopMailReview([wrong], [reviewItem], {
    reviewId: reviewItem.id,
    recordId: wrong.id,
    stage: 'assessment',
  }), /不属于邮件匹配的公司/);
});

test('批量忽略只处理所选待审核邮件且不接受已处理项', () => {
  const first = review({ id: 'review-1' });
  const second = review({ id: 'review-2', messageId: '101' });
  const third = review({ id: 'review-3', messageId: '102' });
  const ignored = ignoreDesktopMailReviews(
    [first, second, third],
    [first.id, third.id],
    '2026-09-09T13:00:00.000Z',
  );

  assert.equal(ignored[0]?.state, 'ignored');
  assert.equal(ignored[1]?.state, 'pending');
  assert.equal(ignored[2]?.state, 'ignored');
  assert.equal(ignored[0]?.reviewedAt, '2026-09-09T13:00:00.000Z');
  assert.throws(
    () => ignoreDesktopMailReviews(ignored, [first.id]),
    /不存在或已经处理/,
  );
});
