import type {
  ApplicationRecord,
  BackupData,
  BackupDocument,
  BackupDocumentV3,
  BackupErrorCode,
  BackupParseResult,
  BackupSummary,
  ResumeProfileLibrary,
  UserProfile,
  WebDAVConfig,
} from './types';
import type { LLMConfig } from '../services/llm/types';
import { normalizeUserProfile } from './storage.ts';
import { normalizeResumeProfileLibrary } from './resumeProfiles.ts';

export const BACKUP_SCHEMA_VERSION = 3;
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function failure(code: BackupErrorCode, message: string): BackupParseResult {
  return { success: false, error: { code, message } };
}

function hasOnlyStringFields(value: PlainObject, fields: string[]): boolean {
  return fields.every(field => value[field] === undefined || typeof value[field] === 'string');
}

function validateObjectArray(
  value: unknown,
  fields: string[],
): value is PlainObject[] {
  return Array.isArray(value) && value.every(item =>
    isPlainObject(item) && hasOnlyStringFields(item, fields)
  );
}

function validateOptionalObjectArray(value: unknown, fields: string[]): boolean {
  return value === undefined || validateObjectArray(value, fields);
}

function validateUserProfileInput(value: unknown): boolean {
  if (!isPlainObject(value) || !isPlainObject(value.personal)) return false;
  if (!hasOnlyStringFields(value.personal, [
    'name', 'gender', 'birthDate', 'phone', 'phoneCountryCode', 'email', 'wechat', 'idType', 'idCard', 'nationality',
    'politicalStatus', 'ethnicity', 'hometown', 'currentAddress', 'selfEvaluation',
  ])) return false;

  if (!validateOptionalObjectArray(value.education, [
    'id', 'school', 'countryRegion', 'schoolLocation', 'college', 'educationType', 'major', 'degree',
    'startDate', 'endDate', 'gpa', 'ranking',
  ])) return false;
  if (!validateOptionalObjectArray(value.languages, ['id', 'language', 'certificate', 'level'])) return false;
  if (!validateOptionalObjectArray(value.experience, [
    'id', 'company', 'position', 'startDate', 'endDate', 'description', 'achievements',
  ])) return false;
  if (!validateOptionalObjectArray(value.projects, [
    'id', 'name', 'role', 'startDate', 'endDate', 'description', 'achievements', 'technologies',
  ])) return false;
  if (!validateOptionalObjectArray(value.awards, ['id', 'name', 'role', 'date', 'description'])) return false;
  if (!validateOptionalObjectArray(value.customInformation, ['id', 'name', 'content'])) return false;
  if (!validateOptionalObjectArray(value.certifications, ['id', 'name', 'issuer', 'date', 'credentialId'])) {
    return false;
  }
  if (
    value.skills !== undefined &&
    (!Array.isArray(value.skills) || !value.skills.every(item => typeof item === 'string'))
  ) return false;

  if (value.resume !== undefined) {
    if (!isPlainObject(value.resume)) return false;
    if (!hasOnlyStringFields(value.resume, [
      'fileName', 'fileData', 'fileType', 'parsedText', 'uploadDate',
    ])) return false;
    for (const field of ['fileName', 'fileData', 'fileType', 'uploadDate']) {
      if (typeof value.resume[field] !== 'string') return false;
    }
  }
  return true;
}

function validateWebDAVConfig(value: unknown): value is WebDAVConfig {
  if (!isPlainObject(value)) return false;
  if (typeof value.enabled !== 'boolean') return false;
  if (!hasOnlyStringFields(value, ['serverUrl', 'username', 'password'])) return false;
  return ['serverUrl', 'username', 'password'].every(field => typeof value[field] === 'string');
}

function validateLLMConfig(value: unknown): value is LLMConfig {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyStringFields(value, ['provider', 'apiKey', 'baseUrl', 'model'])) return false;
  if (!['provider', 'apiKey', 'baseUrl', 'model'].every(field => typeof value[field] === 'string')) {
    return false;
  }
  if (value.temperature !== undefined && typeof value.temperature !== 'number') return false;
  if (value.maxTokens !== undefined && typeof value.maxTokens !== 'number') return false;
  if (value.visionEnabled !== undefined && typeof value.visionEnabled !== 'boolean') return false;
  if (
    value.models !== undefined
    && (!Array.isArray(value.models) || !value.models.every(model => typeof model === 'string'))
  ) return false;
  if (
    value.apiMode !== undefined
    && value.apiMode !== 'responses'
    && value.apiMode !== 'chat-completions'
  ) return false;
  return true;
}

function validateApplicationRecords(value: unknown): boolean {
  return value === undefined || value === null || validateOptionalObjectArray(value, [
    'id',
    'companyName',
    'jobTitle',
    'sourceSite',
    'sourceUrl',
    'status',
    'notes',
    'appliedAt',
    'location',
    'createdAt',
    'updatedAt',
  ]);
}

function validateEnvelope(value: PlainObject): BackupParseResult | null {
  if (typeof value.exportedAt !== 'string' || Number.isNaN(Date.parse(value.exportedAt))) {
    return failure('INVALID_EXPORTED_AT', '导出时间无效');
  }
  if (!isPlainObject(value.source) || typeof value.source.extensionVersion !== 'string') {
    return failure('INVALID_SOURCE', '备份来源信息无效');
  }
  if (!isPlainObject(value.data)) return failure('INVALID_DATA', '备份数据区域无效');
  return null;
}

function validateSharedData(data: PlainObject): BackupParseResult | null {
  const { llmConfig, settings, applicationRecords } = data;
  if (llmConfig !== null && !validateLLMConfig(llmConfig)) {
    return failure('INVALID_LLM_CONFIG', 'AI 配置结构无效');
  }
  if (settings !== null && !isPlainObject(settings)) {
    return failure('INVALID_SETTINGS', '设置数据结构无效');
  }
  if (!validateApplicationRecords(applicationRecords)) {
    return failure('INVALID_DATA', '投递记录结构无效');
  }
  return null;
}

function optionalWebDAV(value: PlainObject): BackupParseResult | null {
  if (value.webdavConfig !== undefined && value.webdavConfig !== null && !validateWebDAVConfig(value.webdavConfig)) {
    return failure('INVALID_WEBDAV_CONFIG', 'WebDAV 同步设置结构无效');
  }
  return null;
}

function copyApplicationRecords(value: PlainObject, document: BackupDocumentV3): void {
  const data = value.data as PlainObject;
  if (data.applicationRecords !== undefined) {
    document.data.applicationRecords = (data.applicationRecords as ApplicationRecord[] | null) ?? null;
  }
}

function publicLLMConfig(value: LLMConfig | null): LLMConfig | null {
  return value ? { ...value, apiKey: '' } : null;
}

function legacySecrets(value: PlainObject): BackupDocumentV3['legacySecrets'] | undefined {
  const data = value.data as PlainObject;
  const llmConfig = data.llmConfig as LLMConfig | null;
  const webdavConfig = (value.webdavConfig as WebDAVConfig | null | undefined);
  const llmApiKey = llmConfig?.apiKey?.trim();
  if (!llmApiKey && webdavConfig === undefined) return undefined;
  return { llmApiKey: llmApiKey || undefined, webdavConfig };
}

function validateV1(value: PlainObject): BackupParseResult {
  const envelopeError = validateEnvelope(value);
  if (envelopeError) return envelopeError;
  const data = value.data as PlainObject;
  const sharedError = validateSharedData(data) || optionalWebDAV(value);
  if (sharedError) return sharedError;
  if (data.userProfile !== null && !validateUserProfileInput(data.userProfile)) {
    return failure('INVALID_USER_PROFILE', '个人资料结构无效');
  }
  const profile = data.userProfile ? normalizeUserProfile(data.userProfile) : normalizeUserProfile({ personal: {} } as UserProfile);
  const id = 'default-resume';
  const library: ResumeProfileLibrary = {
    schemaVersion: 1,
    activeProfileId: id,
    profiles: [{ id, name: '默认简历', createdAt: value.exportedAt as string, updatedAt: value.exportedAt as string, profile }],
  };
  const document: BackupDocumentV3 = {
    schemaVersion: 3,
    exportedAt: value.exportedAt as string,
    source: { extensionVersion: (value.source as PlainObject).extensionVersion as string },
    data: { resumeProfileLibrary: library, llmConfig: publicLLMConfig(data.llmConfig as LLMConfig | null), settings: data.settings as Record<string, unknown> | null },
    legacySecrets: legacySecrets(value),
  };
  copyApplicationRecords(value, document);
  return { success: true, document };
}

function validateV2(value: PlainObject): BackupParseResult {
  const envelopeError = validateEnvelope(value);
  if (envelopeError) return envelopeError;
  const data = value.data as PlainObject;
  const sharedError = validateSharedData(data) || optionalWebDAV(value);
  if (sharedError) return sharedError;
  const rawLibrary = data.resumeProfileLibrary;
  if (!isPlainObject(rawLibrary) || !Array.isArray(rawLibrary.profiles)
    || !rawLibrary.profiles.some(entry => isPlainObject(entry) && entry.id === rawLibrary.activeProfileId)) {
    return failure('INVALID_RESUME_PROFILE_LIBRARY', '简历资料库结构无效');
  }
  let resumeProfileLibrary: ResumeProfileLibrary;
  try {
    resumeProfileLibrary = normalizeResumeProfileLibrary(data.resumeProfileLibrary);
  } catch {
    return failure('INVALID_RESUME_PROFILE_LIBRARY', '简历资料库结构无效');
  }
  if (!resumeProfileLibrary.profiles.some(profile => profile.id === resumeProfileLibrary.activeProfileId)) {
    return failure('INVALID_RESUME_PROFILE_LIBRARY', '简历资料库结构无效');
  }
  const document: BackupDocumentV3 = {
    schemaVersion: 3,
    exportedAt: value.exportedAt as string,
    source: { extensionVersion: (value.source as PlainObject).extensionVersion as string },
    data: {
      resumeProfileLibrary,
      llmConfig: publicLLMConfig(data.llmConfig as LLMConfig | null),
      settings: data.settings as Record<string, unknown> | null,
    },
    legacySecrets: legacySecrets(value),
  };
  copyApplicationRecords(value, document);
  return { success: true, document };
}

function validateV3(value: PlainObject): BackupParseResult {
  const envelopeError = validateEnvelope(value);
  if (envelopeError) return envelopeError;
  const data = value.data as PlainObject;
  const sharedError = validateSharedData(data);
  if (sharedError) return sharedError;
  const rawLibrary = data.resumeProfileLibrary;
  if (!isPlainObject(rawLibrary) || !Array.isArray(rawLibrary.profiles)) {
    return failure('INVALID_RESUME_PROFILE_LIBRARY', '简历资料库结构无效');
  }
  let resumeProfileLibrary: ResumeProfileLibrary;
  try {
    resumeProfileLibrary = normalizeResumeProfileLibrary(rawLibrary);
  } catch {
    return failure('INVALID_RESUME_PROFILE_LIBRARY', '简历资料库结构无效');
  }
  const llmConfig = data.llmConfig as LLMConfig | null;
  if (llmConfig?.apiKey) return failure('INVALID_LLM_CONFIG', 'V3 备份禁止包含 AI API Key');
  const document: BackupDocumentV3 = {
    schemaVersion: 3,
    exportedAt: value.exportedAt as string,
    source: { extensionVersion: (value.source as PlainObject).extensionVersion as string },
    data: {
      resumeProfileLibrary,
      llmConfig,
      settings: data.settings as Record<string, unknown> | null,
    },
  };
  copyApplicationRecords(value, document);
  return { success: true, document };
}

export function createBackupDocument(
  data: BackupData,
  extensionVersion: string,
  exportedAt = new Date().toISOString(),
  _webdavConfig?: WebDAVConfig | null,
): BackupDocumentV3 {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt,
    source: { extensionVersion },
    data: {
      resumeProfileLibrary: normalizeResumeProfileLibrary(data.resumeProfileLibrary),
      llmConfig: publicLLMConfig(data.llmConfig),
      settings: data.settings,
      applicationRecords: data.applicationRecords ?? [],
    },
  };
}

export function serializeBackup(document: BackupDocument): string {
  const { legacySecrets: _legacySecrets, ...serializable } = document;
  return JSON.stringify(serializable, null, 2);
}

export function migrateBackupDocument(value: PlainObject): BackupParseResult {
  if (value.schemaVersion === 1) return validateV1(value);
  if (value.schemaVersion === 2) return validateV2(value);
  if (value.schemaVersion === 3) return validateV3(value);
  return failure('UNSUPPORTED_OLD_VERSION', '此旧版备份没有可用的迁移器');
}

export function normalizeBackupDocument(document: BackupDocument): BackupDocument {
  return structuredClone(document);
}

export function parseAndValidateBackup(rawJson: string): BackupParseResult {
  if (new TextEncoder().encode(rawJson).byteLength > MAX_BACKUP_BYTES) {
    return failure('FILE_TOO_LARGE', '备份文件超过 20 MiB 上限');
  }

  let value: unknown;
  try {
    value = JSON.parse(rawJson);
  } catch {
    return failure('INVALID_JSON', '文件不是有效的 JSON');
  }
  if (!isPlainObject(value)) return failure('INVALID_ROOT', '备份根节点必须是对象');
  if (!Object.hasOwn(value, 'schemaVersion')) {
    return failure('MISSING_SCHEMA_VERSION', '备份缺少 schemaVersion');
  }
  if (!Number.isInteger(value.schemaVersion)) {
    return failure('INVALID_SCHEMA_VERSION', 'schemaVersion 必须是整数');
  }
  if ((value.schemaVersion as number) > BACKUP_SCHEMA_VERSION) {
    return failure('UNSUPPORTED_FUTURE_VERSION', '备份版本较新，请先升级扩展');
  }
  return migrateBackupDocument(value);
}

export function createBackupSummary(document: BackupDocument): BackupSummary {
  return {
    schemaVersion: document.schemaVersion,
    exportedAt: document.exportedAt,
    extensionVersion: document.source.extensionVersion,
    hasUserProfile: document.data.resumeProfileLibrary.profiles.length > 0,
    hasResumeFile: document.data.resumeProfileLibrary.profiles.some(item => Boolean(item.profile.resume?.fileData)),
    hasLLMConfig: document.data.llmConfig !== null,
    hasApiKey: Boolean(document.legacySecrets?.llmApiKey),
    hasWebDAVConfig: Boolean(document.legacySecrets?.webdavConfig?.serverUrl),
  };
}
