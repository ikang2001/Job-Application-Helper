import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationPageMetadata, PendingSubmission } from '../shared/types.ts';
import {
  PENDING_SUBMISSIONS_STORAGE_KEY,
  SUBMISSION_CONTEXTS_STORAGE_KEY,
  handleCacheApplicationPageMetadata,
  handleGetPendingSubmissions,
  handleIgnorePendingSubmissions,
  handlePendingSubmissionDecision,
  handleSubmissionAttemptStarted,
  handleUpsertPendingSubmission,
  type SubmissionTrackingDependencies,
} from './submissionTracking.ts';

function installChromeStorage() {
  const values: Record<string, unknown> = { applicationRecords: [] };
  const original = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const selected = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(selected.map(key => [key, values[key]]));
        },
        set: async (entries: Record<string, unknown>) => { Object.assign(values, structuredClone(entries)); },
      },
    },
  } as unknown as typeof chrome;
  return { values, restore: () => { globalThis.chrome = original; } };
}

function createDependencies(storage: Record<string, unknown>): SubmissionTrackingDependencies {
  const metadata: ApplicationPageMetadata = {
    companyName: '示例公司',
    jobTitle: '后端工程师',
    jobId: 'REQ-123',
    sourceSite: 'jobs.example.com',
    sourceUrl: 'https://jobs.example.com/positions/123',
    location: '上海',
    jdSnapshot: {
      text: '岗位职责', capturedAt: '2026-09-03T08:00:00.000Z',
      sourceUrl: 'https://jobs.example.com/positions/123', contentHash: 'hash', truncated: false,
    },
  };
  return {
    getMetadata: async () => metadata,
    getActiveResume: async () => ({
      id: 'resume-1', name: '后端简历', updatedAt: '2026-09-01T00:00:00.000Z', fileName: 'resume.pdf',
    }),
    read: async key => storage[key],
    write: async values => { Object.assign(storage, structuredClone(values)); },
    getCachedMetadata: async (tabId, sourceUrl) => {
      const values = Object.entries(storage)
        .filter(([key]) => key.startsWith('metadata-cache:'))
        .map(([, value]) => value as ApplicationPageMetadata);
      return values.find(value => value.sourceUrl === sourceUrl)
        ?? storage[`metadata-cache:${tabId}`] as ApplicationPageMetadata | undefined;
    },
    setCachedMetadata: async (tabId, value) => {
      storage[`metadata-cache:${tabId}`] = structuredClone(value);
    },
    now: () => new Date('2026-09-03T08:00:00.000Z'),
    createId: () => 'context-1',
  };
}

test('提交开始时持久化岗位、简历 revision 和实际邮箱快照', async () => {
  const storage: Record<string, unknown> = {};
  const result = await handleSubmissionAttemptStarted({
    sourceUrl: 'https://jobs.example.com/positions/123',
    startedAt: '2026-09-03T08:00:00.000Z',
    applicationEmail: 'used@example.com',
    triggerLabel: '提交申请',
  }, { tab: { id: 7 } } as chrome.runtime.MessageSender, createDependencies(storage));

  assert.equal(result.success, true);
  assert.equal(result.data?.resumeProfileName, '后端简历');
  assert.equal(result.data?.resumeFileName, 'resume.pdf');
  assert.equal(result.data?.applicationEmail, 'used@example.com');
  assert.equal((storage[SUBMISSION_CONTEXTS_STORAGE_KEY] as unknown[]).length, 1);
});

test('提交页丢失岗位后沿用缓存的岗位快照和岗位详情链接', async () => {
  const chromeStorage = installChromeStorage();
  const storage: Record<string, unknown> = {};
  const deps = createDependencies(storage);
  const sender = { tab: { id: 7 } } as chrome.runtime.MessageSender;
  try {
    await handleCacheApplicationPageMetadata({
      companyName: '小黑盒',
      jobTitle: 'Agent开发工程师',
      jobId: 'JOB-42',
      sourceSite: 'jobs.example.com',
      sourceUrl: 'https://jobs.example.com/jobs/JOB-42',
      location: '北京',
    }, sender, deps);
    deps.getMetadata = async () => ({
      companyName: '小黑盒',
      jobTitle: '投递岗位',
      sourceSite: 'jobs.example.com',
      sourceUrl: 'https://jobs.example.com/application/success',
    });

    const result = await handleSubmissionAttemptStarted({
      sourceUrl: 'https://jobs.example.com/application/submit',
      startedAt: '2026-09-03T08:00:00.000Z',
      triggerLabel: '提交申请',
      metadata: {
        companyName: '小黑盒',
        jobTitle: '投递岗位',
        sourceSite: 'jobs.example.com',
        sourceUrl: 'https://jobs.example.com/application/submit',
      },
    }, sender, deps);

    assert.equal(result.data?.metadata.jobTitle, 'Agent开发工程师');
    assert.equal(result.data?.metadata.jobId, 'JOB-42');
    assert.equal(result.data?.metadata.location, '北京');
    assert.equal(result.data?.metadata.sourceUrl, 'https://jobs.example.com/jobs/JOB-42');

    const context = result.data!;
    await handleUpsertPendingSubmission({
      context,
      pending: {
        id: 'pending-cached-link',
        contextId: context.id,
        score: 0.9,
        signals: ['buttonClick', 'successText'],
        createdAt: context.startedAt,
        expiresAt: context.expiresAt,
        state: 'confirmed',
      },
    }, sender, deps);
    const records = chromeStorage.values.applicationRecords as Array<{ sourceUrl: string }>;
    assert.equal(records[0]?.sourceUrl, 'https://jobs.example.com/jobs/JOB-42');
  } finally {
    chromeStorage.restore();
  }
});

test('通用投递表单页不会覆盖同标签已缓存的岗位详情链接', async () => {
  const storage: Record<string, unknown> = {};
  const deps = createDependencies(storage);
  const sender = { tab: { id: 7 } } as chrome.runtime.MessageSender;
  await handleCacheApplicationPageMetadata({
    companyName: '示例公司',
    jobTitle: '后端工程师',
    sourceSite: 'jobs.example.com',
    sourceUrl: 'https://jobs.example.com/jobs/backend-engineer',
  }, sender, deps);
  await handleCacheApplicationPageMetadata({
    companyName: '示例公司',
    jobTitle: '投递岗位',
    sourceSite: 'jobs.example.com',
    sourceUrl: 'https://jobs.example.com/application/submit',
  }, sender, deps);

  const cached = await deps.getCachedMetadata(7);
  assert.equal(cached?.jobTitle, '后端工程师');
  assert.equal(cached?.sourceUrl, 'https://jobs.example.com/jobs/backend-engineer');
});

test('同一岗位的投递表单快照不会清空详情页的地点和 JD', async () => {
  const storage: Record<string, unknown> = {};
  const deps = createDependencies(storage);
  const sender = { tab: { id: 7 } } as chrome.runtime.MessageSender;
  const detailUrl = 'https://jobs.example.com/jobs/backend-engineer';
  await handleCacheApplicationPageMetadata({
    companyName: '示例公司',
    jobTitle: '后端工程师',
    jobId: 'BACKEND-1',
    sourceSite: 'jobs.example.com',
    sourceUrl: detailUrl,
    location: '上海',
    jdSnapshot: {
      text: '岗位职责', capturedAt: '2026-09-03T08:00:00.000Z',
      sourceUrl: detailUrl, contentHash: 'hash', truncated: false,
    },
  }, sender, deps);
  await handleCacheApplicationPageMetadata({
    companyName: '示例公司',
    jobTitle: '后端工程师',
    jobId: 'BACKEND-1',
    sourceSite: 'jobs.example.com',
    sourceUrl: detailUrl,
  }, sender, deps);

  const cached = await deps.getCachedMetadata(7, detailUrl);
  assert.equal(cached?.location, '上海');
  assert.equal(cached?.jdSnapshot?.text, '岗位职责');
});

test('新标签投递页按 referrer 岗位链接复用原标签的岗位快照', async () => {
  const storage: Record<string, unknown> = {};
  const deps = createDependencies(storage);
  const detailUrl = 'https://jobs.example.com/jobs/agent-engineer';
  await handleCacheApplicationPageMetadata({
    companyName: '示例公司',
    jobTitle: 'Agent开发工程师',
    sourceSite: 'jobs.example.com',
    sourceUrl: detailUrl,
    location: '北京',
  }, { tab: { id: 6 } } as chrome.runtime.MessageSender, deps);
  deps.getMetadata = async () => ({
    companyName: '示例公司',
    sourceSite: 'jobs.example.com',
    sourceUrl: detailUrl,
  });

  const result = await handleSubmissionAttemptStarted({
    sourceUrl: 'https://jobs.example.com/form?fromPage=job',
    startedAt: '2026-09-03T08:00:00.000Z',
    triggerLabel: '提交申请',
    metadata: {
      companyName: '示例公司',
      sourceSite: 'jobs.example.com',
      sourceUrl: detailUrl,
    },
  }, { tab: { id: 7 } } as chrome.runtime.MessageSender, deps);

  assert.equal(result.data?.metadata.jobTitle, 'Agent开发工程师');
  assert.equal(result.data?.metadata.location, '北京');
  assert.equal(result.data?.metadata.sourceUrl, detailUrl);
});

test('当前点击快照属于新岗位时不会套用上一岗位缓存', async () => {
  const storage: Record<string, unknown> = {};
  const deps = createDependencies(storage);
  await deps.setCachedMetadata(7, {
    companyName: '示例公司',
    jobTitle: '旧岗位',
    jobId: 'OLD-1',
    sourceSite: 'jobs.example.com',
    sourceUrl: 'https://jobs.example.com/jobs/OLD-1',
    location: '旧地点',
  });
  deps.getMetadata = async () => ({
    companyName: '示例公司',
    jobTitle: '新岗位',
    jobId: 'NEW-2',
    sourceSite: 'jobs.example.com',
    sourceUrl: 'https://jobs.example.com/application/submit?jobId=NEW-2',
  });

  const result = await handleSubmissionAttemptStarted({
    sourceUrl: 'https://jobs.example.com/application/submit?jobId=NEW-2',
    startedAt: '2026-09-03T08:00:00.000Z',
    triggerLabel: '提交申请',
    metadata: {
      companyName: '示例公司',
      jobTitle: '新岗位',
      jobId: 'NEW-2',
      sourceSite: 'jobs.example.com',
      sourceUrl: 'https://jobs.example.com/application/submit?jobId=NEW-2',
    },
  }, { tab: { id: 7 } } as chrome.runtime.MessageSender, deps);

  assert.equal(result.data?.metadata.jobTitle, '新岗位');
  assert.equal(result.data?.metadata.jobId, 'NEW-2');
  assert.equal(result.data?.metadata.location, undefined);
  assert.notEqual(result.data?.metadata.sourceUrl, 'https://jobs.example.com/jobs/OLD-1');
});

test('候选跨 worker 存储并在确认时幂等创建一条事件记录', async () => {
  const chromeStorage = installChromeStorage();
  const submissionStorage: Record<string, unknown> = {};
  const deps = createDependencies(submissionStorage);
  try {
    const contextResult = await handleSubmissionAttemptStarted({
      sourceUrl: 'https://jobs.example.com/positions/123',
      startedAt: '2026-09-03T08:00:00.000Z',
      applicationEmail: 'used@example.com',
      triggerLabel: '提交申请',
    }, { tab: { id: 7 } } as chrome.runtime.MessageSender, deps);
    const context = contextResult.data!;
    const pending: PendingSubmission = {
      id: 'pending-1', contextId: context.id, score: 0.9,
      signals: ['buttonClick', 'successText'],
      createdAt: '2026-09-03T08:00:01.000Z', expiresAt: context.expiresAt, state: 'pending',
    };

    const saved = await handleUpsertPendingSubmission(
      { pending, context },
      { tab: { id: 7 } } as chrome.runtime.MessageSender,
      deps,
    );
    assert.equal(saved.success, true);
    assert.equal((submissionStorage[PENDING_SUBMISSIONS_STORAGE_KEY] as unknown[]).length, 1);
    assert.equal((await handleGetPendingSubmissions(deps)).data?.length, 1);

    const first = await handlePendingSubmissionDecision('pending-1', 'confirmed', undefined, deps);
    const second = await handlePendingSubmissionDecision('pending-1', 'confirmed', undefined, deps);
    assert.equal(first.success, true);
    assert.equal(second.data?.recordId, first.data?.recordId);
    const records = chromeStorage.values.applicationRecords as Array<{ events: unknown[] }>;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.events.length, 1);
  } finally {
    chromeStorage.restore();
  }
});

test('批量忽略只更新选中的待确认候选', async () => {
  const submissionStorage: Record<string, unknown> = {};
  const deps = createDependencies(submissionStorage);
  const context = (await handleSubmissionAttemptStarted({
    sourceUrl: 'https://jobs.example.com/positions/123',
    startedAt: '2026-09-03T08:00:00.000Z',
    triggerLabel: '提交申请',
  }, { tab: { id: 7 } } as chrome.runtime.MessageSender, deps)).data!;
  const pending = ['pending-a', 'pending-b', 'pending-c'].map((id): PendingSubmission => ({
    id,
    contextId: context.id,
    score: 0.9,
    signals: ['buttonClick', 'successText'],
    createdAt: '2026-09-03T08:00:01.000Z',
    expiresAt: context.expiresAt,
    state: 'pending',
  }));
  for (const item of pending) {
    await handleUpsertPendingSubmission(
      { pending: item, context },
      { tab: { id: 7 } } as chrome.runtime.MessageSender,
      deps,
    );
  }

  const result = await handleIgnorePendingSubmissions(['pending-a', 'pending-c'], deps);

  assert.equal(result.success, true);
  assert.equal(result.data?.ignored, 2);
  assert.deepEqual(
    (submissionStorage[PENDING_SUBMISSIONS_STORAGE_KEY] as PendingSubmission[])
      .filter(item => item.state === 'pending')
      .map(item => item.id),
    ['pending-b'],
  );
});

test('其他标签不能更新提交上下文', async () => {
  const storage: Record<string, unknown> = {};
  const deps = createDependencies(storage);
  const context = (await handleSubmissionAttemptStarted({
    sourceUrl: 'https://jobs.example.com/positions/123', startedAt: '2026-09-03T08:00:00.000Z', triggerLabel: 'Submit',
  }, { tab: { id: 7 } } as chrome.runtime.MessageSender, deps)).data!;
  const result = await handleUpsertPendingSubmission({
    context,
    pending: {
      id: 'pending', contextId: context.id, score: 0.8, signals: ['buttonClick', 'successText'],
      createdAt: context.startedAt, expiresAt: context.expiresAt, state: 'pending',
    },
  }, { tab: { id: 8 } } as chrome.runtime.MessageSender, deps);
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /不属于当前标签页/);
});
