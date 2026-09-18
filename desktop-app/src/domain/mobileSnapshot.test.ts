import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import type { CareerFair } from '../shared/contracts.ts';
import { createMobileSnapshot } from './mobileSnapshot.ts';

const NOW = '2026-09-09T11:30:00.000Z';

test('手机快照只包含只读求职信息，不夹带简历、邮箱内容或密钥', () => {
  const record: ApplicationRecord = {
    id: 'record-1',
    companyName: '示例科技',
    jobTitle: 'Agent 开发工程师',
    sourceSite: 'jobs.example.com',
    sourceUrl: 'https://jobs.example.com/1',
    status: '已投递',
    notes: '一面时间待确认',
    appliedAt: '2026-09-09T10:00:00.000Z',
    location: '武汉',
    applicationEmail: 'private@example.com',
    resumeSnapshot: { fileName: 'private-resume.pdf' },
    events: [{
      id: 'event-1',
      type: 'interview_invite',
      occurredAt: NOW,
      timePrecision: 'datetime',
      source: 'email',
      title: '面试邀请',
      sourceKey: 'email:secret-message-id',
      metadata: { emailSubject: 'private mail subject' },
    }],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const fair: CareerFair = {
    id: 'fair-1',
    name: '秋季招聘会',
    status: '计划参加',
    startsAt: '2026-09-12T19:00',
    endsAt: '',
    mode: '线下',
    location: '中心校区',
    organizer: '就业中心',
    registrationDeadline: '',
    eventUrl: 'https://career.example.com/fair',
    targetCompanies: '示例科技',
    targetRoles: 'Agent 开发工程师',
    preparation: '纸质简历',
    notes: '',
    createdAt: NOW,
    updatedAt: NOW,
  };

  const snapshot = createMobileSnapshot([record], [fair], 42, NOW);
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.revision, 42);
  assert.equal(snapshot.applications[0]?.companyName, '示例科技');
  assert.equal(snapshot.careerFairs[0]?.startsAt, '2026-09-12T19:00');
  assert.doesNotMatch(serialized, /private@example\.com/);
  assert.doesNotMatch(serialized, /private-resume\.pdf/);
  assert.doesNotMatch(serialized, /private mail subject/);
  assert.doesNotMatch(serialized, /secret-message-id/);
  assert.doesNotMatch(serialized, /idCard|apiKey|password|resumeSnapshot|events/);
});
