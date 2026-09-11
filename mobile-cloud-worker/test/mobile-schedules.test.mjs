import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completedScheduleItems,
  filterScheduleItems,
  scheduleDisplayLabel,
  upcomingScheduleItems,
} from '../../mobile-app/schedules.js';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function record(id, status, recruitmentSchedule) {
  return { id, companyName: `公司${id}`, jobTitle: `岗位${id}`, status, recruitmentSchedule };
}

test('手机近期安排只展示未完成、未过期且仍在流程中的事项', () => {
  const records = [
    record('A', '笔试/测评', {
      assessment: { scheduledAt: '2026-09-17T18:08:00.000Z', timeKind: 'deadline', url: 'https://example.com/a' },
      interviews: { first: { scheduledAt: '2026-09-11T09:00:00.000Z', timeKind: 'start' } },
    }),
    record('B', '面试中', {
      interviews: { ai: { scheduledAt: '2026-09-12T12:00:00.000Z', completedAt: '2026-09-10T11:00:00.000Z' } },
    }),
    record('C', '已拒绝', {
      writtenTest: { scheduledAt: '2026-09-13T12:00:00.000Z' },
    }),
    record('D', '已投递', {
      assessment: { scheduledAt: '2026-09-09T12:00:00.000Z' },
    }),
  ];

  assert.deepEqual(upcomingScheduleItems(records, NOW).map(item => item.kind), ['first', 'assessment']);
  assert.deepEqual(completedScheduleItems(records).map(item => item.kind), ['ai']);
});

test('手机近期安排明确区分开始时间和截止时间', () => {
  assert.equal(scheduleDisplayLabel('测评', { timeKind: 'deadline' }), '测评截止');
  assert.equal(scheduleDisplayLabel('一面', { timeKind: 'start' }), '一面开始');
  assert.equal(scheduleDisplayLabel('笔试', {}), '笔试');
});

test('手机近期安排分类后仍按日期由近到远排列', () => {
  const items = upcomingScheduleItems([record('A', '面试中', {
    writtenTest: { scheduledAt: '2026-09-14T12:00:00.000Z' },
    assessment: { scheduledAt: '2026-09-11T12:00:00.000Z' },
    interviews: {
      ai: { scheduledAt: '2026-09-12T12:00:00.000Z' },
      first: { scheduledAt: '2026-09-11T18:00:00.000Z' },
      hr: { scheduledAt: '2026-09-15T12:00:00.000Z' },
    },
  })], NOW);

  assert.deepEqual(filterScheduleItems(items, 'assessment').map(item => item.kind), ['assessment', 'writtenTest']);
  assert.deepEqual(filterScheduleItems(items, 'ai').map(item => item.kind), ['ai']);
  assert.deepEqual(filterScheduleItems(items, 'interview').map(item => item.kind), ['first', 'hr']);
  assert.deepEqual(filterScheduleItems(items, 'all').map(item => item.kind), ['assessment', 'first', 'ai', 'writtenTest', 'hr']);
});
