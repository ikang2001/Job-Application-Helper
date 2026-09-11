import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationEvent, createStatusOverrideEvent } from './applicationEvents.ts';
import {
  APPLICATION_EVENT_TOMBSTONES_STORAGE_KEY,
  ApplicationRecordRepository,
  mutateApplicationRecords,
  readApplicationEventTombstones,
  readApplicationRecords,
  suppressApplicationEventSource,
} from './applicationRecordRepository.ts';
import { STORAGE_KEYS } from './storage.ts';
import type { ApplicationEvent, ApplicationRecord } from './types.ts';

function installChromeStub(initial: Record<string, unknown> = {}, setDelayMs = 0) {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;
  const storageState: Record<string, unknown> = structuredClone(initial);
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.map(item => [item, structuredClone(storageState[item])]));
        },
        set: async (values: Record<string, unknown>) => {
          if (setDelayMs > 0) await new Promise(resolve => setTimeout(resolve, setDelayMs));
          Object.assign(storageState, structuredClone(values));
        },
      },
    },
  };
  return {
    storageState,
    restore() {
      (globalThis as { chrome?: unknown }).chrome = originalChrome;
    },
  };
}

function appliedEvent(sourceKey = 'website:https://jobs.example.com/1:applied'): ApplicationEvent {
  return createApplicationEvent({
    type: 'applied',
    occurredAt: '2026-08-01T00:00:00.000Z',
    source: 'website',
    title: '已投递',
    sourceKey,
  });
}

function record(id: string, events = [appliedEvent()]): ApplicationRecord {
  return {
    id,
    companyName: `公司-${id}`,
    jobTitle: '工程师',
    sourceSite: 'jobs.example.com',
    sourceUrl: `https://jobs.example.com/${id}`,
    status: '已投递',
    notes: '',
    appliedAt: '2026-08-01',
    location: '上海',
    events,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

test('FIFO mutation queue 不会让并发整数组更新互相覆盖', async () => {
  const stub = installChromeStub({ [STORAGE_KEYS.APPLICATION_RECORDS]: [] }, 5);
  try {
    const first = mutateApplicationRecords(async (records) => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return { records: [...records, record('r1')], result: 'first' };
    });
    const second = mutateApplicationRecords(async records => ({
      records: [...records, record('r2')],
      result: 'second',
    }));

    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    assert.deepEqual((await readApplicationRecords()).map(item => item.id), ['r1', 'r2']);
  } finally {
    stub.restore();
  }
});

test('队列中的一次失败不会阻塞后续 mutation', async () => {
  const stub = installChromeStub({ [STORAGE_KEYS.APPLICATION_RECORDS]: [] });
  try {
    await assert.rejects(
      mutateApplicationRecords(async () => {
        throw new Error('expected failure');
      }),
      /expected failure/,
    );
    await mutateApplicationRecords(records => ({
      records: [...records, record('after-failure')],
      result: undefined,
    }));
    assert.equal((await readApplicationRecords())[0]?.id, 'after-failure');
  } finally {
    stub.restore();
  }
});

test('自动事件删除写入 tombstone，repository 重建后仍不复活，显式恢复后可重加', async () => {
  const automaticEvent = appliedEvent('website:https://jobs.example.com/r1:applied');
  const stub = installChromeStub({
    [STORAGE_KEYS.APPLICATION_RECORDS]: [record('r1', [automaticEvent])],
  });
  try {
    const firstWorkerRepository = new ApplicationRecordRepository();
    const removed = await firstWorkerRepository.removeEvent(
      'r1',
      automaticEvent.sourceKey,
      'deleted',
      '2026-08-02T00:00:00.000Z',
    );
    assert.equal(removed.tombstoneCreated, true);
    assert.equal(removed.record?.events.length, 0);
    assert.equal((await readApplicationEventTombstones()).length, 1);

    const rebuiltWorkerRepository = new ApplicationRecordRepository();
    const suppressed = await rebuiltWorkerRepository.appendEvent('r1', automaticEvent);
    assert.equal(suppressed.suppressed, true);
    assert.equal(suppressed.added, false);
    assert.equal(suppressed.record?.events.length, 0);

    assert.equal(await rebuiltWorkerRepository.restoreEventSource('r1', automaticEvent.sourceKey), true);
    const restored = await rebuiltWorkerRepository.appendEvent('r1', automaticEvent);
    assert.equal(restored.added, true);
    assert.equal(restored.record?.events.length, 1);
    assert.deepEqual(stub.storageState[APPLICATION_EVENT_TOMBSTONES_STORAGE_KEY], []);
  } finally {
    stub.restore();
  }
});

test('人工事件删除不写 tombstone，也不会被已有同 key tombstone 误抑制', async () => {
  const override = createStatusOverrideEvent(
    'r1',
    'offer',
    '2026-08-02T00:00:00.000Z',
    'manual-1',
  );
  const stub = installChromeStub({
    [STORAGE_KEYS.APPLICATION_RECORDS]: [record('r1', [appliedEvent(), override])],
    [APPLICATION_EVENT_TOMBSTONES_STORAGE_KEY]: [{
      recordId: 'r1',
      sourceKey: override.sourceKey,
      reason: 'deleted',
      createdAt: '2026-08-02T00:00:00.000Z',
    }],
  });
  try {
    const repository = new ApplicationRecordRepository();
    const removed = await repository.removeEvent(
      'r1',
      override.sourceKey,
      'deleted',
      '2026-08-03T00:00:00.000Z',
    );
    assert.equal(removed.tombstoneCreated, false);
    assert.equal(removed.record?.status, '已投递');

    const readded = await repository.appendEvent('r1', override);
    assert.equal(readded.suppressed, false);
    assert.equal(readded.added, true);
    assert.equal(readded.record?.status, 'offer');
    await assert.rejects(
      suppressApplicationEventSource('r1', override.sourceKey, 'ignored', '2026-08-04'),
      /只允许抑制网站或邮件/,
    );
  } finally {
    stub.restore();
  }
});
