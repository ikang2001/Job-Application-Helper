import {
  createApplicationEvent,
} from '../shared/applicationEvents.ts';
import {
  appendApplicationEventToRecord,
  readApplicationEventTombstones,
  readApplicationRecords,
  suppressApplicationEventSource,
} from '../shared/applicationRecordRepository.ts';
import {
  normalizeMailAccount,
  type MailAccount,
  type OAuthTokenProvider,
} from '../services/mail/accounts.ts';
import { eventTypeForCategory, scanMailPage } from '../services/mail/mailService.ts';
import { MailProviderError, type MailProvider } from '../services/mail/provider.ts';
import { GmailProvider } from '../services/mail/providers/gmail.ts';
import { NativeImapProvider } from '../services/mail/providers/nativeImap.ts';
import { OutlookProvider } from '../services/mail/providers/outlook.ts';
import type {
  PendingMailReview,
  ProcessedMailCandidate,
  RecruitmentEventType,
} from '../services/mail/types.ts';
import type { ApplicationEventType, MessageResponse } from '../shared/types.ts';
import {
  ChromeMailOAuthTokenProvider,
  connectMailOAuth,
  disconnectMailOAuth,
} from './mailOAuth.ts';

export const MAIL_ACCOUNTS_STORAGE_KEY = 'mailAccounts';
export const PENDING_MAIL_REVIEWS_STORAGE_KEY = 'pendingMailReviews';
export const PROCESSED_MAIL_SOURCES_STORAGE_KEY = 'processedMailSources';
const MAX_PENDING_REVIEWS = 500;
const MAX_PROCESSED_SOURCES = 5000;
const MAX_SCAN_PAGES = 5;

interface ProcessedMailSource {
  sourceKey: string;
  processedAt: string;
}

export interface MailSyncAccountResult {
  accountId: string;
  inspectedHeaders: number;
  fetchedMessages: number;
  autoUpdated: number;
  pendingReviews: number;
  skippedDuplicates: number;
  error?: string;
}

export interface MailMonitorDependencies {
  read(key: string): Promise<unknown>;
  write(values: Record<string, unknown>): Promise<void>;
  tokenProvider: OAuthTokenProvider;
  createProvider(account: MailAccount, tokenProvider: OAuthTokenProvider): MailProvider;
  now(): Date;
}

const defaultDependencies: MailMonitorDependencies = {
  read: async key => (await chrome.storage.local.get(key))[key],
  write: values => chrome.storage.local.set(values),
  tokenProvider: new ChromeMailOAuthTokenProvider(),
  createProvider: createMailProvider,
  now: () => new Date(),
};

const accountQueues = new Map<string, Promise<unknown>>();
let accountMutationQueue: Promise<void> = Promise.resolve();

export async function handleGetMailAccounts(
  dependencies: MailMonitorDependencies = defaultDependencies,
): Promise<MessageResponse<MailAccount[]>> {
  return { success: true, data: await readAccounts(dependencies) };
}

export async function handleUpsertMailAccount(
  input: { account: MailAccount; credential?: string },
  dependencies: MailMonitorDependencies = defaultDependencies,
): Promise<MessageResponse<MailAccount>> {
  try {
    const now = dependencies.now().toISOString();
    const normalized = validateMailAccount(normalizeMailAccount({
      ...input.account,
      id: input.account.id.trim() || createId(),
      createdAt: input.account.createdAt || now,
      updatedAt: now,
      connectionState: input.account.connectionState ?? 'disconnected',
    }));
    await mutateAccounts(dependencies, accounts => [
      ...accounts.filter(account => account.id !== normalized.id),
      normalized,
    ]);
    if (normalized.provider === 'imap') {
      await new NativeImapProvider(normalized).upsertNativeAccount(input.credential);
    }
    return { success: true, data: normalized };
  } catch (error) {
    return failure(error, '保存邮箱账号失败');
  }
}

export async function handleConnectMailAccount(
  accountId: string,
  credential: string | undefined,
  dependencies: MailMonitorDependencies = defaultDependencies,
): Promise<MessageResponse> {
  try {
    const account = await requireMailAccount(accountId, dependencies);
    if (account.provider === 'imap') {
      const provider = new NativeImapProvider(account);
      await provider.upsertNativeAccount(credential);
      const result = await provider.testConnection();
      if (!result.connected) throw new Error(result.message || 'IMAP 连接失败');
    } else {
      await connectMailOAuth(account);
    }
    await updateAccount(dependencies, accountId, {
      connectionState: 'connected', lastError: undefined, updatedAt: dependencies.now().toISOString(),
    });
    return { success: true };
  } catch (error) {
    await updateAccount(dependencies, accountId, {
      connectionState: 'error', lastError: errorMessage(error), updatedAt: dependencies.now().toISOString(),
    }).catch(() => undefined);
    return failure(error, '连接邮箱失败');
  }
}

export async function handleDisconnectMailAccount(
  accountId: string,
  dependencies: MailMonitorDependencies = defaultDependencies,
): Promise<MessageResponse> {
  try {
    const account = await requireMailAccount(accountId, dependencies);
    if (account.provider === 'imap') await new NativeImapProvider(account).deleteNativeAccount();
    else await disconnectMailOAuth(accountId);
    await updateAccount(dependencies, accountId, {
      connectionState: 'disconnected', cursor: undefined, lastError: undefined,
      updatedAt: dependencies.now().toISOString(),
    });
    return { success: true };
  } catch (error) {
    return failure(error, '断开邮箱失败');
  }
}

export async function handleDeleteMailAccount(
  accountId: string,
  dependencies: MailMonitorDependencies = defaultDependencies,
): Promise<MessageResponse> {
  try {
    const account = (await readAccounts(dependencies)).find(item => item.id === accountId);
    if (account?.provider === 'imap') await new NativeImapProvider(account).deleteNativeAccount().catch(() => undefined);
    else await disconnectMailOAuth(accountId).catch(() => undefined);
    const reviews = await readPendingReviews(dependencies);
    await Promise.all([
      mutateAccounts(dependencies, accounts => accounts.filter(item => item.id !== accountId)),
      dependencies.write({
        [PENDING_MAIL_REVIEWS_STORAGE_KEY]: reviews.filter(review => review.email.accountId !== accountId),
      }),
    ]);
    return { success: true };
  } catch (error) {
    return failure(error, '删除邮箱失败');
  }
}

export async function handleTestMailAccount(
  accountId: string,
  dependencies: MailMonitorDependencies = defaultDependencies,
): Promise<MessageResponse> {
  try {
    const account = await requireMailAccount(accountId, dependencies);
    const result = await dependencies.createProvider(account, dependencies.tokenProvider).testConnection();
    if (!result.connected) return { success: false, error: result.message || '连接测试失败' };
    return { success: true, data: result };
  } catch (error) {
    return failure(error, '连接测试失败');
  }
}

export async function handleSyncMail(
  accountId: string | undefined,
  dependencies: MailMonitorDependencies = defaultDependencies,
): Promise<MessageResponse<MailSyncAccountResult[]>> {
  const accounts = (await readAccounts(dependencies)).filter(account => (
    account.enabled && (!accountId || account.id === accountId)
  ));
  if (accountId && accounts.length === 0) return { success: false, error: '邮箱账号不存在或未启用' };
  const results: MailSyncAccountResult[] = [];
  for (const account of accounts) {
    try {
      results.push(await enqueueAccount(account.id, () => syncMailAccount(account, dependencies)));
    } catch (error) {
      const message = errorMessage(error);
      await updateAccount(dependencies, account.id, {
        connectionState: /授权|AUTH_REQUIRED/i.test(message) ? 'needs-authorization' : 'error',
        lastError: message,
        updatedAt: dependencies.now().toISOString(),
      });
      results.push({
        accountId: account.id, inspectedHeaders: 0, fetchedMessages: 0,
        autoUpdated: 0, pendingReviews: 0, skippedDuplicates: 0, error: message,
      });
    }
  }
  return { success: true, data: results };
}

export async function handleGetPendingMailReviews(
  dependencies: MailMonitorDependencies = defaultDependencies,
): Promise<MessageResponse<PendingMailReview[]>> {
  return { success: true, data: await readPendingReviews(dependencies) };
}

export async function handleConfirmMailReview(
  reviewId: string,
  recordId: string | undefined,
  dependencies: MailMonitorDependencies = defaultDependencies,
): Promise<MessageResponse> {
  try {
    const reviews = await readPendingReviews(dependencies);
    const review = reviews.find(item => item.id === reviewId);
    if (!review) return { success: false, error: '待确认邮件不存在' };
    const targetRecordId = recordId || review.recordId;
    if (!targetRecordId) return { success: false, error: '请选择要关联的投递记录' };
    const event = eventFromReview(review);
    const result = await appendApplicationEventToRecord(targetRecordId, event);
    if (!result.record) return { success: false, error: '投递记录不存在' };
    await finalizeReview(review, reviews, dependencies);
    return { success: true, data: { recordId: targetRecordId, added: result.added } };
  } catch (error) {
    return failure(error, '确认邮件关联失败');
  }
}

export async function handleIgnoreMailReview(
  reviewId: string,
  dependencies: MailMonitorDependencies = defaultDependencies,
): Promise<MessageResponse> {
  try {
    const reviews = await readPendingReviews(dependencies);
    const review = reviews.find(item => item.id === reviewId);
    if (!review) return { success: false, error: '待确认邮件不存在' };
    if (review.recordId) {
      await suppressApplicationEventSource(
        review.recordId, review.sourceKey, 'ignored', dependencies.now().toISOString(),
      );
    }
    await finalizeReview(review, reviews, dependencies);
    return { success: true };
  } catch (error) {
    return failure(error, '忽略邮件失败');
  }
}

async function syncMailAccount(
  account: MailAccount,
  dependencies: MailMonitorDependencies,
): Promise<MailSyncAccountResult> {
  const provider = dependencies.createProvider(account, dependencies.tokenProvider);
  const records = await readApplicationRecords();
  const tombstones = await readApplicationEventTombstones();
  const processed = await readProcessedSources(dependencies);
  const existingKeys = records.flatMap(record => record.events.map(event => event.sourceKey));
  let cursor = account.cursor;
  let inspectedHeaders = 0;
  let fetchedMessages = 0;
  let autoUpdated = 0;
  let pendingCount = 0;
  let skippedDuplicates = 0;
  const newReviews: PendingMailReview[] = [];
  const newProcessed: ProcessedMailSource[] = [];
  let cursorFallbackUsed = false;

  for (let pageIndex = 0; pageIndex < MAX_SCAN_PAGES; pageIndex += 1) {
    let result;
    try {
      result = await scanMailPage(provider, records, {
        limit: 50,
        cursor,
        since: account.lastSyncAt ?? new Date(dependencies.now().getTime() - 30 * 86_400_000).toISOString(),
        existingSourceKeys: [...existingKeys, ...processed, ...newProcessed],
        suppressedSourceKeys: tombstones,
      });
    } catch (error) {
      if (
        error instanceof MailProviderError
        && error.code === 'CURSOR_EXPIRED'
        && cursor
        && !cursorFallbackUsed
      ) {
        cursor = undefined;
        cursorFallbackUsed = true;
        pageIndex -= 1;
        continue;
      }
      throw error;
    }
    inspectedHeaders += result.inspectedHeaders;
    fetchedMessages += result.fetchedMessages;
    skippedDuplicates += result.skippedDuplicates;

    for (const candidate of result.candidates) {
      if (candidate.decision.disposition === 'auto-update' && candidate.match.recordId) {
        const append = await appendApplicationEventToRecord(
          candidate.match.recordId,
          eventFromCandidate(candidate),
        );
        if (append.added) autoUpdated += 1;
        newProcessed.push({ sourceKey: candidate.sourceKey, processedAt: dependencies.now().toISOString() });
      } else if (candidate.pendingReview) {
        newReviews.push(sanitizePendingReview(candidate.pendingReview));
        pendingCount += 1;
      } else {
        newProcessed.push({ sourceKey: candidate.sourceKey, processedAt: dependencies.now().toISOString() });
      }
    }

    if (result.nextCursor) {
      cursor = result.nextCursor;
      continue;
    }
    cursor = result.syncCursor ?? cursor;
    break;
  }

  const existingReviews = await readPendingReviews(dependencies);
  const reviewsById = new Map(existingReviews.map(review => [review.id, review]));
  newReviews.forEach(review => reviewsById.set(review.id, review));
  await dependencies.write({
    [PENDING_MAIL_REVIEWS_STORAGE_KEY]: [...reviewsById.values()].slice(-MAX_PENDING_REVIEWS),
    [PROCESSED_MAIL_SOURCES_STORAGE_KEY]: uniqueProcessed([...processed, ...newProcessed]).slice(-MAX_PROCESSED_SOURCES),
  });
  await updateAccount(dependencies, account.id, {
    cursor,
    lastSyncAt: dependencies.now().toISOString(),
    lastError: undefined,
    connectionState: 'connected',
    updatedAt: dependencies.now().toISOString(),
  });
  return {
    accountId: account.id,
    inspectedHeaders,
    fetchedMessages,
    autoUpdated,
    pendingReviews: pendingCount,
    skippedDuplicates,
  };
}

function createMailProvider(account: MailAccount, tokenProvider: OAuthTokenProvider): MailProvider {
  if (account.provider === 'gmail') return new GmailProvider({ accountId: account.id, tokenProvider });
  if (account.provider === 'outlook') return new OutlookProvider({ accountId: account.id, tokenProvider });
  return new NativeImapProvider(account);
}

function eventFromCandidate(candidate: ProcessedMailCandidate) {
  return createApplicationEvent({
    type: toApplicationEventType(candidate.eventType),
    occurredAt: candidate.email.receivedAt,
    source: 'email',
    title: titleForEvent(candidate.eventType),
    sourceKey: candidate.sourceKey,
    emailAccountId: candidate.email.accountId,
    emailMessageId: candidate.email.id,
    classificationConfidence: candidate.decision.classificationConfidence,
    matchConfidence: candidate.decision.matchConfidence,
    decisionConfidence: candidate.decision.decisionConfidence,
    metadata: {
      jobId: candidate.extracted.jobId,
      applicationId: candidate.extracted.applicationId,
      interviewAt: candidate.extracted.interviewAt,
      deadlineAt: candidate.extracted.deadlineAt,
      meetingUrl: candidate.extracted.meetingUrl,
      emailSubject: candidate.email.subject.slice(0, 500),
      summary: candidate.extracted.summary?.slice(0, 2000),
      classification: candidate.classification.category,
    },
  });
}

function eventFromReview(review: PendingMailReview) {
  const eventType = eventTypeForCategory(review.classification.category);
  if (!eventType) throw new Error('该邮件分类不能生成投递事件');
  return createApplicationEvent({
    type: toApplicationEventType(eventType),
    occurredAt: review.email.receivedAt,
    source: 'email',
    title: titleForEvent(eventType),
    sourceKey: review.sourceKey,
    emailAccountId: review.email.accountId,
    emailMessageId: review.email.id,
    classificationConfidence: review.confidences.classificationConfidence,
    matchConfidence: review.confidences.matchConfidence,
    decisionConfidence: review.confidences.decisionConfidence,
    metadata: {
      jobId: review.extracted.jobId,
      applicationId: review.extracted.applicationId,
      interviewAt: review.extracted.interviewAt,
      deadlineAt: review.extracted.deadlineAt,
      meetingUrl: review.extracted.meetingUrl,
      emailSubject: review.email.subject.slice(0, 500),
      summary: review.extracted.summary?.slice(0, 2000),
      classification: review.classification.category,
    },
  });
}

function toApplicationEventType(type: RecruitmentEventType): ApplicationEventType {
  return type === 'note' ? 'note' : type;
}

function titleForEvent(type: RecruitmentEventType): string {
  return ({
    application_received: '申请已收到', assessment_invite: '收到笔试/测评邀请',
    interview_invite: '收到面试邀请', offer: '收到 Offer', rejection: '收到拒信',
    job_closed: '职位已关闭', note: '招聘方消息',
  } satisfies Record<RecruitmentEventType, string>)[type];
}

function sanitizePendingReview(review: PendingMailReview): PendingMailReview {
  return {
    ...review,
    email: {
      ...review.email,
      text: review.email.text?.slice(0, 2000),
      html: undefined,
    },
    extracted: { ...review.extracted, summary: review.extracted.summary?.slice(0, 2000) },
  };
}

async function finalizeReview(
  review: PendingMailReview,
  reviews: PendingMailReview[],
  dependencies: MailMonitorDependencies,
): Promise<void> {
  const processed = await readProcessedSources(dependencies);
  await dependencies.write({
    [PENDING_MAIL_REVIEWS_STORAGE_KEY]: reviews.filter(item => item.id !== review.id),
    [PROCESSED_MAIL_SOURCES_STORAGE_KEY]: uniqueProcessed([
      ...processed,
      { sourceKey: review.sourceKey, processedAt: dependencies.now().toISOString() },
    ]).slice(-MAX_PROCESSED_SOURCES),
  });
}

async function readAccounts(dependencies: MailMonitorDependencies): Promise<MailAccount[]> {
  const input = await dependencies.read(MAIL_ACCOUNTS_STORAGE_KEY);
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is MailAccount => (
    Boolean(value)
    && typeof value === 'object'
    && 'id' in value
    && typeof value.id === 'string'
    && 'emailAddress' in value
    && typeof value.emailAddress === 'string'
    && 'provider' in value
    && ['gmail', 'outlook', 'imap'].includes(String(value.provider))
  ))
    .map(normalizeMailAccount)
    .filter(account => account.id && ['gmail', 'outlook', 'imap'].includes(account.provider));
}

async function readPendingReviews(dependencies: MailMonitorDependencies): Promise<PendingMailReview[]> {
  const input = await dependencies.read(PENDING_MAIL_REVIEWS_STORAGE_KEY);
  return Array.isArray(input)
    ? input.filter((value): value is PendingMailReview => (
        Boolean(value) && typeof value === 'object' && 'id' in value && 'sourceKey' in value
      ))
    : [];
}

async function readProcessedSources(dependencies: MailMonitorDependencies): Promise<ProcessedMailSource[]> {
  const input = await dependencies.read(PROCESSED_MAIL_SOURCES_STORAGE_KEY);
  return Array.isArray(input)
    ? input.filter((value): value is ProcessedMailSource => (
        Boolean(value) && typeof value === 'object' && 'sourceKey' in value
        && typeof value.sourceKey === 'string'
      ))
    : [];
}

function mutateAccounts(
  dependencies: MailMonitorDependencies,
  mutation: (accounts: MailAccount[]) => MailAccount[],
): Promise<void> {
  const task = accountMutationQueue.then(async () => {
    const accounts = await readAccounts(dependencies);
    await dependencies.write({ [MAIL_ACCOUNTS_STORAGE_KEY]: mutation(accounts) });
  });
  accountMutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

function updateAccount(
  dependencies: MailMonitorDependencies,
  accountId: string,
  updates: Partial<MailAccount>,
): Promise<void> {
  return mutateAccounts(dependencies, accounts => accounts.map(account => (
    account.id === accountId ? normalizeMailAccount({ ...account, ...updates }) : account
  )));
}

async function requireMailAccount(accountId: string, dependencies: MailMonitorDependencies): Promise<MailAccount> {
  const account = (await readAccounts(dependencies)).find(item => item.id === accountId);
  if (!account) throw new Error('邮箱账号不存在');
  return account;
}

function validateMailAccount(account: MailAccount): MailAccount {
  if (!account.id || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.emailAddress)) {
    throw new Error('邮箱账号格式无效');
  }
  if ((account.provider === 'gmail' || account.provider === 'outlook') && !account.oauthClientId) {
    throw new Error('OAuth 邮箱必须填写 Client ID');
  }
  if (account.provider === 'imap' && (!account.imap?.host || !account.imap.username || account.imap.secure !== true)) {
    throw new Error('IMAP 账号必须填写 TLS 主机和用户名');
  }
  return account;
}

function enqueueAccount<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
  const previous = accountQueues.get(accountId) ?? Promise.resolve();
  const task = previous.then(operation, operation);
  accountQueues.set(accountId, task.then(() => undefined, () => undefined));
  return task;
}

function uniqueProcessed(values: ProcessedMailSource[]): ProcessedMailSource[] {
  return [...new Map(values.map(value => [value.sourceKey, value])).values()];
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '邮箱操作失败';
}

function failure<T>(error: unknown, fallback: string): MessageResponse<T> {
  return { success: false, error: error instanceof Error ? error.message : fallback };
}
