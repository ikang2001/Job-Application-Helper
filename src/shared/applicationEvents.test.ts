import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addApplicationEvent,
  createApplicationEvent,
  createApplicationEventTombstone,
  createStatusOverrideEvent,
  deriveApplicationStatus,
  isApplicationEventSuppressed,
  normalizeApplicationEvent,
  normalizeApplicationEvents,
  removeApplicationEvent,
  removeApplicationEventTombstone,
} from './applicationEvents.ts';
import type { ApplicationEvent, ApplicationRecord } from './types.ts';

function event(
  type: ApplicationEvent['type'],
  occurredAt: string,
  sourceKey: string,
  overrides: Partial<ApplicationEvent> = {},
): ApplicationEvent {
  return createApplicationEvent({
    type,
    occurredAt,
    source: 'email',
    title: type,
    sourceKey,
    ...overrides,
  });
}

function record(events: ApplicationEvent[]): ApplicationRecord {
  return {
    id: 'r1',
    companyName: '示例公司',
    jobTitle: '后端工程师',
    sourceSite: 'jobs.example.com',
    sourceUrl: 'https://jobs.example.com/1',
    status: deriveApplicationStatus(events),
    notes: '',
    appliedAt: '2026-08-01',
    location: '上海',
    events,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

test('deriveApplicationStatus 忽略 note，并按 occurredAt/sourceKey 确定性排序', () => {
  const events = [
    event('note', '2026-08-04T00:00:00.000Z', 'email:z:note'),
    event('interview', '2026-08-03T00:00:00.000Z', 'email:z:interview'),
    event('assessment_invite', '2026-08-02T00:00:00.000Z', 'email:z:assessment'),
  ];
  assert.equal(deriveApplicationStatus(events), '面试中');

  const sameTime = [
    event('assessment_invite', '2026-08-05T00:00:00.000Z', 'email:a'),
    event('interview', '2026-08-05T00:00:00.000Z', 'email:z'),
  ];
  assert.equal(deriveApplicationStatus(sameTime), '面试中');
  assert.equal(deriveApplicationStatus([...sameTime].reverse()), '面试中');
});

test('终态不会被迟到的低优先级邮件回退，人工覆盖可显式恢复', () => {
  const rejected = event('rejection', '2026-08-03T00:00:00.000Z', 'email:rejection');
  const lateReceipt = event('application_received', '2026-08-04T00:00:00.000Z', 'email:receipt');
  assert.equal(deriveApplicationStatus([lateReceipt, rejected]), '主动放弃');

  const override = createStatusOverrideEvent(
    'r1',
    '面试中',
    '2026-08-05T00:00:00.000Z',
    'restore-1',
  );
  assert.equal(deriveApplicationStatus([rejected, lateReceipt, override]), '面试中');
});

test('等待中可由人工覆盖表达，旧已拒绝覆盖兼容迁移为主动放弃', () => {
  const waiting = createStatusOverrideEvent('r1', '等待中', '2026-08-04', 'waiting-1');
  assert.equal(deriveApplicationStatus([waiting]), '等待中');

  const legacyRejected = normalizeApplicationEvent({
    type: 'status_override',
    occurredAt: '2026-08-05',
    source: 'manual',
    title: '手动调整状态为已拒绝',
    sourceKey: 'manual:r1:legacy-rejected',
    metadata: { status: '已拒绝' },
  }, 'r1');
  assert.equal(legacyRejected.metadata?.status, '主动放弃');
  assert.equal(deriveApplicationStatus([legacyRejected]), '主动放弃');
});

test('人工覆盖删除后回到自动事件状态，且同 sourceKey 只保留一条', () => {
  const applied = event('applied', '2026-08-01', 'website:job-1:applied', {
    source: 'website',
    timePrecision: 'date',
  });
  const override = createStatusOverrideEvent('r1', 'offer', '2026-08-03', 'override-1');
  const withOverride = addApplicationEvent(record([applied]), override, '2026-08-03');
  assert.equal(withOverride.status, 'offer');
  assert.equal(addApplicationEvent(withOverride, override), withOverride);

  const cleared = removeApplicationEvent(withOverride, override.sourceKey, '2026-08-04');
  assert.equal(cleared.status, '已投递');
  assert.equal(cleared.events.length, 1);
});

test('事件规范化补确定性 id/sourceKey 并去重', () => {
  const raw = {
    type: 'interview',
    occurredAt: '2026-08-03',
    source: 'email',
    title: '一面',
  };
  const first = normalizeApplicationEvents([raw, raw], 'r1');
  const second = normalizeApplicationEvents([raw], 'r1');
  assert.equal(first.length, 1);
  assert.deepEqual(first, second);
  assert.match(first[0]!.sourceKey, /^migration:r1:event:/);
  assert.match(first[0]!.id, /^evt_/);
  assert.equal(first[0]!.timePrecision, 'date');
});

test('tombstone 支持持久抑制、过期和显式恢复', () => {
  const active = createApplicationEventTombstone(
    'r1',
    'email:gmail:a:m1:offer',
    'ignored',
    '2026-08-01T00:00:00.000Z',
  );
  const expired = createApplicationEventTombstone(
    'r1',
    'email:gmail:a:m2:offer',
    'deleted',
    '2026-08-01T00:00:00.000Z',
    '2026-08-02T00:00:00.000Z',
  );
  const now = new Date('2026-08-03T00:00:00.000Z');
  assert.equal(isApplicationEventSuppressed([active, expired], 'r1', active.sourceKey, now), true);
  assert.equal(isApplicationEventSuppressed([active, expired], 'r1', expired.sourceKey, now), false);
  assert.deepEqual(removeApplicationEventTombstone([active], 'r1', active.sourceKey), []);
});
