import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalApplicationRecordsStore } from '../../../native-mail-companion/src/localRecordsStore.ts';
import type { ApplicationRecord } from '../../../src/shared/types.ts';
import { DesktopLocalSyncService } from './desktopLocalSyncService.ts';

function record(id: string, updatedAt: string): ApplicationRecord {
  return {
    id,
    companyName: '示例公司',
    jobTitle: '工程师',
    sourceSite: 'example.com',
    sourceUrl: 'https://example.com/job',
    status: '已投递',
    notes: '',
    appliedAt: '2026-09-04',
    events: [],
    location: '',
    createdAt: updatedAt,
    updatedAt,
  };
}

test('桌面服务可读取 Edge 写入并将桌面删除传播到共享文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jah-desktop-local-sync-'));
  try {
    const shared = new LocalApplicationRecordsStore(join(directory, 'records.json'));
    await shared.merge({ writer: 'edge', records: [record('one', '2026-09-04T01:00:00.000Z')] });
    const service = new DesktopLocalSyncService(shared);
    const pulled = await service.synchronize([]);
    assert.equal(pulled.length, 1);
    const afterDelete = await service.synchronize([], ['one']);
    assert.equal(afterDelete.length, 0);
    assert.equal((await shared.read()).tombstones[0]?.id, 'one');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('桌面修改状态和备注后写入 Edge 共用记录文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jah-desktop-local-sync-update-'));
  try {
    const shared = new LocalApplicationRecordsStore(join(directory, 'records.json'));
    await shared.merge({ writer: 'edge', records: [record('one', '2026-09-04T01:00:00.000Z')] });
    const service = new DesktopLocalSyncService(shared);
    const changed = {
      ...record('one', '2026-09-05T01:00:00.000Z'),
      status: '面试中' as const,
      notes: '面试链接：https://meeting.example.com/interview/123',
      recruitmentSchedule: {
        writtenTest: { scheduledAt: '2026-09-10T19:00', url: 'https://exam.example.com/written' },
        assessment: { scheduledAt: '2026-09-11T14:30', url: 'https://exam.example.com/assessment' },
        interviews: {
          ai: { scheduledAt: '2026-09-12T10:00', url: 'https://meeting.example.com/ai' },
          first: { scheduledAt: '2026-09-13T10:00', url: 'https://meeting.example.com/first' },
          hr: { scheduledAt: '2026-09-16T10:00', url: 'https://meeting.example.com/hr' },
        },
      },
    };

    const synchronized = await service.synchronize([changed]);
    const document = await shared.read();
    const sharedRecord = document.records[0] as ApplicationRecord | undefined;

    assert.equal(synchronized[0]?.status, '面试中');
    assert.equal(document.writer, 'desktop');
    assert.equal(sharedRecord?.status, '面试中');
    assert.equal(sharedRecord?.notes, changed.notes);
    assert.deepEqual(sharedRecord?.recruitmentSchedule, changed.recruitmentSchedule);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
