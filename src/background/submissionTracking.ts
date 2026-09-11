import {
  addApplicationEvent,
  createApplicationEvent,
} from '../shared/applicationEvents.ts';
import {
  findApplicationRecordDuplicate,
  normalizeApplicationRecord,
  normalizeApplicationRecordUrl,
} from '../shared/applicationRecords.ts';
import { mutateApplicationRecords } from '../shared/applicationRecordRepository.ts';
import { StorageService } from '../shared/storage.ts';
import { isGenericJobTitleLabel, isSubmissionFlowUrl } from '../shared/jobMetadata.ts';
import type {
  ApplicationPageMetadata,
  ApplicationRecord,
  Message,
  MessageResponse,
  PendingSubmission,
  SubmissionAttemptSnapshot,
  SubmissionContext,
} from '../shared/types.ts';

export const SUBMISSION_CONTEXTS_STORAGE_KEY = 'submissionContexts';
export const PENDING_SUBMISSIONS_STORAGE_KEY = 'pendingSubmissions';
export const SUBMISSION_PAGE_METADATA_CACHE_KEY = 'submissionPageMetadataCache';
const SUBMISSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STORED_SUBMISSIONS = 100;

export interface SubmissionTrackingDependencies {
  getMetadata(tabId: number): Promise<ApplicationPageMetadata>;
  getActiveResume(): Promise<{
    id: string;
    name: string;
    updatedAt: string;
    fileName?: string;
  }>;
  read(key: string): Promise<unknown>;
  write(values: Record<string, unknown>): Promise<void>;
  getCachedMetadata(
    tabId: number,
    sourceUrl?: string,
  ): Promise<SubmissionContext['metadata'] | undefined>;
  setCachedMetadata(tabId: number, metadata: SubmissionContext['metadata']): Promise<void>;
  now(): Date;
  createId(): string;
}

const defaultDependencies: SubmissionTrackingDependencies = {
  getMetadata: async (tabId) => {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'GET_APPLICATION_PAGE_METADATA', payload: null,
    } satisfies Message) as MessageResponse<ApplicationPageMetadata>;
    if (!response.success || !response.data) throw new Error(response.error || '无法读取岗位信息');
    return response.data;
  },
  getActiveResume: async () => {
    const library = await StorageService.getResumeProfileLibrary();
    const active = library.profiles.find(profile => profile.id === library.activeProfileId);
    if (!active) throw new Error('当前简历不存在');
    return {
      id: active.id,
      name: active.name,
      updatedAt: active.updatedAt,
      fileName: active.profile.resume?.fileName,
    };
  },
  read: async (key) => (await chrome.storage.local.get(key))[key],
  write: values => chrome.storage.local.set(values),
  getCachedMetadata: readCachedMetadataFromSession,
  setCachedMetadata: writeCachedMetadataToSession,
  now: () => new Date(),
  createId: () => globalThis.crypto?.randomUUID?.() ?? `submission-${Date.now()}-${Math.random().toString(36).slice(2)}`,
};

export async function handleCacheApplicationPageMetadata(
  input: Partial<ApplicationPageMetadata>,
  sender: chrome.runtime.MessageSender,
  dependencies: SubmissionTrackingDependencies = defaultDependencies,
): Promise<MessageResponse<{ cached: boolean }>> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return { success: false, error: '岗位快照只能由网页标签触发' };

  const metadata = sanitizeMetadata(input);
  if (!isCacheableJobMetadata(metadata)) {
    return { success: true, data: { cached: false } };
  }

  const existing = await dependencies.getCachedMetadata(tabId, metadata.sourceUrl);
  const cachedMetadata = existing && isSameJob(existing, metadata)
    ? mergeDefinedMetadata(existing, metadata)
    : metadata;
  await dependencies.setCachedMetadata(tabId, cachedMetadata);
  return { success: true, data: { cached: true } };
}

export async function handleSubmissionAttemptStarted(
  attempt: SubmissionAttemptSnapshot,
  sender: chrome.runtime.MessageSender,
  dependencies: SubmissionTrackingDependencies = defaultDependencies,
): Promise<MessageResponse<SubmissionContext>> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') return { success: false, error: '提交检测只能由网页标签触发' };
  if (!isSafeHttpUrl(attempt.sourceUrl) || Number.isNaN(Date.parse(attempt.startedAt))) {
    return { success: false, error: '提交尝试参数无效' };
  }

  try {
    const [metadataResult, cachedMetadata, resume, contextsInput] = await Promise.all([
      dependencies.getMetadata(tabId).then(
        metadata => ({ metadata }),
        error => ({ error }),
      ),
      dependencies.getCachedMetadata(tabId, attempt.metadata?.sourceUrl),
      dependencies.getActiveResume(),
      dependencies.read(SUBMISSION_CONTEXTS_STORAGE_KEY),
    ]);
    const now = dependencies.now();
    const metadata = mergeSubmissionMetadata(
      attempt.metadata,
      cachedMetadata,
      'metadata' in metadataResult ? metadataResult.metadata : undefined,
      attempt.sourceUrl,
    );
    if (!hasMetadata(metadata) && 'error' in metadataResult) throw metadataResult.error;
    const context: SubmissionContext = {
      id: dependencies.createId(),
      tabId,
      sourceUrl: attempt.sourceUrl,
      startedAt: attempt.startedAt,
      resumeProfileId: resume.id,
      resumeProfileName: resume.name,
      resumeFileName: resume.fileName,
      resumeRevision: resume.updatedAt,
      applicationEmail: attempt.applicationEmail,
      metadata,
      expiresAt: new Date(now.getTime() + SUBMISSION_TTL_MS).toISOString(),
    };
    const contexts = activeContexts(contextsInput, now);
    await dependencies.write({
      [SUBMISSION_CONTEXTS_STORAGE_KEY]: [...contexts, context].slice(-MAX_STORED_SUBMISSIONS),
    });
    return { success: true, data: context };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '创建提交上下文失败' };
  }
}

export async function handleUpsertPendingSubmission(
  input: { pending: PendingSubmission; context: SubmissionContext },
  sender: chrome.runtime.MessageSender,
  dependencies: SubmissionTrackingDependencies = defaultDependencies,
): Promise<MessageResponse<{ pending: PendingSubmission; recordId?: string }>> {
  try {
    const stored = await loadStoredSubmission(input.pending.id, dependencies);
    const context = stored.contexts.find(item => item.id === input.pending.contextId);
    if (!context) return { success: false, error: '提交上下文不存在或已过期' };
    if (sender.tab?.id !== undefined && sender.tab.id !== context.tabId) {
      return { success: false, error: '提交上下文不属于当前标签页' };
    }
    const pending = normalizePending(input.pending, context, dependencies.now());
    const editableContext: SubmissionContext = {
      ...context,
      metadata: { ...context.metadata, ...sanitizeMetadata(input.context.metadata) },
    };
    const pendingList = [
      ...stored.pending.filter(item => item.id !== pending.id),
      pending,
    ].slice(-MAX_STORED_SUBMISSIONS);
    await dependencies.write({
      [SUBMISSION_CONTEXTS_STORAGE_KEY]: stored.contexts.map(item => item.id === context.id ? editableContext : item),
      [PENDING_SUBMISSIONS_STORAGE_KEY]: pendingList,
    });
    const recordId = pending.state === 'confirmed'
      ? await saveConfirmedSubmission(editableContext, pending)
      : undefined;
    return { success: true, data: { pending, recordId } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '保存提交候选失败' };
  }
}

export async function handleGetPendingSubmissions(
  dependencies: SubmissionTrackingDependencies = defaultDependencies,
): Promise<MessageResponse<Array<{ pending: PendingSubmission; context: SubmissionContext }>>> {
  const now = dependencies.now();
  const [contextsInput, pendingInput] = await Promise.all([
    dependencies.read(SUBMISSION_CONTEXTS_STORAGE_KEY),
    dependencies.read(PENDING_SUBMISSIONS_STORAGE_KEY),
  ]);
  const contexts = activeContexts(contextsInput, now);
  const pending = activePending(pendingInput, now).filter(item => item.state === 'pending');
  const result = pending.flatMap(item => {
    const context = contexts.find(candidate => candidate.id === item.contextId);
    return context ? [{ pending: item, context }] : [];
  });
  return { success: true, data: result };
}

export async function handlePendingSubmissionDecision(
  pendingId: string,
  state: 'confirmed' | 'ignored',
  metadata: Partial<ApplicationPageMetadata> | undefined,
  dependencies: SubmissionTrackingDependencies = defaultDependencies,
): Promise<MessageResponse<{ recordId?: string }>> {
  const stored = await loadStoredSubmission(pendingId, dependencies);
  const current = stored.pending.find(item => item.id === pendingId);
  if (!current) return { success: false, error: '提交候选不存在或已过期' };
  const context = stored.contexts.find(item => item.id === current.contextId);
  if (!context) return { success: false, error: '提交上下文不存在或已过期' };
  const updated = { ...current, state };
  const updatedContext = { ...context, metadata: { ...context.metadata, ...sanitizeMetadata(metadata) } };
  await dependencies.write({
    [PENDING_SUBMISSIONS_STORAGE_KEY]: stored.pending.map(item => item.id === pendingId ? updated : item),
    [SUBMISSION_CONTEXTS_STORAGE_KEY]: stored.contexts.map(item => item.id === context.id ? updatedContext : item),
  });
  const recordId = state === 'confirmed' ? await saveConfirmedSubmission(updatedContext, updated) : undefined;
  return { success: true, data: { recordId } };
}

export async function handleIgnorePendingSubmissions(
  pendingIds: readonly string[],
  dependencies: SubmissionTrackingDependencies = defaultDependencies,
): Promise<MessageResponse<{ ignored: number }>> {
  const ids = new Set(pendingIds.filter(id => typeof id === 'string' && id.trim()).slice(0, 500));
  if (ids.size === 0) return { success: false, error: '请选择要忽略的投递候选' };
  const stored = await loadStoredSubmission('', dependencies);
  const availableIds = new Set(stored.pending
    .filter(item => item.state === 'pending' && ids.has(item.id))
    .map(item => item.id));
  if (availableIds.size === 0) return { success: false, error: '所选投递候选不存在或已过期' };
  await dependencies.write({
    [PENDING_SUBMISSIONS_STORAGE_KEY]: stored.pending.map(item => (
      availableIds.has(item.id) ? { ...item, state: 'ignored' as const } : item
    )),
  });
  return { success: true, data: { ignored: availableIds.size } };
}

async function saveConfirmedSubmission(
  context: SubmissionContext,
  pending: PendingSubmission,
): Promise<string> {
  const sourceUrl = normalizeApplicationRecordUrl(context.metadata.sourceUrl ?? context.sourceUrl);
  const sourceKey = `website:${encodeURIComponent(sourceUrl)}:submission:${encodeURIComponent(pending.id)}`;
  const event = createApplicationEvent({
    type: 'applied',
    occurredAt: context.startedAt,
    source: 'website',
    title: '已投递',
    sourceKey,
    metadata: {
      jobId: context.metadata.jobId,
      applicationId: context.metadata.applicationId,
    },
  });

  return mutateApplicationRecords((records) => {
    const draft = recordFromContext(context, event.id);
    const duplicate = findApplicationRecordDuplicate(records, draft);
    if (duplicate) {
      const index = records.findIndex(record => record.id === duplicate.id);
      const updated = addApplicationEvent({
        ...duplicate,
        jobId: duplicate.jobId ?? context.metadata.jobId,
        applicationId: duplicate.applicationId ?? context.metadata.applicationId,
        applicationEmail: duplicate.applicationEmail ?? context.applicationEmail,
        resumeSnapshot: duplicate.resumeSnapshot ?? draft.resumeSnapshot,
        jdSnapshot: duplicate.jdSnapshot ?? context.metadata.jdSnapshot,
      }, event, context.startedAt);
      const next = [...records];
      next[index] = updated;
      return { records: next, result: duplicate.id };
    }
    return { records: [...records, { ...draft, events: [event] }], result: draft.id };
  });
}

function recordFromContext(context: SubmissionContext, eventId: string): ApplicationRecord {
  const now = context.startedAt;
  return normalizeApplicationRecord({
    id: `record_${eventId}`,
    companyName: context.metadata.companyName ?? '',
    jobTitle: context.metadata.jobTitle ?? '',
    jobId: context.metadata.jobId,
    applicationId: context.metadata.applicationId,
    sourceSite: context.metadata.sourceSite ?? hostname(context.sourceUrl),
    sourceUrl: context.metadata.sourceUrl ?? context.sourceUrl,
    employmentType: context.metadata.employmentType,
    status: '已投递',
    notes: '',
    appliedAt: now.slice(0, 10),
    applicationEmail: context.applicationEmail,
    resumeSnapshot: {
      profileId: context.resumeProfileId,
      profileName: context.resumeProfileName,
      fileName: context.resumeFileName,
      profileUpdatedAt: context.resumeRevision,
    },
    jdSnapshot: context.metadata.jdSnapshot,
    events: [],
    location: context.metadata.location ?? '',
    createdAt: now,
    updatedAt: now,
  });
}

async function loadStoredSubmission(
  _pendingId: string,
  dependencies: SubmissionTrackingDependencies,
): Promise<{ contexts: SubmissionContext[]; pending: PendingSubmission[] }> {
  const now = dependencies.now();
  const [contexts, pending] = await Promise.all([
    dependencies.read(SUBMISSION_CONTEXTS_STORAGE_KEY),
    dependencies.read(PENDING_SUBMISSIONS_STORAGE_KEY),
  ]);
  return { contexts: activeContexts(contexts, now), pending: activePending(pending, now) };
}

function activeContexts(input: unknown, now: Date): SubmissionContext[] {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is SubmissionContext => (
    isRecord(value)
    && typeof value.id === 'string'
    && typeof value.tabId === 'number'
    && typeof value.sourceUrl === 'string'
    && typeof value.expiresAt === 'string'
    && Date.parse(value.expiresAt) > now.getTime()
  ));
}

function activePending(input: unknown, now: Date): PendingSubmission[] {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is PendingSubmission => (
    isRecord(value)
    && typeof value.id === 'string'
    && typeof value.contextId === 'string'
    && typeof value.expiresAt === 'string'
    && Date.parse(value.expiresAt) > now.getTime()
    && ['pending', 'confirmed', 'ignored'].includes(String(value.state))
  ));
}

function normalizePending(input: PendingSubmission, context: SubmissionContext, now: Date): PendingSubmission {
  if (input.contextId !== context.id) throw new Error('候选与提交上下文不匹配');
  if (!Number.isFinite(input.score) || input.score < 0 || input.score > 1) throw new Error('提交候选分数无效');
  return {
    ...input,
    score: Math.round(input.score * 100) / 100,
    signals: [...new Set(input.signals)],
    createdAt: Number.isNaN(Date.parse(input.createdAt)) ? now.toISOString() : input.createdAt,
    expiresAt: context.expiresAt,
  };
}

function sanitizeMetadata(input: Partial<ApplicationPageMetadata> | undefined): SubmissionContext['metadata'] {
  if (!input) return {};
  const companyName = text(input.companyName);
  const jobTitle = text(input.jobTitle);
  return {
    companyName,
    jobTitle: jobTitle
      && !isGenericJobTitleLabel(jobTitle)
      && normalizeIdentity(jobTitle) !== normalizeIdentity(companyName)
      ? jobTitle
      : undefined,
    jobId: text(input.jobId),
    applicationId: text(input.applicationId),
    location: text(input.location),
    employmentType: text(input.employmentType),
    sourceSite: text(input.sourceSite),
    sourceUrl: isSafeHttpUrl(input.sourceUrl) ? input.sourceUrl : undefined,
    pageTitle: text(input.pageTitle),
    jdSnapshot: input.jdSnapshot,
  };
}

function mergeSubmissionMetadata(
  preClickInput: Partial<ApplicationPageMetadata> | undefined,
  cachedInput: Partial<ApplicationPageMetadata> | undefined,
  currentInput: Partial<ApplicationPageMetadata> | undefined,
  attemptUrl: string,
): SubmissionContext['metadata'] {
  const preClick = sanitizeMetadata(preClickInput);
  const cached = sanitizeMetadata(cachedInput);
  const current = sanitizeMetadata(currentInput);
  const live = hasJobIdentity(preClick) ? preClick : hasJobIdentity(current) ? current : undefined;
  const safeCached = !live || isSameJob(cached, live) ? cached : {};
  const primary = live ?? (hasJobIdentity(safeCached) ? safeCached : undefined) ?? preClick ?? current;
  const useCachedLink = Boolean(
    safeCached.sourceUrl
    && !isSubmissionFlowUrl(safeCached.sourceUrl),
  );
  const candidates = [primary, preClick, safeCached, current];
  const sourceUrl = useCachedLink && safeCached.sourceUrl
    ? safeCached.sourceUrl
    : firstMetadataValue(candidates, 'sourceUrl') ?? attemptUrl;

  return sanitizeMetadata({
    companyName: firstMetadataValue(candidates, 'companyName') ?? '',
    jobTitle: firstMetadataValue(candidates, 'jobTitle'),
    jobId: firstMetadataValue(candidates, 'jobId'),
    applicationId: firstMetadataValue([current, preClick, cached], 'applicationId'),
    location: firstMetadataValue(candidates, 'location'),
    employmentType: firstMetadataValue(candidates, 'employmentType'),
    sourceSite: hostname(sourceUrl) || firstMetadataValue(candidates, 'sourceSite') || '',
    sourceUrl,
    pageTitle: firstMetadataValue(candidates, 'pageTitle'),
    jdSnapshot: candidates.find(candidate => candidate.jdSnapshot)?.jdSnapshot,
  });
}

function firstMetadataValue<K extends keyof SubmissionContext['metadata']>(
  candidates: SubmissionContext['metadata'][],
  key: K,
): SubmissionContext['metadata'][K] | undefined {
  return candidates.map(candidate => candidate[key]).find(Boolean);
}

function hasJobIdentity(metadata: SubmissionContext['metadata']): boolean {
  return Boolean(metadata.jobTitle || metadata.jobId || metadata.jdSnapshot);
}

function hasMetadata(metadata: SubmissionContext['metadata']): boolean {
  return Object.values(metadata).some(Boolean);
}

function isSameJob(
  left: SubmissionContext['metadata'],
  right: SubmissionContext['metadata'],
): boolean {
  if (left.jobId && right.jobId) return normalizeIdentity(left.jobId) === normalizeIdentity(right.jobId);
  if (!left.jobTitle || !right.jobTitle) return false;
  if (normalizeIdentity(left.jobTitle) !== normalizeIdentity(right.jobTitle)) return false;
  return !left.companyName
    || !right.companyName
    || normalizeIdentity(left.companyName) === normalizeIdentity(right.companyName);
}

function mergeDefinedMetadata(
  base: SubmissionContext['metadata'],
  incoming: SubmissionContext['metadata'],
): SubmissionContext['metadata'] {
  const definedIncoming = Object.fromEntries(
    Object.entries(incoming).filter(([, value]) => value !== undefined),
  ) as SubmissionContext['metadata'];
  return { ...base, ...definedIncoming };
}

function isCacheableJobMetadata(metadata: SubmissionContext['metadata']): boolean {
  return Boolean(
    hasJobIdentity(metadata)
    && metadata.sourceUrl
    && !isSubmissionFlowUrl(metadata.sourceUrl),
  );
}

function normalizeIdentity(value: string | undefined): string {
  return value?.replace(/\s+/g, '').toLowerCase() ?? '';
}

async function readCachedMetadataFromSession(
  tabId: number,
  sourceUrl?: string,
): Promise<SubmissionContext['metadata'] | undefined> {
  const stored = (await chrome.storage.session.get(SUBMISSION_PAGE_METADATA_CACHE_KEY))[
    SUBMISSION_PAGE_METADATA_CACHE_KEY
  ];
  if (!isRecord(stored)) return undefined;
  const cachedValues = Object.values(stored)
    .map(value => sanitizeMetadata(value as Partial<ApplicationPageMetadata> | undefined));
  const matchedByUrl = sourceUrl && isSafeHttpUrl(sourceUrl)
    ? cachedValues.filter(metadata => (
      metadata.sourceUrl
      && normalizeApplicationRecordUrl(metadata.sourceUrl) === normalizeApplicationRecordUrl(sourceUrl)
    )).sort((left, right) => metadataCompleteness(right) - metadataCompleteness(left))[0]
    : undefined;
  const metadata = matchedByUrl
    ?? sanitizeMetadata(stored[String(tabId)] as Partial<ApplicationPageMetadata> | undefined);
  return hasMetadata(metadata) ? metadata : undefined;
}

function metadataCompleteness(metadata: SubmissionContext['metadata']): number {
  return Number(Boolean(metadata.companyName))
    + Number(Boolean(metadata.jobTitle)) * 3
    + Number(Boolean(metadata.jobId)) * 2
    + Number(Boolean(metadata.location))
    + Number(Boolean(metadata.employmentType))
    + Number(Boolean(metadata.jdSnapshot)) * 4;
}

async function writeCachedMetadataToSession(
  tabId: number,
  metadata: SubmissionContext['metadata'],
): Promise<void> {
  const stored = (await chrome.storage.session.get(SUBMISSION_PAGE_METADATA_CACHE_KEY))[
    SUBMISSION_PAGE_METADATA_CACHE_KEY
  ];
  await chrome.storage.session.set({
    [SUBMISSION_PAGE_METADATA_CACHE_KEY]: {
      ...(isRecord(stored) ? stored : {}),
      [String(tabId)]: metadata,
    },
  });
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 20_000) : undefined;
}

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function hostname(value: string): string {
  try { return new URL(value).host; } catch { return ''; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const __submissionTrackingInternals = {
  activeContexts,
  activePending,
  normalizePending,
  sanitizeMetadata,
  mergeSubmissionMetadata,
  isSubmissionFlowUrl,
  recordFromContext,
};
