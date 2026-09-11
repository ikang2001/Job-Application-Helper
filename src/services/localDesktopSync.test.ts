import assert from 'node:assert/strict';
import test from 'node:test';
import { areRecordSnapshotsEqual, findDeletedRecordIds } from './localDesktopSync.ts';

const record = (id: string, updatedAt: string) => ({
  id,
  companyName: '示例公司',
  jobTitle: '工程师',
  sourceSite: 'example.com',
  sourceUrl: 'https://example.com/job',
  status: '已投递' as const,
  notes: '',
  appliedAt: '2026-09-04',
  events: [],
  location: '',
  createdAt: updatedAt,
  updatedAt,
});

test('从 storage 变化中只提取真正删除的记录 ID', () => {
  assert.deepEqual(
    findDeletedRecordIds([record('one', '2026-09-04T01:00:00.000Z'), record('two', '2026-09-04T01:00:00.000Z')], [record('two', '2026-09-04T01:00:00.000Z')]),
    ['one'],
  );
});

test('记录快照比较不受数组顺序影响', () => {
  const one = record('one', '2026-09-04T01:00:00.000Z');
  const two = record('two', '2026-09-04T02:00:00.000Z');
  assert.equal(areRecordSnapshotsEqual([one, two], [two, one]), true);
});

test('Edge 同步会识别桌面端修改的状态和备注', () => {
  const current = record('one', '2026-09-04T01:00:00.000Z');
  const desktopChanged = {
    ...current,
    status: '面试中' as const,
    notes: '面试链接：https://meeting.example.com/interview/123',
    recruitmentSchedule: {
      writtenTest: { scheduledAt: '2026-09-10T19:00', url: 'https://exam.example.com/written' },
      assessment: { scheduledAt: '2026-09-11T14:30', url: 'https://exam.example.com/assessment' },
      interviews: {
        first: { scheduledAt: '2026-09-12T10:00', url: 'https://meeting.example.com/interview/123' },
      },
    },
    updatedAt: '2026-09-05T01:00:00.000Z',
  };

  assert.equal(areRecordSnapshotsEqual([current], [desktopChanged]), false);
});
