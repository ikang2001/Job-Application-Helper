import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeApplicationRecord } from '../shared/applicationRecords.ts';
import type { MailAccount, OAuthTokenProvider } from '../services/mail/accounts.ts';
import type { MailProvider } from '../services/mail/provider.ts';
import type { MailHeader, NormalizedEmail } from '../services/mail/types.ts';
import {
  MAIL_ACCOUNTS_STORAGE_KEY,
  PENDING_MAIL_REVIEWS_STORAGE_KEY,
  handleConfirmMailReview,
  handleGetPendingMailReviews,
  handleSyncMail,
  type MailMonitorDependencies,
} from './mailMonitor.ts';

function installChromeStorage(initialRecords: unknown[]) {
  const original = globalThis.chrome;
  const values: Record<string, unknown> = {
    applicationRecords: initialRecords,
    applicationEventTombstones: [],
  };
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

function createHarness(email: NormalizedEmail, auto = true) {
  const account: MailAccount = {
    id: 'gmail-1', provider: 'gmail', emailAddress: 'candidate@example.com',
    oauthClientId: 'client-id', enabled: true, connectionState: 'connected',
  };
  const state: Record<string, unknown> = { [MAIL_ACCOUNTS_STORAGE_KEY]: [account] };
  const header: MailHeader = {
    id: email.id,
    from: email.from.address,
    to: email.to,
    subject: email.subject,
    receivedAt: email.receivedAt,
  };
  let listed = 0;
  const provider: MailProvider = {
    kind: 'gmail', accountId: account.id,
    testConnection: async () => ({ connected: true, accountId: account.id }),
    listHeaders: async () => {
      listed += 1;
      return { items: [header], syncCursor: auto ? 'cursor-1' : 'cursor-2' };
    },
    getMessage: async () => email,
  };
  const tokenProvider: OAuthTokenProvider = {
    getAccessToken: async () => ({ accessToken: 'test' }),
  };
  const dependencies: MailMonitorDependencies = {
    read: async key => state[key],
    write: async values => { Object.assign(state, structuredClone(values)); },
    tokenProvider,
    createProvider: () => provider,
    now: () => new Date('2026-09-03T08:00:00.000Z'),
  };
  return { account, state, dependencies, listed: () => listed };
}

function baseRecord() {
  return normalizeApplicationRecord({
    id: 'record-1', companyName: 'Acme Inc.', jobTitle: 'Software Engineer',
    jobId: 'REQ-1234', applicationId: 'APP-9876', applicationEmail: 'candidate@example.com',
    sourceSite: 'jobs.acme.com', sourceUrl: 'https://jobs.acme.com/REQ-1234',
    status: '已投递', notes: '', appliedAt: '2026-08-20', location: '上海',
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', events: [],
  });
}

test('高置信度邮件自动追加幂等事件并在成功后推进 cursor', async () => {
  const chromeStorage = installChromeStorage([baseRecord()]);
  const email: NormalizedEmail = {
    id: 'mail-1', accountId: 'gmail-1', provider: 'gmail',
    from: { address: 'recruiting@acme.com' }, to: ['candidate@example.com'],
    subject: 'Interview invitation for Software Engineer',
    receivedAt: '2026-09-01T08:00:00.000Z',
    text: 'Company: Acme Inc.\nPosition: Software Engineer\nJob ID: REQ-1234\nApplication ID: APP-9876\nInterview: 2026-09-10 14:30',
  };
  const harness = createHarness(email);
  try {
    const first = await handleSyncMail(undefined, harness.dependencies);
    const second = await handleSyncMail(undefined, harness.dependencies);
    assert.equal(first.success, true);
    assert.equal(first.data?.[0]?.autoUpdated, 1);
    assert.equal(second.data?.[0]?.autoUpdated, 0);
    const records = chromeStorage.values.applicationRecords as Array<{ events: unknown[] }>;
    assert.equal(records[0]?.events.length, 2, '保留 migration applied，并只追加一条 email 事件');
    const accounts = harness.state[MAIL_ACCOUNTS_STORAGE_KEY] as MailAccount[];
    assert.equal(accounts[0]?.cursor, 'cursor-1');
  } finally {
    chromeStorage.restore();
  }
});

test('中等匹配保存最小待确认项并可人工关联', async () => {
  const chromeStorage = installChromeStorage([{ ...baseRecord(), companyName: 'Acme Inc' }]);
  const email: NormalizedEmail = {
    id: 'mail-2', accountId: 'gmail-1', provider: 'gmail',
    from: { address: 'hr@acme.com' }, to: ['candidate@example.com'],
    subject: 'Interview invitation - Software Engineer',
    receivedAt: '2026-09-01T08:00:00.000Z',
    text: `Company: Acme Inc.\nPosition: Software Engineer\n${'正文'.repeat(1500)}`,
    html: '<p>不应持久化</p>',
  };
  const harness = createHarness(email, false);
  try {
    const sync = await handleSyncMail(undefined, harness.dependencies);
    assert.equal(sync.data?.[0]?.pendingReviews, 1);
    const reviews = (await handleGetPendingMailReviews(harness.dependencies)).data ?? [];
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.email.html, undefined);
    assert.ok((reviews[0]?.email.text?.length ?? 0) <= 2000);

    const confirmed = await handleConfirmMailReview(reviews[0]!.id, 'record-1', harness.dependencies);
    assert.equal(confirmed.success, true);
    assert.equal((await handleGetPendingMailReviews(harness.dependencies)).data?.length, 0);
    const records = chromeStorage.values.applicationRecords as Array<{ events: unknown[] }>;
    assert.equal(records[0]?.events.length, 2);
  } finally {
    chromeStorage.restore();
  }
});

test('单账号 Provider 失败被隔离为结果错误', async () => {
  const chromeStorage = installChromeStorage([baseRecord()]);
  const email: NormalizedEmail = {
    id: 'mail', accountId: 'gmail-1', provider: 'gmail', from: { address: 'hr@acme.com' },
    to: [], subject: 'Interview invitation', receivedAt: '2026-09-01T00:00:00.000Z',
  };
  const harness = createHarness(email);
  harness.dependencies.createProvider = () => ({
    kind: 'gmail', accountId: 'gmail-1',
    testConnection: async () => ({ connected: false, accountId: 'gmail-1' }),
    listHeaders: async () => { throw new Error('provider unavailable'); },
    getMessage: async () => email,
  });
  try {
    const result = await handleSyncMail(undefined, harness.dependencies);
    assert.equal(result.success, true);
    assert.match(result.data?.[0]?.error ?? '', /provider unavailable/);
  } finally {
    chromeStorage.restore();
  }
});

test('pending review storage key remains separate from business backup keys', () => {
  assert.equal(PENDING_MAIL_REVIEWS_STORAGE_KEY, 'pendingMailReviews');
});
