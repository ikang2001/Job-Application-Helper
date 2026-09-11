import type {
  FocusedFieldWriteResult,
  Message,
  MessageResponse,
  UserProfile,
  ParsedResumeData,
  VisualRegionFillPayload,
  VisualRegionFillRequestPayload,
  WebDAVConfig,
} from '../shared/types.ts';
import { StorageService, STORAGE_KEYS } from '../shared/storage.ts';
import { updateActiveUserProfile } from '../shared/resumeProfiles.ts';
import {
  createBackupDocument,
  createBackupSummary,
  parseAndValidateBackup,
  serializeBackup,
} from '../shared/backup.ts';
import {
  enqueueSync,
  enqueueSyncAndWait,
  forceDownloadRemote,
  forceUploadLocal,
  resolveConflict,
} from '../shared/sync.ts';
import {
  normalizeWebDAVServerUrl,
  testConnection as testWebDAVConnection,
  validateWebDAVUrl,
} from '../services/webdav.ts';
import { parseResume, isStructuredType, parseStructuredResume } from '../parsers/index.ts';
import { NLPHelper } from '../utils/nlpHelper.ts';
import { normalizeDescriptionText } from '../utils/descriptionText.ts';
import { buildAuthoritativeFillProfile } from '../utils/fillProfile.ts';
import { LLMService } from '../services/llm/llmService.ts';
import { listAvailableLLMModels } from '../services/llm/modelCatalog.ts';
import {
  buildAnswerGenerationPrompt,
  buildResumeParsingPrompt,
  buildFieldMatchingPrompt,
  buildSectionFillPrompt,
} from '../services/llm/prompts.ts';
import type { AIFillSectionPayload } from '../services/llm/prompts.ts';
import {
  parseSectionFillResponse,
  SECTION_FILL_RESPONSE_SCHEMA,
  validateSectionFillMappings,
} from '../services/llm/sectionFill.ts';
import type { LLMConfig } from '../services/llm/types.ts';
import {
  handleCreateApplicationRecord,
  handleCreateApplicationRecordDraft,
  handleDeleteApplicationRecord,
  handleExportApplicationRecordsCsv,
  handleGetApplicationRecordDraft,
  handleGetApplicationRecords,
  handleImportApplicationRecordsCsv,
  handleRemoveApplicationEvent,
  handleRestoreApplicationEventSource,
  handleUpdateApplicationRecord,
} from './applicationRecords.ts';
import {
  handleCacheApplicationPageMetadata,
  handleGetPendingSubmissions,
  handleIgnorePendingSubmissions,
  handlePendingSubmissionDecision,
  handleSubmissionAttemptStarted,
  handleUpsertPendingSubmission,
} from './submissionTracking.ts';
import {
  handleConnectMailAccount,
  handleConfirmMailReview,
  handleDeleteMailAccount,
  handleDisconnectMailAccount,
  handleGetMailAccounts,
  handleGetPendingMailReviews,
  handleIgnoreMailReview,
  handleSyncMail,
  handleTestMailAccount,
  handleUpsertMailAccount,
} from './mailMonitor.ts';
import {
  ensureMailScanAlarm,
  handleMailAlarm,
} from './mailScheduler.ts';
import {
  ensureLocalDesktopSyncAlarm,
  findDeletedRecordIds,
  isApplicationRecordsStorageChange,
  LOCAL_DESKTOP_SYNC_ALARM_NAME,
  LocalDesktopSyncService,
} from '../services/localDesktopSync.ts';
import {
  createResumeProfileHandler,
  deleteResumeProfileHandler,
  duplicateResumeProfileHandler,
  getResumeProfilesHandler,
  toResumeProfileSummary,
  renameResumeProfileHandler,
  serializeResumeProfileMutation,
  switchResumeProfileHandler,
} from './resumeProfiles.ts';
import {
  captureVisibleRegion,
  handleVisualRegionFill,
} from './visualRegionFill.ts';

// Background Service Worker 入口
console.log('Background service worker started');

const aiFillControllers = new Map<string, AbortController>();
const localDesktopSync = new LocalDesktopSyncService();

async function queueAutoSync(reason: string): Promise<'disabled' | 'queued'> {
  const config = await StorageService.getWebDAVConfig();
  if (!config?.enabled) return 'disabled';
  enqueueSync(reason);
  return 'queued';
}

async function queueAutoSyncResult(reason: string): Promise<
  { sync: 'disabled' | 'queued' } | { sync: 'error'; syncError: string }
> {
  try {
    return { sync: await queueAutoSync(reason) };
  } catch (error) {
    return {
      sync: 'error',
      syncError: error instanceof Error ? error.message : '自动同步排队失败',
    };
  }
}

function activeUserProfile(library: Awaited<ReturnType<typeof StorageService.getResumeProfileLibrary>>): UserProfile {
  const active = library.profiles.find(item => item.id === library.activeProfileId);
  if (!active) throw new Error('当前简历不存在');
  return active.profile;
}

// 监听消息
chrome.runtime.onMessage.addListener(
  (
    message: Message,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageResponse) => void
  ) => {
    // 处理异步消息
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error('Message handler error:', error);
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      });

    // 返回 true 表示异步响应
    return true;
  }
);

const runtimeChrome = typeof chrome !== 'undefined' ? chrome : undefined;
const hasNativeMessaging = typeof runtimeChrome?.runtime?.sendNativeMessage === 'function';
const alarmsApi = (runtimeChrome as (typeof chrome & { alarms?: typeof chrome.alarms }) | undefined)?.alarms;
if (alarmsApi?.onAlarm) {
  alarmsApi.onAlarm.addListener(alarm => {
    void handleMailAlarm(alarm);
    if (hasNativeMessaging && alarm.name === LOCAL_DESKTOP_SYNC_ALARM_NAME) void localDesktopSync.requestSync();
  });
}

const storageLocal = (runtimeChrome?.storage as (typeof chrome.storage & {
  local?: typeof chrome.storage.local;
}) | undefined)?.local;
if (typeof storageLocal?.setAccessLevel === 'function') {
  void storageLocal.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch((error) => {
    console.warn('[Storage] 无法限制 content script 直接访问：', error);
  });
}

if (alarmsApi) {
  void ensureMailScanAlarm(alarmsApi).catch(error => {
    console.warn('[MailMonitor] 无法初始化定时扫描：', error);
  });
  if (hasNativeMessaging) {
    void ensureLocalDesktopSyncAlarm(alarmsApi).catch(error => {
      console.warn('[LocalDesktopSync] 无法初始化定时同步：', error);
    });
  }
}

const storageChangesApi = (runtimeChrome?.storage as (typeof chrome.storage & {
  onChanged?: typeof chrome.storage.onChanged;
}) | undefined)?.onChanged;
if (hasNativeMessaging && storageChangesApi?.addListener) {
  storageChangesApi.addListener((changes, areaName) => {
    if (!isApplicationRecordsStorageChange(changes, areaName)) return;
    const change = changes[STORAGE_KEYS.APPLICATION_RECORDS];
    if (!change) return;
    void localDesktopSync.requestSync(findDeletedRecordIds(change.oldValue, change.newValue));
  });
}

if (hasNativeMessaging) void localDesktopSync.requestSync();

// 处理消息
export async function handleMessage(
  message: Message,
  sender: chrome.runtime.MessageSender
): Promise<MessageResponse> {
  if (PRIVILEGED_EXTENSION_MESSAGES.has(message.type) && !isTrustedExtensionPageSender(sender)) {
    return { success: false, error: '当前页面无权访问敏感扩展配置' };
  }
  switch (message.type) {
    case 'GET_USER_PROFILE':
      return await handleGetUserProfile();

    case 'GET_ACTIVE_RESUME_CONTEXT': {
      const library = await StorageService.getResumeProfileLibrary();
      const active = library.profiles.find(item => item.id === library.activeProfileId);
      if (!active) return { success: false, error: '当前简历不存在' };
      return { success: true, data: { ...toResumeProfileSummary(library), profile: active.profile, revision: active.updatedAt } };
    }

    case 'SAVE_USER_PROFILE':
      return await handleSaveUserProfile('profile' in message.payload ? message.payload.profile : message.payload, 'profile' in message.payload ? message.payload.expectedProfileId : undefined);

    case 'GET_RESUME_PROFILES':
      return await getResumeProfilesHandler();

    case 'SWITCH_RESUME_PROFILE':
      return await switchResumeProfileHandler(message.payload, { now: () => new Date().toISOString(), queueAutoSync });

    case 'CREATE_RESUME_PROFILE':
      return await createResumeProfileHandler(message.payload, { now: () => new Date().toISOString(), queueAutoSync });

    case 'DUPLICATE_RESUME_PROFILE':
      return await duplicateResumeProfileHandler(message.payload, { now: () => new Date().toISOString(), queueAutoSync });

    case 'RENAME_RESUME_PROFILE':
      return await renameResumeProfileHandler(message.payload, { now: () => new Date().toISOString(), queueAutoSync });

    case 'DELETE_RESUME_PROFILE':
      return await deleteResumeProfileHandler(message.payload, { now: () => new Date().toISOString(), queueAutoSync });

    case 'PARSE_RESUME':
      return await handleParseResume(
        message.payload.file,
        message.payload.fileType,
        message.payload.fileName,
        message.payload.rawText
      );

    case 'CREATE_APPLICATION_RECORD_DRAFT':
      return await handleCreateApplicationRecordDraft(message.payload.tabId);

    case 'GET_APPLICATION_RECORD_DRAFT':
      return await handleGetApplicationRecordDraft(message.payload.draftId);

    case 'CACHE_APPLICATION_PAGE_METADATA':
      return await handleCacheApplicationPageMetadata(message.payload, sender);

    case 'SUBMISSION_ATTEMPT_STARTED':
      return await handleSubmissionAttemptStarted(message.payload, sender);

    case 'UPSERT_PENDING_SUBMISSION':
      return await handleUpsertPendingSubmission(message.payload, sender);

    case 'GET_PENDING_SUBMISSIONS':
      return await handleGetPendingSubmissions();

    case 'CONFIRM_PENDING_SUBMISSION':
      return await handlePendingSubmissionDecision(
        message.payload.pendingId,
        'confirmed',
        message.payload.metadata,
      );

    case 'IGNORE_PENDING_SUBMISSION':
      return await handlePendingSubmissionDecision(message.payload.pendingId, 'ignored', undefined);

    case 'IGNORE_PENDING_SUBMISSIONS':
      return await handleIgnorePendingSubmissions(message.payload.pendingIds);

    case 'GET_APPLICATION_RECORDS':
      await localDesktopSync.requestSync();
      return await handleGetApplicationRecords();

    case 'CREATE_APPLICATION_RECORD':
      return await handleApplicationRecordMutation(
        () => handleCreateApplicationRecord(message.payload),
        'application-record-create',
      );

    case 'UPDATE_APPLICATION_RECORD':
      return await handleApplicationRecordMutation(
        () => handleUpdateApplicationRecord(message.payload),
        'application-record-update',
      );

    case 'DELETE_APPLICATION_RECORD':
      return await handleApplicationRecordMutation(
        () => handleDeleteApplicationRecord(message.payload.id),
        'application-record-delete',
      );

    case 'REMOVE_APPLICATION_EVENT':
      return await handleApplicationRecordMutation(
        () => handleRemoveApplicationEvent(
          message.payload.recordId,
          message.payload.sourceKey,
          message.payload.reason,
        ),
        'application-event-remove',
      );

    case 'RESTORE_APPLICATION_EVENT_SOURCE':
      return await handleRestoreApplicationEventSource(
        message.payload.recordId,
        message.payload.sourceKey,
      );

    case 'EXPORT_APPLICATION_RECORDS_CSV':
      return await handleExportApplicationRecordsCsv();

    case 'IMPORT_APPLICATION_RECORDS_CSV':
      return await handleApplicationRecordMutation(
        () => handleImportApplicationRecordsCsv(message.payload.csv),
        'application-record-import',
      );

    case 'GET_RESUME_DATA':
      return await handleGetResumeData();

    case 'GENERATE_ANSWER':
      return await handleGenerateAnswer(message.payload);

    case 'MATCH_FIELDS_LLM':
      return await handleMatchFieldsLLM(message.payload);

    case 'AI_FILL_SECTION':
      return await handleAIFillSection(message.payload);

    case 'AI_FILL_VISUAL_REGION':
      return await handleVisualRegionFillRequest(message.payload, sender);

    case 'CANCEL_AI_FILL':
      return handleCancelAIFill(message.payload.requestId);

    case 'WRITE_FOCUSED_FIELD':
      return await handleWriteFocusedField(message.payload.tabId, message.payload.value);

    case 'GET_LLM_CONFIG':
      return await handleGetLLMConfig();

    case 'SAVE_LLM_CONFIG':
      return await handleSaveLLMConfig(message.payload);

    case 'LIST_LLM_MODELS':
      return await handleListLLMModels(message.payload);

    case 'TEST_LLM_CONNECTION':
      return await handleTestConnection(message.payload);

    case 'GET_MAIL_ACCOUNTS':
      return await handleGetMailAccounts();

    case 'UPSERT_MAIL_ACCOUNT':
      return await handleUpsertMailAccount(message.payload);

    case 'DELETE_MAIL_ACCOUNT':
      return await handleDeleteMailAccount(message.payload.accountId);

    case 'CONNECT_MAIL_ACCOUNT':
      return await handleConnectMailAccount(message.payload.accountId, message.payload.credential);

    case 'DISCONNECT_MAIL_ACCOUNT':
      return await handleDisconnectMailAccount(message.payload.accountId);

    case 'TEST_MAIL_ACCOUNT':
      return await handleTestMailAccount(message.payload.accountId);

    case 'SYNC_MAIL':
      return await handleSyncMail(message.payload?.accountId);

    case 'GET_PENDING_MAIL_REVIEWS':
      return await handleGetPendingMailReviews();

    case 'CONFIRM_MAIL_REVIEW':
      return await handleConfirmMailReview(message.payload.reviewId, message.payload.recordId);

    case 'IGNORE_MAIL_REVIEW':
      return await handleIgnoreMailReview(message.payload.reviewId);

    case 'EXPORT_BACKUP':
      return await handleExportBackup();

    case 'PREVIEW_BACKUP_IMPORT':
      return handlePreviewBackup(message.payload.json);

    case 'IMPORT_BACKUP':
      return await handleImportBackup(message.payload.json);

    case 'GET_WEBDAV_CONFIG':
      return { success: true, data: await StorageService.getWebDAVConfig() };

    case 'SAVE_WEBDAV_CONFIG':
      return await handleSaveWebDAVConfig(message.payload);

    case 'TEST_WEBDAV':
      return await handleTestWebDAV(message.payload);

    case 'GET_SYNC_STATUS':
      return { success: true, data: await StorageService.getSyncMetadata() };

    case 'GET_LOCAL_DESKTOP_SYNC_STATUS':
      return { success: true, data: await localDesktopSync.getStatus() };

    case 'SYNC_LOCAL_DESKTOP_NOW':
      return { success: true, data: await localDesktopSync.requestSync() };

    case 'SYNC_NOW':
      return { success: true, data: { status: await enqueueSyncAndWait('manual') } };

    case 'FORCE_UPLOAD_LOCAL':
      return { success: true, data: { status: await forceUploadLocal() } };

    case 'FORCE_DOWNLOAD_REMOTE':
      return { success: true, data: { status: await forceDownloadRemote() } };

    case 'RESOLVE_SYNC_CONFLICT':
      return {
        success: true,
        data: { status: await resolveConflict(message.payload.choice) },
      };

    default:
      return {
        success: false,
        error: 'Unknown message type'
      };
  }
}

const PRIVILEGED_EXTENSION_MESSAGES = new Set<Message['type']>([
  'GET_LLM_CONFIG',
  'SAVE_LLM_CONFIG',
  'LIST_LLM_MODELS',
  'TEST_LLM_CONNECTION',
  'GET_MAIL_ACCOUNTS',
  'UPSERT_MAIL_ACCOUNT',
  'DELETE_MAIL_ACCOUNT',
  'CONNECT_MAIL_ACCOUNT',
  'DISCONNECT_MAIL_ACCOUNT',
  'TEST_MAIL_ACCOUNT',
  'SYNC_MAIL',
  'GET_PENDING_MAIL_REVIEWS',
  'CONFIRM_MAIL_REVIEW',
  'IGNORE_MAIL_REVIEW',
  'EXPORT_BACKUP',
  'PREVIEW_BACKUP_IMPORT',
  'IMPORT_BACKUP',
  'GET_WEBDAV_CONFIG',
  'SAVE_WEBDAV_CONFIG',
  'TEST_WEBDAV',
  'GET_LOCAL_DESKTOP_SYNC_STATUS',
  'SYNC_LOCAL_DESKTOP_NOW',
]);

export function isTrustedExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  // Direct unit tests call handleMessage without a browser-created sender.
  if (!sender.url && !sender.id && !sender.tab) return true;
  if (!sender.url || sender.id !== chrome.runtime.id) return false;
  return sender.url.startsWith(chrome.runtime.getURL(''));
}

async function handleApplicationRecordMutation(
  operation: () => Promise<MessageResponse>,
  reason: string,
): Promise<MessageResponse> {
  const response = await operation();
  if (response.success) {
    await queueAutoSync(reason);
  }
  return response;
}

async function handleWriteFocusedField(
  tabId: number,
  value: string
): Promise<MessageResponse<FocusedFieldWriteResult>> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.id) {
      return { success: true, data: { written: false, reason: 'NO_ACTIVE_TAB' } };
    }

    const url = tab.url || '';
    if (isRestrictedPage(url)) {
      return { success: true, data: { written: false, reason: 'RESTRICTED_PAGE' } };
    }

    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'APPLY_FOCUSED_FIELD',
      payload: { value },
    } satisfies Message) as MessageResponse<FocusedFieldWriteResult>;

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /Receiving end does not exist|Could not establish connection/i.test(message)
      ? 'NO_CONTENT_SCRIPT'
      : 'NO_ACTIVE_TAB';
    return { success: true, data: { written: false, reason } };
  }
}

async function handleVisualRegionFillRequest(
  payload: VisualRegionFillPayload | VisualRegionFillRequestPayload,
  sender: chrome.runtime.MessageSender,
): Promise<MessageResponse> {
  const requestId = payload.requestId?.trim();
  let controller: AbortController | undefined;
  if (requestId) {
    controller = new AbortController();
    aiFillControllers.set(requestId, controller);
  }

  try {
    if (isVisualRegionFillPayload(payload)) {
      return await handleVisualRegionFill(payload, undefined, controller?.signal);
    }

    const windowId = sender.tab?.windowId;
    if (typeof windowId !== 'number') {
      return { success: false, error: '无法获取当前页面截图' };
    }

    const image = await captureVisibleRegion(windowId, payload.region);
    if (controller?.signal.aborted) {
      return { success: false, error: 'AI 补填已终止' };
    }

    const strictPayload: VisualRegionFillPayload = { ...payload, image };
    return await handleVisualRegionFill(strictPayload, undefined, controller?.signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { success: false, error: 'AI 补填已终止' };
    }
    throw error;
  } finally {
    if (requestId) {
      aiFillControllers.delete(requestId);
    }
  }
}

function isVisualRegionFillPayload(
  payload: VisualRegionFillPayload | VisualRegionFillRequestPayload,
): payload is VisualRegionFillPayload {
  return 'image' in payload && Boolean(payload.image?.base64 && payload.image?.mimeType);
}

function isRestrictedPage(url: string): boolean {
  return (
    /^(chrome|edge|about|chrome-extension|edge-extension):\/\//i.test(url) ||
    /^https:\/\/chromewebstore\.google\.com\//i.test(url) ||
    /^https:\/\/microsoftedge\.microsoft\.com\/addons\//i.test(url)
  );
}

async function handleAIFillSection(
  payload: AIFillSectionPayload
): Promise<MessageResponse<Record<string, string>>> {
  const controller = new AbortController();
  aiFillControllers.set(payload.requestId, controller);

  try {
    const config = await StorageService.getLLMConfig();
    if (!config?.apiKey) {
      return { success: false, error: '请先在设置中配置 AI 服务' };
    }

    const storedProfile = await StorageService.getUserProfile();
    if (!storedProfile) {
      return { success: false, error: '请先保存个人资料' };
    }
    const profile = buildAuthoritativeFillProfile(storedProfile);

    const llm = new LLMService(config);
    const { system, user } = buildSectionFillPrompt(payload, profile);
    const result = await llm.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], controller.signal, {
      reasoningEffort: 'low',
      jsonSchema: {
        name: 'job_application_field_mappings',
        schema: SECTION_FILL_RESPONSE_SCHEMA,
      },
    });

    const candidates = parseSectionFillResponse(result.content, payload);
    const mappings = validateSectionFillMappings(candidates, payload, profile);

    return { success: true, data: mappings };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { success: false, error: 'AI 补填已终止' };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'AI 补填失败',
    };
  } finally {
    aiFillControllers.delete(payload.requestId);
  }
}

function handleCancelAIFill(requestId: string): MessageResponse {
  const controller = aiFillControllers.get(requestId);
  if (!controller) {
    return { success: true, data: { cancelled: false } };
  }

  controller.abort();
  aiFillControllers.delete(requestId);
  return { success: true, data: { cancelled: true } };
}

// 获取用户资料
async function handleGetUserProfile(): Promise<MessageResponse<UserProfile>> {
  try {
    const library = await StorageService.getResumeProfileLibrary();
    const profile = activeUserProfile(library);
    return {
      success: true,
      data: profile
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get user profile'
    };
  }
}

// 保存用户资料
async function handleSaveUserProfile(
  profile: UserProfile,
  expectedProfileId?: string,
): Promise<MessageResponse> {
  try {
    await serializeResumeProfileMutation(async () => {
      const library = await StorageService.getResumeProfileLibrary();
      activeUserProfile(library);
      if (expectedProfileId && library.activeProfileId !== expectedProfileId) throw new Error('当前简历已切换，已拒绝保存陈旧草稿');
      const next = updateActiveUserProfile(library, profile, new Date().toISOString());
      await StorageService.saveResumeProfileLibrary(next);
    });
    const syncResult = await queueAutoSyncResult('profile-save');
    return {
      success: true,
      data: { localSaved: true, ...syncResult }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save user profile'
    };
  }
}

/** 去掉空字符串/空白值，避免解析结果把已填字段清空 */
function dropEmptyValues<T extends object>(source: T | undefined): Partial<T> {
  if (!source) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && !value.trim()) continue;
    if (value === null || value === undefined) continue;
    result[key] = value;
  }
  return result as Partial<T>;
}

/**
 * 解析结果为空数组时保留原有内容。
 * 直接用 `parsed || current` 不行：空数组是真值，会把已有记录清空。
 */
function pickNonEmpty<T>(parsed: T[] | undefined, current: T[] | undefined): T[] {
  if (parsed && parsed.length > 0) return parsed;
  return current || [];
}

// 解析简历
async function handleParseResume(
  fileData: string,
  fileType: string,
  fileName: string,
  preParsedText?: string
): Promise<MessageResponse> {
  try {
    const rawText = preParsedText ?? await parseResume(fileData, fileType);

    let parsedData: ParsedResumeData;
    let parseMethod: 'structured' | 'llm' | 'regex' = 'regex';
    let llmError: string | undefined;

    if (isStructuredType(fileType)) {
      // JSON 简历本身已结构化，直接映射，避免 LLM 二次推断带来的误差
      parsedData = parseStructuredResume(rawText);
      parseMethod = 'structured';
    } else {
      const llmConfig = await StorageService.getLLMConfig();
      if (llmConfig?.apiKey) {
        try {
          parsedData = await parseResumeWithLLM(rawText, llmConfig);
          parseMethod = 'llm';
        } catch (error) {
          // 静默回退会让用户以为 AI 生效了，这里记下原因并回报给界面
          llmError = error instanceof Error ? error.message : String(error);
          console.warn('LLM resume parsing failed, falling back to regex:', error);
          parsedData = NLPHelper.parseResumeText(rawText);
        }
      } else {
        parsedData = NLPHelper.parseResumeText(rawText);
      }
    }

    await serializeResumeProfileMutation(async () => {
      const library = await StorageService.getResumeProfileLibrary();
      const currentProfile = activeUserProfile(library);
      const updatedProfile: UserProfile = {
        // 解析结果里的空值不能覆盖用户已填的内容
        personal: {
          ...currentProfile.personal,
          ...dropEmptyValues(parsedData.personal)
        } as any,
        education: pickNonEmpty(parsedData.education, currentProfile.education) as any,
        languages: pickNonEmpty(parsedData.languages, currentProfile.languages) as any,
        experience: pickNonEmpty(parsedData.experience, currentProfile.experience) as any,
        projects: pickNonEmpty(parsedData.projects, currentProfile.projects) as any,
        awards: pickNonEmpty(parsedData.awards, currentProfile.awards) as any,
        customInformation: currentProfile.customInformation || [],
        skills: pickNonEmpty(parsedData.skills, currentProfile.skills),
        certifications: currentProfile.certifications || [],
        resume: {
          fileName,
          fileData,
          fileType,
          parsedText: rawText,
          uploadDate: new Date().toISOString()
        }
      };

      const next = updateActiveUserProfile(library, updatedProfile, new Date().toISOString());
      await StorageService.saveResumeProfileLibrary(next);
    });
    const syncResult = await queueAutoSyncResult('resume-save');

    return {
      success: true,
      data: {
        parsedData,
        rawText,
        parseMethod,
        llmError,
        ...syncResult
      }
    };
  } catch (error) {
    console.error('Resume parsing error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to parse resume'
    };
  }
}

// 获取简历数据
async function handleGetResumeData(): Promise<MessageResponse> {
  try {
    const profile = await StorageService.getUserProfile();
    return {
      success: true,
      data: profile?.resume || null
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get resume data'
    };
  }
}

// LLM 简历解析
async function parseResumeWithLLM(
  rawText: string,
  config: LLMConfig
): Promise<ParsedResumeData> {
  const llm = new LLMService(config);
  const { system, user } = buildResumeParsingPrompt(rawText);

  const result = await llm.chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);

  let jsonStr = result.content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(jsonStr);

  return {
    personal: parsed.personal,
    education: (parsed.education || []).map((e: any, i: number) => ({
      id: `edu-${i}`, ...e
    })),
    languages: (parsed.languages || []).map((entry: any, i: number) => ({
      id: `language-${i}`,
      language: entry.language || '',
      certificate: entry.certificate || '',
      level: entry.level || '',
    })).filter((entry: any) => entry.language || entry.certificate || entry.level),
    experience: (parsed.experience || []).map((entry: any, i: number) => ({
      id: `exp-${i}`,
      company: entry.company || '',
      position: entry.position || '',
      startDate: entry.startDate || '',
      endDate: entry.endDate || '',
      description: normalizeDescriptionText(entry.description || ''),
    })),
    projects: (parsed.projects || []).map((entry: any, i: number) => ({
      id: `proj-${i}`,
      name: entry.name || '',
      role: entry.role || '',
      startDate: entry.startDate || '',
      endDate: entry.endDate || '',
      description: normalizeDescriptionText(entry.description || ''),
    })),
    awards: (parsed.awards || [])
      .filter((award: any) => award.name)
      .map((award: any, i: number) => ({
        id: `award-${i}`,
        name: award.name,
        role: award.role || '',
        date: award.date || '',
        description: normalizeDescriptionText(award.description || ''),
      })),
    skills: parsed.skills || [],
    rawText,
  };
}

// AI 生成开放性问题回答
async function handleGenerateAnswer(
  payload: { questionText: string; context?: string; fieldMaxLength?: number; language?: 'zh' | 'en' }
): Promise<MessageResponse> {
  try {
    const config = await StorageService.getLLMConfig();
    if (!config?.apiKey) {
      return { success: false, error: '请先在设置中配置AI服务' };
    }

    const profile = await StorageService.getUserProfile();
    if (!profile) {
      return { success: false, error: '请先填写个人信息' };
    }

    const llm = new LLMService(config);
    const { system, user } = buildAnswerGenerationPrompt(payload, profile);

    const result = await llm.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);

    return { success: true, data: { answer: result.content } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'AI生成失败',
    };
  }
}

// LLM 语义字段匹配
async function handleMatchFieldsLLM(
  payload: { fields: Array<{ index: number; name: string; id: string; placeholder: string; labelText: string; type: string }>; domain: string }
): Promise<MessageResponse> {
  try {
    const cacheKey = `fieldMatch_${payload.domain}`;
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey]) {
      const cachedResult = cached[cacheKey] as Record<string, string>;
      const allCovered = payload.fields.every(f => f.index.toString() in cachedResult);
      if (allCovered) {
        return { success: true, data: cachedResult };
      }
    }

    const config = await StorageService.getLLMConfig();
    if (!config?.apiKey) {
      return { success: false, error: 'LLM not configured' };
    }

    const llm = new LLMService(config);
    const { system, user } = buildFieldMatchingPrompt(payload.fields);

    const result = await llm.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);

    let jsonStr = result.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const mappings: Record<string, string> = JSON.parse(jsonStr);

    await chrome.storage.local.set({ [cacheKey]: mappings });

    return { success: true, data: mappings };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '字段匹配失败',
    };
  }
}

// 获取 LLM 配置
async function handleGetLLMConfig(): Promise<MessageResponse> {
  try {
    const config = await StorageService.getLLMConfig();
    return { success: true, data: config };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get LLM config',
    };
  }
}

// 保存 LLM 配置
async function handleSaveLLMConfig(config: LLMConfig): Promise<MessageResponse> {
  try {
    const success = await StorageService.saveLLMConfig(config);
    const sync = success ? await queueAutoSync('llm-save') : 'disabled';
    return {
      success,
      data: success ? { localSaved: true, sync } : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save LLM config',
    };
  }
}

function backupFilename(date = new Date()): string {
  const compact = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `job-application-helper-backup-${compact}.json`;
}

async function handleExportBackup(): Promise<MessageResponse> {
  const [data, webdavConfig] = await Promise.all([
    StorageService.getBackupData(),
    StorageService.getWebDAVConfig(),
  ]);
  const document = createBackupDocument(
    data,
    chrome.runtime.getManifest().version,
    undefined,
    webdavConfig,
  );
  return {
    success: true,
    data: {
      json: serializeBackup(document),
      filename: backupFilename(),
    },
  };
}

function handlePreviewBackup(json: string): MessageResponse {
  const parsed = parseAndValidateBackup(json);
  if (!parsed.success) {
    return { success: false, error: `${parsed.error.code}: ${parsed.error.message}` };
  }
  return { success: true, data: createBackupSummary(parsed.document) };
}

async function handleImportBackup(json: string): Promise<MessageResponse> {
  const parsed = parseAndValidateBackup(json);
  if (!parsed.success) {
    return { success: false, error: `${parsed.error.code}: ${parsed.error.message}` };
  }
  // V3 不再把凭据序列化；旧 V1/V2 的凭据只在显式导入时进入本地恢复流程。
  await StorageService.replaceBusinessData(parsed.document.data, parsed.document.legacySecrets?.webdavConfig);
  if (parsed.document.legacySecrets?.llmApiKey && parsed.document.data.llmConfig) {
    await StorageService.saveLLMConfig({
      ...parsed.document.data.llmConfig,
      apiKey: parsed.document.legacySecrets.llmApiKey,
    });
  }
  const sync = await queueAutoSync('backup-import');
  return {
    success: true,
    data: { imported: true, summary: createBackupSummary(parsed.document), sync },
  };
}

async function handleSaveWebDAVConfig(config: WebDAVConfig): Promise<MessageResponse> {
  const urlError = config.serverUrl.trim() ? validateWebDAVUrl(config.serverUrl) : null;
  if (config.enabled && !config.serverUrl.trim()) {
    return { success: false, error: '启用同步前请填写 WebDAV 服务器地址' };
  }
  if (urlError) return { success: false, error: urlError };
  await StorageService.saveWebDAVConfig({
    ...config,
    serverUrl: config.serverUrl.trim()
      ? normalizeWebDAVServerUrl(config.serverUrl)
      : '',
    username: config.username.trim(),
  });
  return { success: true };
}

async function handleTestWebDAV(config: WebDAVConfig): Promise<MessageResponse> {
  try {
    const result = await testWebDAVConnection(config);
    return {
      success: true,
      data: {
        exists: result.exists,
        message: result.exists ? '连接成功，已找到远端文件' : '连接成功，远端文件尚未创建',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'WebDAV 连接测试失败',
    };
  }
}

// 测试 LLM 连接
// payload 为界面上当前填写的配置；缺省时回退到已保存的配置
async function handleTestConnection(payload?: LLMConfig | null): Promise<MessageResponse> {
  try {
    const config = payload ?? await StorageService.getLLMConfig();
    if (!config?.apiKey?.trim()) {
      return { success: false, error: '请先填写 API Key' };
    }
    if (!config.baseUrl?.trim()) {
      return { success: false, error: '请先填写 API 地址' };
    }
    if (!config.model?.trim()) {
      return { success: false, error: '请先填写模型名称' };
    }

    const llm = new LLMService(config);
    await llm.testConnection();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '连接测试失败',
    };
  }
}

// 读取当前 Key 可见的模型目录；失败时只返回错误，不改动已保存配置。
async function handleListLLMModels(config: LLMConfig): Promise<MessageResponse> {
  try {
    if (!config.apiKey?.trim()) {
      return { success: false, error: '请先填写 API Key' };
    }
    if (!config.baseUrl?.trim()) {
      return { success: false, error: '请先填写 API 地址' };
    }

    const models = await listAvailableLLMModels(config);
    return { success: true, data: { models } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '读取模型列表失败',
    };
  }
}

// 监听安装事件
chrome.runtime.onInstalled.addListener((details) => {
  console.log('Extension installed:', details.reason);

  if (details.reason === 'install') {
    // 首次安装时打开选项页面
    chrome.runtime.openOptionsPage();
  }
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    if (alarmsApi) void ensureMailScanAlarm(alarmsApi);
    if (hasNativeMessaging && alarmsApi) void ensureLocalDesktopSyncAlarm(alarmsApi);
    if (hasNativeMessaging) void localDesktopSync.requestSync();
  });
}
