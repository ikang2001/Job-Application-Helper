import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import {
  clearScheduleEntry,
  completedRecruitmentSchedules,
  filterRecruitmentSchedules,
  setRecruitmentScheduleCompleted,
  upcomingRecruitmentSchedules,
} from './recruitmentSchedule.ts';

test('清空单项安排会移除该项并保留其他安排', () => {
  const schedule = {
    writtenTest: { scheduledAt: '2026-09-11T19:00', url: '', timeKind: 'deadline' as const },
    interviews: {
      first: { scheduledAt: '2026-09-12T10:00', url: 'https://meeting.example.com/first' },
    },
  };

  assert.deepEqual(clearScheduleEntry(schedule, { group: 'stage', kind: 'writtenTest', label: '笔试' }), {
    interviews: schedule.interviews,
  });
  assert.equal(clearScheduleEntry(
    { writtenTest: schedule.writtenTest },
    { group: 'stage', kind: 'writtenTest', label: '笔试' },
  ), undefined);
});

function record(overrides: Partial<ApplicationRecord>): ApplicationRecord {
  return {
    id: 'record-1',
    companyName: '示例科技',
    jobTitle: '开发工程师',
    sourceSite: '',
    sourceUrl: '',
    status: '笔试/测评',
    notes: '',
    appliedAt: '2026-09-10',
    location: '',
    events: [],
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

test('近期安排过滤已过期和终止状态并按时间排序', () => {
  const items = upcomingRecruitmentSchedules([
    record({
      recruitmentSchedule: {
        assessment: { scheduledAt: '2026-09-12T20:00', url: '', timeKind: 'deadline' },
        interviews: { first: { scheduledAt: '2026-09-11T10:00', url: '', timeKind: 'start' } },
      },
    }),
    record({ id: 'closed', status: '职位关闭', recruitmentSchedule: {
      writtenTest: { scheduledAt: '2026-09-13T10:00', url: '' },
    } }),
  ], Date.parse('2026-09-10T10:00'));

  assert.deepEqual(items.map(item => item.label), ['一面', '测评']);
  assert.deepEqual(items.map(item => item.timeKind), ['start', 'deadline']);
});

test('标记完成后从待处理中移除并可撤销', () => {
  const current = record({
    recruitmentSchedule: {
      assessment: { scheduledAt: '2026-09-12T20:00', url: '', timeKind: 'deadline' },
    },
  });
  current.recruitmentSchedule = setRecruitmentScheduleCompleted(
    current.recruitmentSchedule,
    'assessment',
    '2026-09-10T12:00:00.000Z',
  );

  assert.equal(upcomingRecruitmentSchedules([current], Date.parse('2026-09-10T10:00')).length, 0);
  assert.equal(completedRecruitmentSchedules([current])[0].label, '测评');
  current.recruitmentSchedule = setRecruitmentScheduleCompleted(current.recruitmentSchedule, 'assessment', undefined);
  assert.equal(upcomingRecruitmentSchedules([current], Date.parse('2026-09-10T10:00')).length, 1);
});

test('近期安排可按测评笔试、AI 面试和正式面试分类且不改变时间顺序', () => {
  const items = upcomingRecruitmentSchedules([record({
    recruitmentSchedule: {
      writtenTest: { scheduledAt: '2026-09-13T09:00', url: '' },
      assessment: { scheduledAt: '2026-09-11T09:00', url: '' },
      interviews: {
        ai: { scheduledAt: '2026-09-12T09:00', url: '' },
        first: { scheduledAt: '2026-09-10T18:00', url: '' },
        hr: { scheduledAt: '2026-09-14T09:00', url: '' },
      },
    },
  })], Date.parse('2026-09-10T10:00'));

  assert.deepEqual(filterRecruitmentSchedules(items, 'assessment').map(item => item.kind), ['assessment', 'writtenTest']);
  assert.deepEqual(filterRecruitmentSchedules(items, 'ai').map(item => item.kind), ['ai']);
  assert.deepEqual(filterRecruitmentSchedules(items, 'interview').map(item => item.kind), ['first', 'hr']);
  assert.deepEqual(filterRecruitmentSchedules(items, 'all').map(item => item.kind), ['first', 'assessment', 'ai', 'writtenTest', 'hr']);
});
