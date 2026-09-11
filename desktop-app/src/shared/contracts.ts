import type {
  ApplicationRecord,
  ApplicationRecordStatus,
  RecruitmentSchedule,
} from '../../../src/shared/types.ts';

export const DESKTOP_CHANNELS = {
  getState: 'desktop:get-state',
  stateChanged: 'desktop:state-changed',
  saveRecord: 'desktop:save-record',
  deleteRecord: 'desktop:delete-record',
  setRecordFavorite: 'desktop:set-record-favorite',
  saveCareerFair: 'desktop:save-career-fair',
  deleteCareerFair: 'desktop:delete-career-fair',
  importJson: 'desktop:import-json',
  exportJson: 'desktop:export-json',
  importCsv: 'desktop:import-csv',
  exportCsv: 'desktop:export-csv',
  saveWebDav: 'desktop:save-webdav',
  testWebDav: 'desktop:test-webdav',
  syncNow: 'desktop:sync-now',
  resolveConflict: 'desktop:resolve-conflict',
  setupMobileSync: 'desktop:setup-mobile-sync',
  setMobileSyncEnabled: 'desktop:set-mobile-sync-enabled',
  setDesktopReminderEnabled: 'desktop:set-desktop-reminder-enabled',
  syncMobileNow: 'desktop:sync-mobile-now',
  getMobilePairing: 'desktop:get-mobile-pairing',
  scanMail: 'desktop:scan-mail',
  confirmMailReview: 'desktop:confirm-mail-review',
  ignoreMailReview: 'desktop:ignore-mail-review',
  ignoreMailReviews: 'desktop:ignore-mail-reviews',
  openExternal: 'desktop:open-external',
} as const;

export const CAREER_FAIR_STATUSES = ['计划参加', '已报名', '已参加', '不参加'] as const;
export const CAREER_FAIR_MODES = ['线下', '线上', '线上+线下'] as const;

export type CareerFairStatus = typeof CAREER_FAIR_STATUSES[number];
export type CareerFairMode = typeof CAREER_FAIR_MODES[number];

export interface CareerFair {
  id: string;
  name: string;
  status: CareerFairStatus;
  startsAt: string;
  endsAt: string;
  mode: CareerFairMode;
  location: string;
  organizer: string;
  registrationDeadline: string;
  eventUrl: string;
  targetCompanies: string;
  targetRoles: string;
  preparation: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopCareerFairInput {
  id?: string;
  name: string;
  status: CareerFairStatus;
  startsAt: string;
  endsAt: string;
  mode: CareerFairMode;
  location: string;
  organizer: string;
  registrationDeadline: string;
  eventUrl: string;
  targetCompanies: string;
  targetRoles: string;
  preparation: string;
  notes: string;
}

export type DesktopSyncStatus = 'idle' | 'syncing' | 'synced' | 'conflict' | 'error' | 'disabled';

export interface DesktopSyncConflict {
  localCount: number;
  remoteCount: number;
  remoteExportedAt?: string;
}

export interface DesktopSyncState {
  status: DesktopSyncStatus;
  lastSyncedAt?: string;
  lastError?: string;
  conflict?: DesktopSyncConflict;
}

export interface DesktopWebDavState {
  enabled: boolean;
  serverUrl: string;
  username: string;
  passwordConfigured: boolean;
}

export interface DesktopLocalSyncState {
  status: 'checking' | 'syncing' | 'synced' | 'error';
  lastSyncedAt?: string;
  lastError?: string;
  filePath?: string;
  revision?: number;
  recordCount?: number;
}

export type DesktopMobileSyncStatus = 'disabled' | 'idle' | 'syncing' | 'synced' | 'error';

export interface DesktopMobileSyncState {
  configured: boolean;
  enabled: boolean;
  serverUrl: string;
  status: DesktopMobileSyncStatus;
  lastSyncedAt?: string;
  lastError?: string;
  revision?: number;
}

export interface DesktopMobileSyncSetupInput {
  serverUrl: string;
  setupToken: string;
}

export interface DesktopReminderState {
  enabled: boolean;
  supported: boolean;
}

export interface DesktopMobilePairingInfo {
  pairingUrl: string;
  deviceId: string;
}

export type DesktopMailInboxStatus = 'idle' | 'scanning' | 'error' | 'unavailable';
export type DesktopMailReviewState = 'pending' | 'confirmed' | 'ignored';
export type DesktopMailReviewStage =
  | 'applicationReceived'
  | 'writtenTest'
  | 'assessment'
  | 'ai'
  | 'first'
  | 'second'
  | 'third'
  | 'hr'
  | 'offer'
  | 'rejection'
  | 'jobClosed';

export interface DesktopMailAccountState {
  id: string;
  provider: string;
  emailAddress: string;
  displayName: string;
  connection: 'unknown' | 'connected' | 'error';
  lastError?: string;
}

export interface DesktopMailReview {
  id: string;
  accountId: string;
  messageId: string;
  from: string;
  subject: string;
  receivedAt: string;
  summary: string;
  category: string;
  suggestedStage?: DesktopMailReviewStage;
  companyName?: string;
  candidateRecordIds: string[];
  extractedAt?: string;
  deadlineAt?: string;
  actionUrl?: string;
  state: DesktopMailReviewState;
  reviewedAt?: string;
  selectedRecordId?: string;
  selectedStage?: DesktopMailReviewStage;
}

export interface DesktopMailInboxState {
  status: DesktopMailInboxStatus;
  accounts: DesktopMailAccountState[];
  reviews: DesktopMailReview[];
  pendingCount: number;
  lastScannedAt?: string;
  lastError?: string;
}

export interface DesktopMailReviewDecisionInput {
  reviewId: string;
  recordId: string;
  stage: DesktopMailReviewStage;
  scheduledAt?: string;
  scheduleType?: 'start' | 'deadline';
  actionUrl?: string;
  notes?: string;
}

export interface DesktopState {
  records: ApplicationRecord[];
  favoriteRecordIds: string[];
  careerFairs: CareerFair[];
  desktopReminder: DesktopReminderState;
  localSync: DesktopLocalSyncState;
  mobileSync: DesktopMobileSyncState;
  mailInbox: DesktopMailInboxState;
  sync: DesktopSyncState;
  webdav: DesktopWebDavState;
}

export interface DesktopCareerFairSaveResult {
  state: DesktopState;
  careerFairId: string;
}

export interface DesktopRecordInput {
  id?: string;
  companyName: string;
  jobTitle: string;
  sourceSite: string;
  sourceUrl: string;
  status: ApplicationRecordStatus;
  notes: string;
  appliedAt: string;
  location: string;
  applicationEmail?: string;
  jobId?: string;
  applicationId?: string;
  employmentType?: string;
  recruitmentSchedule?: RecruitmentSchedule;
}

export interface DesktopRecordSaveResult {
  state: DesktopState;
  recordId: string;
  duplicate?: Pick<ApplicationRecord, 'id' | 'companyName' | 'jobTitle'>;
}

export interface DesktopRecordFavoriteInput {
  recordId: string;
  favorite: boolean;
}

export interface DesktopImportResult {
  state: DesktopState;
  imported: number;
  warnings: string[];
  cancelled?: boolean;
}

export interface DesktopExportResult {
  filename?: string;
  cancelled?: boolean;
}

export interface DesktopWebDavInput {
  enabled: boolean;
  serverUrl: string;
  username: string;
  password?: string;
}

export interface DesktopResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface DesktopApi {
  getState(): Promise<DesktopResult<DesktopState>>;
  onStateChanged(listener: (state: DesktopState) => void): () => void;
  saveRecord(input: DesktopRecordInput): Promise<DesktopResult<DesktopRecordSaveResult>>;
  deleteRecord(id: string): Promise<DesktopResult<DesktopState>>;
  setRecordFavorite(input: DesktopRecordFavoriteInput): Promise<DesktopResult<DesktopState>>;
  saveCareerFair(input: DesktopCareerFairInput): Promise<DesktopResult<DesktopCareerFairSaveResult>>;
  deleteCareerFair(id: string): Promise<DesktopResult<DesktopState>>;
  importJson(): Promise<DesktopResult<DesktopImportResult>>;
  exportJson(): Promise<DesktopResult<DesktopExportResult>>;
  importCsv(): Promise<DesktopResult<DesktopImportResult>>;
  exportCsv(): Promise<DesktopResult<DesktopExportResult>>;
  saveWebDav(input: DesktopWebDavInput): Promise<DesktopResult<DesktopState>>;
  testWebDav(input: DesktopWebDavInput): Promise<DesktopResult<{ exists: boolean }>>;
  syncNow(): Promise<DesktopResult<DesktopState>>;
  resolveConflict(choice: 'local' | 'remote'): Promise<DesktopResult<DesktopState>>;
  setupMobileSync(input: DesktopMobileSyncSetupInput): Promise<DesktopResult<DesktopState>>;
  setMobileSyncEnabled(enabled: boolean): Promise<DesktopResult<DesktopState>>;
  setDesktopReminderEnabled(enabled: boolean): Promise<DesktopResult<DesktopState>>;
  syncMobileNow(): Promise<DesktopResult<DesktopState>>;
  getMobilePairing(): Promise<DesktopResult<DesktopMobilePairingInfo>>;
  scanMail(): Promise<DesktopResult<DesktopState>>;
  confirmMailReview(input: DesktopMailReviewDecisionInput): Promise<DesktopResult<DesktopState>>;
  ignoreMailReview(reviewId: string): Promise<DesktopResult<DesktopState>>;
  ignoreMailReviews(reviewIds: string[]): Promise<DesktopResult<DesktopState>>;
  openExternal(url: string): Promise<DesktopResult<void>>;
}
