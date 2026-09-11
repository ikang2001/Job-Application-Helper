import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import type { RecruitmentReminder } from '../domain/reminders.ts';
import { DesktopReminderService } from './desktopReminderService.ts';

function scheduledRecord(): ApplicationRecord {
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
      assessment: { scheduledAt: '2026-09-12T20:00', url: 'https://assessment.example.com' },
    },
    events: [],
    createdAt: '2026-09-09T10:00:00.000Z',
    updatedAt: '2026-09-09T10:00:00.000Z',
  };
}

test('桌面提醒状态落盘后不会重复发送同一提醒', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-helper-reminder-'));
  const statePath = join(directory, 'reminder-state.json');
  const notifications: RecruitmentReminder[] = [];
  const service = new DesktopReminderService(
    async () => [scheduledRecord()],
    statePath,
    reminder => { notifications.push(reminder); },
    () => new Date('2026-09-11T21:00').getTime(),
  );
  try {
    await service.checkNow();
    await service.checkNow();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].offsetMinutes, 1440);
    assert.match(await readFile(statePath, 'utf8'), /record-1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('错过 24 小时提醒后只补发 5 小时提醒且后续不重复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-helper-reminder-'));
  const notifications: RecruitmentReminder[] = [];
  const service = new DesktopReminderService(
    async () => [scheduledRecord()],
    join(directory, 'reminder-state.json'),
    reminder => { notifications.push(reminder); },
    () => new Date('2026-09-12T17:00').getTime(),
  );
  try {
    await service.checkNow();
    await service.checkNow();
    assert.deepEqual(notifications.map(item => item.offsetMinutes), [300]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('桌面提醒关闭时不发送，重新开启后恢复检查', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-helper-reminder-'));
  const statePath = join(directory, 'reminder-state.json');
  const notifications: RecruitmentReminder[] = [];
  let enabled = false;
  const service = new DesktopReminderService(
    async () => [scheduledRecord()],
    statePath,
    reminder => { notifications.push(reminder); },
    () => new Date('2026-09-11T21:00').getTime(),
    () => enabled,
  );
  try {
    await service.checkNow();
    assert.equal(notifications.length, 0);
    await assert.rejects(readFile(statePath, 'utf8'), { code: 'ENOENT' });
    enabled = true;
    await service.checkNow();
    assert.equal(notifications.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
