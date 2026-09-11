import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import {
  buildRecruitmentReminders,
  recruitmentReminderMessage,
  selectDueReminderGroups,
} from './reminders.ts';

function record(scheduledAt = '2026-09-12T20:00'): ApplicationRecord {
  return {
    id: 'record-1',
    companyName: '小米',
    jobTitle: 'AI Agent 开发工程师',
    sourceSite: '',
    sourceUrl: '',
    status: '笔试/测评',
    notes: '',
    appliedAt: '2026-09-09',
    location: '',
    recruitmentSchedule: {
      assessment: { scheduledAt, url: 'https://assessment.example.com', timeKind: 'deadline' },
      interviews: { first: { scheduledAt: '2026-09-15T10:00', url: '' } },
    },
    events: [],
    createdAt: '2026-09-09T10:00:00.000Z',
    updatedAt: '2026-09-09T10:00:00.000Z',
  };
}

test('每个已设置时间的安排生成提前 24 小时和 5 小时两条提醒', () => {
  const reminders = buildRecruitmentReminders([record()]);
  assert.equal(reminders.length, 4);
  assert.deepEqual(
    reminders.filter(item => item.label === '测评').map(item => item.offsetMinutes),
    [1440, 300],
  );
  assert.equal(new Set(reminders.map(item => item.id)).size, reminders.length);
});

test('提醒文案明确区分开始时间与截止时间', () => {
  const reminders = buildRecruitmentReminders([record()]);
  const assessment = reminders.find(item => item.label === '测评');
  const interview = reminders.find(item => item.label === '一面');
  assert.ok(assessment);
  assert.ok(interview);
  assert.match(recruitmentReminderMessage(assessment).body, /截止/);
  assert.match(recruitmentReminderMessage(interview).body, /开始/);
});

test('改期后提醒 ID 随时间变化，旧提醒不会继续命中新安排', () => {
  const previous = buildRecruitmentReminders([record('2026-09-12T20:00')]);
  const changed = buildRecruitmentReminders([record('2026-09-13T20:00')]);
  const previousAssessmentIds = previous.filter(item => item.label === '测评').map(item => item.id);
  const changedAssessmentIds = changed.filter(item => item.label === '测评').map(item => item.id);
  assert.equal(changedAssessmentIds.some(id => previousAssessmentIds.includes(id)), false);
});

test('应用错过两个提醒点后只补发更接近开始时间的一条并处理旧提醒', () => {
  const reminders = buildRecruitmentReminders([record()]).filter(item => item.label === '测评');
  const now = new Date('2026-09-12T17:00').getTime();
  const groups = selectDueReminderGroups(reminders, new Set(), now);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reminder.offsetMinutes, 300);
  assert.deepEqual(new Set(groups[0].handledIds), new Set(reminders.map(item => item.id)));
});

test('已经处理或已经开始的安排不会重复提醒', () => {
  const reminders = buildRecruitmentReminders([record()]).filter(item => item.label === '测评');
  const handled = new Set([reminders[0].id]);
  assert.equal(selectDueReminderGroups(reminders, handled, new Date('2026-09-11T21:00').getTime()).length, 0);
  assert.equal(selectDueReminderGroups(reminders, new Set(), new Date('2026-09-12T20:01').getTime()).length, 0);
});

test('截止型安排的提醒文案明确说明截止而不是开始', () => {
  const current = record();
  current.recruitmentSchedule!.assessment!.timeKind = 'deadline';
  const reminder = buildRecruitmentReminders([current]).find(item => item.label === '测评')!;
  assert.equal(reminder.timeKind, 'deadline');
  assert.match(recruitmentReminderMessage(reminder).title, /测评截止提醒/);
  assert.match(recruitmentReminderMessage(reminder).body, /截止/);
});

test('已完成的安排不再生成桌面或手机提醒任务', () => {
  const current = record();
  current.recruitmentSchedule!.assessment!.completedAt = '2026-09-10T16:00:00.000Z';
  const reminders = buildRecruitmentReminders([current]);
  assert.equal(reminders.some(item => item.label === '测评'), false);
  assert.equal(reminders.filter(item => item.label === '一面').length, 2);
});
