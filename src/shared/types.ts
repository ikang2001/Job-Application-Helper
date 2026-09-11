// 用户资料数据模型
export interface UserProfile {
  personal: PersonalInfo;
  education: EducationInfo[];
  languages?: LanguageInfo[];
  experience: ExperienceInfo[];
  projects: ProjectInfo[];
  awards: AwardInfo[];
  customInformation: CustomInformation[];
  skills: string[];
  certifications: CertificationInfo[];
  resume?: ResumeInfo;
}

export interface CustomInformation {
  id: string;
  name: string;
  content: string;
}

export interface PersonalInfo {
  name: string;
  gender: string;
  birthDate: string;
  phone: string;
  phoneCountryCode?: string;
  email: string;
  wechat?: string;
  idType?: string;
  idCard?: string;
  nationality?: string;
  politicalStatus?: string;
  ethnicity?: string;
  hometown?: string;
  currentAddress?: string;
  selfEvaluation?: string;
}

export interface LanguageInfo {
  id: string;
  language: string;
  certificate?: string;
  level: string;
}

export interface EducationInfo {
  id: string;
  school: string;
  countryRegion?: string;
  schoolLocation?: string;
  college?: string;
  educationType?: string;
  major: string;
  degree: string;
  startDate: string;
  endDate: string;
  gpa?: string;
  ranking?: string;
}

export interface ExperienceInfo {
  id: string;
  company: string;
  position: string;
  startDate: string;
  endDate: string;
  description: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  role: string;
  startDate: string;
  endDate: string;
  description: string;
}

export interface AwardInfo {
  id: string;
  name: string;
  role: string;
  date: string;
  description: string;
}

export interface CertificationInfo {
  id: string;
  name: string;
  issuer: string;
  date: string;
  credentialId?: string;
}

export interface ResumeInfo {
  fileName: string;
  fileData: string; // Base64编码
  fileType: string;
  parsedText?: string;
  uploadDate: string;
}

import type { LLMConfig } from '../services/llm/types';
import type { MailAccount } from '../services/mail/accounts.ts';

export type SettingsData = Record<string, unknown>;

export interface BackupData {
  resumeProfileLibrary: ResumeProfileLibrary;
  llmConfig: LLMConfig | null;
  settings: SettingsData | null;
  applicationRecords?: ApplicationRecord[] | null;
}

export interface BackupDataV1 {
  userProfile: UserProfile | null;
  llmConfig: LLMConfig | null;
  settings: SettingsData | null;
  applicationRecords?: ApplicationRecord[] | null;
}

export interface BackupDocumentV1 {
  schemaVersion: 1;
  exportedAt: string;
  source: { extensionVersion: string };
  data: BackupDataV1;
  webdavConfig?: WebDAVConfig | null;
}

export interface BackupDocumentV2 {
  schemaVersion: 2;
  exportedAt: string;
  source: { extensionVersion: string };
  data: BackupData;
  webdavConfig?: WebDAVConfig | null;
}

export interface BackupDocumentV3 {
  schemaVersion: 3;
  exportedAt: string;
  source: { extensionVersion: string };
  data: BackupData;
  /** 仅由旧备份解析器在内存中附加，serializeBackup 永不输出。 */
  legacySecrets?: {
    llmApiKey?: string;
    webdavConfig?: WebDAVConfig | null;
  };
}

export type BackupDocument = BackupDocumentV3;

export type BackupErrorCode =
  | 'FILE_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_ROOT'
  | 'MISSING_SCHEMA_VERSION'
  | 'INVALID_SCHEMA_VERSION'
  | 'UNSUPPORTED_FUTURE_VERSION'
  | 'UNSUPPORTED_OLD_VERSION'
  | 'INVALID_EXPORTED_AT'
  | 'INVALID_SOURCE'
  | 'INVALID_DATA'
  | 'INVALID_USER_PROFILE'
  | 'INVALID_RESUME_PROFILE_LIBRARY'
  | 'INVALID_LLM_CONFIG'
  | 'INVALID_SETTINGS'
  | 'INVALID_WEBDAV_CONFIG';

export interface BackupParseError {
  code: BackupErrorCode;
  message: string;
}

export type BackupParseResult =
  | { success: true; document: BackupDocument }
  | { success: false; error: BackupParseError };

export interface BackupSummary {
  schemaVersion: number;
  exportedAt: string;
  extensionVersion: string;
  hasUserProfile: boolean;
  hasResumeFile: boolean;
  hasLLMConfig: boolean;
  hasApiKey: boolean;
  hasWebDAVConfig: boolean;
}

export interface WebDAVConfig {
  enabled: boolean;
  serverUrl: string;
  username: string;
  password: string;
}

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'conflict' | 'error';

export interface SyncConflictSummary {
  local: BackupSummary;
  remote: BackupSummary;
}

export interface SyncMetadata {
  etag?: string;
  lastSyncedHash?: string;
  lastSyncedAt?: string;
  status: SyncStatus;
  lastError?: string;
  conflict?: SyncConflictSummary;
  hashSchemaVersion?: number;
}

export type ApplicationRecordStatus =
  | '待投递'
  | '已投递'
  | '笔试/测评'
  | '面试中'
  | 'offer'
  | '已拒绝'
  | '主动放弃'
  | '职位关闭'
  | '终止';

export type ApplicationEventType =
  | 'application_created'
  | 'applied'
  | 'application_received'
  | 'assessment_invite'
  | 'assessment_completed'
  | 'interview_invite'
  | 'interview'
  | 'offer'
  | 'rejection'
  | 'withdrawn'
  | 'job_closed'
  | 'note'
  | 'status_override';

export type ApplicationEventSource = 'manual' | 'website' | 'email' | 'migration';

export interface ApplicationEventMetadata {
  status?: ApplicationRecordStatus;
  jobId?: string;
  applicationId?: string;
  interviewAt?: string;
  deadlineAt?: string;
  meetingUrl?: string;
  emailSubject?: string;
  summary?: string;
  classification?: string;
}

export interface ApplicationEvent {
  id: string;
  type: ApplicationEventType;
  occurredAt: string;
  timePrecision: 'date' | 'datetime';
  source: ApplicationEventSource;
  title: string;
  note?: string;
  sourceKey: string;
  emailAccountId?: string;
  emailMessageId?: string;
  classificationConfidence?: number;
  matchConfidence?: number;
  decisionConfidence?: number;
  metadata?: ApplicationEventMetadata;
}

export type ApplicationEventTombstoneReason = 'deleted' | 'ignored' | 'unlinked';

export interface ApplicationEventTombstone {
  recordId: string;
  sourceKey: string;
  reason: ApplicationEventTombstoneReason;
  createdAt: string;
  expiresAt?: string;
}

export interface ResumeSnapshot {
  profileId?: string;
  profileName?: string;
  fileName?: string;
  profileUpdatedAt?: string;
}

export interface JobDescriptionSnapshot {
  text: string;
  capturedAt: string;
  sourceUrl: string;
  contentHash: string;
  truncated: boolean;
}

export interface ApplicationPageMetadata {
  companyName: string;
  sourceSite: string;
  sourceUrl: string;
  jobTitle?: string;
  jobId?: string;
  applicationId?: string;
  location?: string;
  employmentType?: string;
  jdSnapshot?: JobDescriptionSnapshot;
  pageTitle?: string;
}

export interface SubmissionAttemptSnapshot {
  sourceUrl: string;
  startedAt: string;
  applicationEmail?: string;
  triggerLabel: string;
  metadata?: Partial<ApplicationPageMetadata>;
}

export interface SubmissionContext {
  id: string;
  tabId: number;
  sourceUrl: string;
  startedAt: string;
  resumeProfileId?: string;
  resumeProfileName?: string;
  resumeFileName?: string;
  resumeRevision?: string;
  applicationEmail?: string;
  metadata: Partial<Pick<
    ApplicationPageMetadata,
    'companyName' | 'jobTitle' | 'jobId' | 'applicationId' | 'location' | 'employmentType' | 'sourceSite' | 'sourceUrl' | 'pageTitle' | 'jdSnapshot'
  >>;
  expiresAt: string;
}

export type PendingSubmissionSignal =
  | 'buttonClick'
  | 'successText'
  | 'successRoute'
  | 'pageStructure'
  | 'negativeSignal';

export interface PendingSubmission {
  id: string;
  contextId: string;
  score: number;
  signals: PendingSubmissionSignal[];
  createdAt: string;
  expiresAt: string;
  state: 'pending' | 'confirmed' | 'ignored';
}

export interface RecruitmentScheduleEntry {
  scheduledAt: string;
  url: string;
  timeKind?: 'start' | 'deadline';
  completedAt?: string;
}

export type InterviewRound = 'ai' | 'first' | 'second' | 'third' | 'hr';

export interface RecruitmentSchedule {
  writtenTest?: RecruitmentScheduleEntry;
  assessment?: RecruitmentScheduleEntry;
  interviews?: Partial<Record<InterviewRound, RecruitmentScheduleEntry>>;
}

export interface ApplicationRecord {
  id: string;
  companyName: string;
  jobTitle: string;
  jobId?: string;
  applicationId?: string;
  sourceSite: string;
  sourceUrl: string;
  employmentType?: string;
  status: ApplicationRecordStatus;
  notes: string;
  appliedAt: string;
  applicationEmail?: string;
  recruitmentSchedule?: RecruitmentSchedule;
  resumeSnapshot?: ResumeSnapshot;
  jdSnapshot?: JobDescriptionSnapshot;
  events: ApplicationEvent[];
  migrationWarnings?: string[];
  location: string;
  createdAt: string;
  updatedAt: string;
}

export type ApplicationRecordDraft = Omit<ApplicationRecord, 'id'>;

export type SyncAction =
  | 'create-remote'
  | 'no-change'
  | 'upload-local'
  | 'download-remote'
  | 'conflict';

export type SyncResultStatus = 'disabled' | 'synced' | 'queued' | 'conflict' | 'error';

export interface LocalDesktopSyncState {
  status: 'checking' | 'syncing' | 'synced' | 'unavailable' | 'error';
  lastSyncedAt?: string;
  lastError?: string;
  filePath?: string;
  revision?: number;
  recordCount?: number;
}

export interface LocalSaveResult {
  localSaved: true;
  sync: SyncResultStatus;
}

export type FocusedFieldFailureReason =
  | 'NO_ACTIVE_TAB'
  | 'NO_CONTENT_SCRIPT'
  | 'NO_FOCUSED_FIELD'
  | 'FIELD_DETACHED'
  | 'FIELD_NOT_WRITABLE'
  | 'VALUE_REJECTED'
  | 'RESTRICTED_PAGE';

export interface FocusedFieldWriteResult {
  written: boolean;
  reason?: FocusedFieldFailureReason;
}

export interface VisualRegionControlPayload {
  sessionId?: string;
  tabId?: number;
}

export interface VisualRegionSelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface VisualRegionImagePayload {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface VisualRegionControlRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VisualRegionControlCandidate {
  controlId: string;
  tagName: string;
  label: string;
  name: string;
  semanticType?: string;
  rowIndex?: number;
  placeholder: string;
  options: string[];
  rect: VisualRegionControlRect;
  contextText: string;
}

export interface VisualRegionFillMapping {
  controlId: string;
  fieldMeaning: string;
  matchedProfilePath: string;
  value: string;
}

interface VisualRegionFillPayloadBase {
  requestId?: string;
  domain?: string;
  controls: VisualRegionControlCandidate[];
  imageDataUrl?: string;
  region: VisualRegionSelectionRect;
  instruction?: string;
  pageContext?: string;
  targetLabel?: string;
}

export interface VisualRegionFillPayload extends VisualRegionFillPayloadBase {
  image: VisualRegionImagePayload;
}

export interface VisualRegionFillRequestPayload extends VisualRegionFillPayloadBase {}

export interface VisualRegionFillResult {
  value: string;
  confidence?: number;
  model?: string;
}

export interface VisualRegionFillMappingResult {
  mappings: VisualRegionFillMapping[];
}

// 消息类型定义
export type Message =
  | { type: 'GET_USER_PROFILE'; payload?: null }
  | { type: 'GET_ACTIVE_RESUME_CONTEXT'; payload?: null }
  | { type: 'SAVE_USER_PROFILE'; payload: UserProfile | { profile: UserProfile; expectedProfileId: string } }
  | { type: 'GET_RESUME_PROFILES'; payload?: null }
  | { type: 'SWITCH_RESUME_PROFILE'; payload: { id: string } }
  | { type: 'CREATE_RESUME_PROFILE'; payload: { name?: string } }
  | { type: 'DUPLICATE_RESUME_PROFILE'; payload: { id: string } }
  | { type: 'RENAME_RESUME_PROFILE'; payload: { id: string; name: string } }
  | { type: 'DELETE_RESUME_PROFILE'; payload: { id: string } }
  | { type: 'PARSE_RESUME'; payload: { file: string; fileType: string; fileName: string; rawText?: string } }
  | { type: 'FILL_FORM'; payload?: null }
  | { type: 'START_QUICK_FILL'; payload?: null }
  | { type: 'GET_APPLICATION_PAGE_METADATA'; payload?: null }
  | { type: 'CACHE_APPLICATION_PAGE_METADATA'; payload: ApplicationPageMetadata }
  | { type: 'SUBMISSION_ATTEMPT_STARTED'; payload: SubmissionAttemptSnapshot }
  | { type: 'UPSERT_PENDING_SUBMISSION'; payload: { pending: PendingSubmission; context: SubmissionContext } }
  | { type: 'GET_PENDING_SUBMISSIONS'; payload?: null }
  | { type: 'CONFIRM_PENDING_SUBMISSION'; payload: { pendingId: string; metadata?: Partial<ApplicationPageMetadata> } }
  | { type: 'IGNORE_PENDING_SUBMISSION'; payload: { pendingId: string } }
  | { type: 'IGNORE_PENDING_SUBMISSIONS'; payload: { pendingIds: string[] } }
  | { type: 'CREATE_APPLICATION_RECORD_DRAFT'; payload: { tabId: number } }
  | { type: 'GET_APPLICATION_RECORD_DRAFT'; payload: { draftId: string } }
  | { type: 'GET_APPLICATION_RECORDS'; payload?: null }
  | { type: 'CREATE_APPLICATION_RECORD'; payload: ApplicationRecord }
  | { type: 'UPDATE_APPLICATION_RECORD'; payload: ApplicationRecord }
  | { type: 'DELETE_APPLICATION_RECORD'; payload: { id: string } }
  | { type: 'REMOVE_APPLICATION_EVENT'; payload: { recordId: string; sourceKey: string; reason: ApplicationEventTombstoneReason } }
  | { type: 'RESTORE_APPLICATION_EVENT_SOURCE'; payload: { recordId: string; sourceKey: string } }
  | { type: 'EXPORT_APPLICATION_RECORDS_CSV'; payload?: null }
  | { type: 'IMPORT_APPLICATION_RECORDS_CSV'; payload: { csv: string } }
  | { type: 'START_AI_PAGE_FILL'; payload?: null }
  | { type: 'DETECT_FIELDS'; payload?: null }
  | { type: 'START_AI_REGION_FILL'; payload?: VisualRegionControlPayload | null }
  | { type: 'AI_FILL_VISUAL_REGION'; payload: VisualRegionFillPayload | VisualRegionFillRequestPayload }
  | { type: 'CROP_IMAGE_OFFSCREEN'; payload: { imageDataUrl: string; selectionRect: VisualRegionSelectionRect } }
  | { type: 'WRITE_FOCUSED_FIELD'; payload: { tabId: number; value: string } }
  | { type: 'APPLY_FOCUSED_FIELD'; payload: VisualRegionFillResult }
  | { type: 'GET_RESUME_DATA'; payload?: null }
  | { type: 'GENERATE_ANSWER'; payload: { questionText: string; context?: string; fieldMaxLength?: number; language?: 'zh' | 'en' } }
  | { type: 'MATCH_FIELDS_LLM'; payload: { fields: Array<{ index: number; name: string; id: string; placeholder: string; labelText: string; type: string }>; domain: string } }
  | {
      type: 'AI_FILL_SECTION';
      payload: {
        requestId: string;
        section: string;
        fields: Array<{
          index: number;
          rowIndex: number;
          section?: string;
          name: string;
          label: string;
          semanticType?: string;
          type: string;
          options: string[];
          context: string;
        }>;
        domain: string;
      };
    }
  | { type: 'CANCEL_AI_FILL'; payload: { requestId: string } }
  | { type: 'GET_LLM_CONFIG'; payload?: null }
  | { type: 'SAVE_LLM_CONFIG'; payload: LLMConfig }
  | { type: 'LIST_LLM_MODELS'; payload: LLMConfig }
  | { type: 'TEST_LLM_CONNECTION'; payload?: LLMConfig | null }
  | { type: 'GET_MAIL_ACCOUNTS'; payload?: null }
  | { type: 'UPSERT_MAIL_ACCOUNT'; payload: { account: MailAccount; credential?: string } }
  | { type: 'DELETE_MAIL_ACCOUNT'; payload: { accountId: string } }
  | { type: 'CONNECT_MAIL_ACCOUNT'; payload: { accountId: string; credential?: string } }
  | { type: 'DISCONNECT_MAIL_ACCOUNT'; payload: { accountId: string } }
  | { type: 'TEST_MAIL_ACCOUNT'; payload: { accountId: string } }
  | { type: 'SYNC_MAIL'; payload?: { accountId?: string } | null }
  | { type: 'GET_PENDING_MAIL_REVIEWS'; payload?: null }
  | { type: 'CONFIRM_MAIL_REVIEW'; payload: { reviewId: string; recordId?: string } }
  | { type: 'IGNORE_MAIL_REVIEW'; payload: { reviewId: string } }
  | { type: 'EXPORT_BACKUP'; payload?: null }
  | { type: 'PREVIEW_BACKUP_IMPORT'; payload: { json: string } }
  | { type: 'IMPORT_BACKUP'; payload: { json: string } }
  | { type: 'GET_WEBDAV_CONFIG'; payload?: null }
  | { type: 'SAVE_WEBDAV_CONFIG'; payload: WebDAVConfig }
  | { type: 'TEST_WEBDAV'; payload: WebDAVConfig }
  | { type: 'GET_SYNC_STATUS'; payload?: null }
  | { type: 'GET_LOCAL_DESKTOP_SYNC_STATUS'; payload?: null }
  | { type: 'SYNC_LOCAL_DESKTOP_NOW'; payload?: null }
  | { type: 'SYNC_NOW'; payload?: null }
  | { type: 'FORCE_UPLOAD_LOCAL'; payload?: null }
  | { type: 'FORCE_DOWNLOAD_REMOTE'; payload?: null }
  | { type: 'RESOLVE_SYNC_CONFLICT'; payload: { choice: 'local' | 'remote' } };

export interface MessageResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// 表单字段检测结果
export interface DetectedField {
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  fieldType: string;
  confidence: number;
  value?: string;
  rowIndex?: number;
}

// 字段类型枚举
export enum FieldType {
  NAME = 'name',
  GENDER = 'gender',
  BIRTH_DATE = 'birthDate',
  PHONE_COUNTRY_CODE = 'phoneCountryCode',
  PHONE = 'phone',
  EMAIL = 'email',
  WECHAT = 'wechat',
  ID_TYPE = 'idType',
  ID_CARD = 'idCard',
  NATIONALITY = 'nationality',
  POLITICAL_STATUS = 'politicalStatus',
  ETHNICITY = 'ethnicity',
  HOMETOWN = 'hometown',
  CURRENT_ADDRESS = 'currentAddress',
  SCHOOL = 'school',
  EDUCATION_COUNTRY = 'educationCountry',
  SCHOOL_LOCATION = 'schoolLocation',
  COLLEGE = 'college',
  EDUCATION_TYPE = 'educationType',
  MAJOR = 'major',
  DEGREE = 'degree',
  GPA = 'gpa',
  LANGUAGE = 'language',
  LANGUAGE_CERTIFICATE = 'languageCertificate',
  LANGUAGE_LEVEL = 'languageLevel',
  SELF_EVALUATION = 'selfEvaluation',
  EDUCATION_START_DATE = 'educationStartDate',
  GRADUATION_DATE = 'graduationDate',
  COMPANY = 'company',
  POSITION = 'position',
  START_DATE = 'startDate',
  END_DATE = 'endDate',
  DESCRIPTION = 'description',
  PROJECT_NAME = 'projectName',
  PROJECT_ROLE = 'projectRole',
  PROJECT_START_DATE = 'projectStartDate',
  PROJECT_END_DATE = 'projectEndDate',
  PROJECT_DESCRIPTION = 'projectDescription',
  AWARD_NAME = 'awardName',
  AWARD_ROLE = 'awardRole',
  AWARD_DATE = 'awardDate',
  AWARD_DESCRIPTION = 'awardDescription',
  SKILLS = 'skills',
  RESUME_FILE = 'resumeFile',
  UNKNOWN = 'unknown'
}

// 简历解析结果
export interface ParsedResumeData {
  personal?: Partial<PersonalInfo>;
  education?: Partial<EducationInfo>[];
  languages?: Partial<LanguageInfo>[];
  experience?: Partial<ExperienceInfo>[];
  projects?: Partial<ProjectInfo>[];
  awards?: Partial<AwardInfo>[];
  skills?: string[];
  rawText: string;
}

export interface ResumeProfile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  profile: UserProfile;
}

export interface ResumeProfileSummary {
  activeProfileId: string;
  profiles: Array<Pick<ResumeProfile, 'id' | 'name' | 'createdAt' | 'updatedAt'>>;
}

export interface ResumeProfileMutationResult extends ResumeProfileSummary {
  sync: SyncResultStatus;
  syncError?: string;
}

export interface ActiveResumeContext extends ResumeProfileSummary {
  profile: UserProfile;
  revision: string;
}

export interface ResumeProfileLibrary {
  schemaVersion: 1;
  activeProfileId: string;
  profiles: ResumeProfile[];
}
