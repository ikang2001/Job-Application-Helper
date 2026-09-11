import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeApplicationRecords } from '../../../src/shared/applicationRecords.ts';
import { parseAndValidateBackup } from '../../../src/shared/backup.ts';
import type { ApplicationRecord, BackupDocument } from '../../../src/shared/types.ts';
import { normalizeCareerFairs } from '../domain/careerFairs.ts';
import type {
  CareerFair,
  DesktopMailAccountState,
  DesktopMailInboxStatus,
  DesktopMailReview,
  DesktopMailReviewStage,
  DesktopSyncState,
} from '../shared/contracts.ts';

export const DESKTOP_DATA_SCHEMA_VERSION = 1;

export interface SecretCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface StoredWebDavSettings {
  enabled: boolean;
  serverUrl: string;
  username: string;
  encryptedPassword: string;
}

export interface StoredSyncState extends DesktopSyncState {
  baseRecordsHash?: string;
  etag?: string;
}

export interface StoredMobileSyncSettings {
  enabled: boolean;
  serverUrl: string;
  deviceId: string;
  encryptedWriteToken: string;
  encryptedReadToken: string;
  encryptedPairingKey: string;
  lastRevision?: number;
}

export interface StoredDesktopReminderSettings {
  enabled: boolean;
}

export interface StoredMailCursor {
  uidValidity: string;
  lastUid: number;
}

export interface StoredDesktopMailInbox {
  status: DesktopMailInboxStatus;
  accounts: DesktopMailAccountState[];
  reviews: DesktopMailReview[];
  cursors: Record<string, StoredMailCursor>;
  lastScannedAt?: string;
  lastError?: string;
}

export interface DesktopData {
  schemaVersion: 1;
  records: ApplicationRecord[];
  favoriteRecordIds: string[];
  careerFairs: CareerFair[];
  sourceBackup?: BackupDocument;
  webdav?: StoredWebDavSettings;
  mobileSync?: StoredMobileSyncSettings;
  desktopReminder?: StoredDesktopReminderSettings;
  mailInbox?: StoredDesktopMailInbox;
  sync: StoredSyncState;
}

function emptyData(): DesktopData {
  return {
    schemaVersion: DESKTOP_DATA_SCHEMA_VERSION,
    records: [],
    favoriteRecordIds: [],
    careerFairs: [],
    desktopReminder: { enabled: true },
    sync: { status: 'idle' },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeSyncState(value: unknown): StoredSyncState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'idle' };
  const input = value as Partial<StoredSyncState>;
  const statuses = new Set<DesktopSyncState['status']>([
    'idle', 'syncing', 'synced', 'conflict', 'error', 'disabled',
  ]);
  return {
    status: statuses.has(input.status as DesktopSyncState['status'])
      ? input.status as DesktopSyncState['status']
      : 'idle',
    lastSyncedAt: optionalString(input.lastSyncedAt),
    lastError: optionalString(input.lastError),
    baseRecordsHash: optionalString(input.baseRecordsHash),
    etag: optionalString(input.etag),
    conflict: input.conflict,
  };
}

function normalizeWebDav(value: unknown): StoredWebDavSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Partial<StoredWebDavSettings>;
  if (typeof input.enabled !== 'boolean') return undefined;
  return {
    enabled: input.enabled,
    serverUrl: optionalString(input.serverUrl) ?? '',
    username: optionalString(input.username) ?? '',
    encryptedPassword: optionalString(input.encryptedPassword) ?? '',
  };
}

function normalizeMobileSync(value: unknown): StoredMobileSyncSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Partial<StoredMobileSyncSettings>;
  if (typeof input.enabled !== 'boolean') return undefined;
  const serverUrl = optionalString(input.serverUrl);
  const deviceId = optionalString(input.deviceId);
  const encryptedWriteToken = optionalString(input.encryptedWriteToken);
  const encryptedReadToken = optionalString(input.encryptedReadToken);
  const encryptedPairingKey = optionalString(input.encryptedPairingKey);
  if (!serverUrl || !deviceId || !encryptedWriteToken || !encryptedReadToken || !encryptedPairingKey) {
    return undefined;
  }
  return {
    enabled: input.enabled,
    serverUrl,
    deviceId,
    encryptedWriteToken,
    encryptedReadToken,
    encryptedPairingKey,
    lastRevision: typeof input.lastRevision === 'number' && Number.isSafeInteger(input.lastRevision)
      ? input.lastRevision
      : undefined,
  };
}

function normalizeDesktopReminder(value: unknown): StoredDesktopReminderSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { enabled: true };
  const input = value as Partial<StoredDesktopReminderSettings>;
  return { enabled: typeof input.enabled === 'boolean' ? input.enabled : true };
}

const MAIL_REVIEW_STATES = new Set(['pending', 'confirmed', 'ignored']);
const MAIL_REVIEW_STAGES = new Set<DesktopMailReviewStage>([
  'applicationReceived', 'writtenTest', 'assessment', 'ai', 'first', 'second', 'third', 'hr',
  'offer', 'rejection', 'jobClosed',
]);
const MAIL_INBOX_STATUSES = new Set<DesktopMailInboxStatus>(['idle', 'scanning', 'error', 'unavailable']);

function normalizeMailInbox(value: unknown): StoredDesktopMailInbox | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Partial<StoredDesktopMailInbox>;
  const accounts = Array.isArray(input.accounts)
    ? input.accounts.map(normalizeMailAccount).filter((item): item is DesktopMailAccountState => Boolean(item))
    : [];
  const reviews = Array.isArray(input.reviews)
    ? input.reviews.map(normalizeMailReview).filter((item): item is DesktopMailReview => Boolean(item))
    : [];
  const cursors: Record<string, StoredMailCursor> = {};
  if (input.cursors && typeof input.cursors === 'object' && !Array.isArray(input.cursors)) {
    for (const [accountId, cursor] of Object.entries(input.cursors)) {
      if (
        accountId
        && cursor
        && typeof cursor === 'object'
        && typeof cursor.uidValidity === 'string'
        && typeof cursor.lastUid === 'number'
        && Number.isSafeInteger(cursor.lastUid)
        && cursor.lastUid >= 0
      ) cursors[accountId] = { uidValidity: cursor.uidValidity, lastUid: cursor.lastUid };
    }
  }
  const requestedStatus = input.status;
  return {
    status: MAIL_INBOX_STATUSES.has(requestedStatus as DesktopMailInboxStatus)
      ? requestedStatus as DesktopMailInboxStatus
      : 'idle',
    accounts,
    reviews,
    cursors,
    lastScannedAt: optionalString(input.lastScannedAt),
    lastError: optionalString(input.lastError),
  };
}

function normalizeMailAccount(value: unknown): DesktopMailAccountState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Partial<DesktopMailAccountState>;
  const id = optionalString(input.id);
  const emailAddress = optionalString(input.emailAddress);
  if (!id || !emailAddress) return undefined;
  const connection = new Set(['unknown', 'connected', 'error']).has(input.connection ?? '')
    ? input.connection as DesktopMailAccountState['connection']
    : 'unknown';
  return {
    id,
    provider: optionalString(input.provider) ?? 'imap',
    emailAddress,
    displayName: optionalString(input.displayName) ?? '',
    connection,
    lastError: optionalString(input.lastError),
  };
}

function normalizeMailReview(value: unknown): DesktopMailReview | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Partial<DesktopMailReview>;
  const id = optionalString(input.id);
  const accountId = optionalString(input.accountId);
  const messageId = optionalString(input.messageId);
  const receivedAt = optionalString(input.receivedAt);
  if (!id || !accountId || !messageId || !receivedAt || !Number.isFinite(Date.parse(receivedAt))) return undefined;
  const stage = MAIL_REVIEW_STAGES.has(input.selectedStage as DesktopMailReviewStage)
    ? input.selectedStage as DesktopMailReviewStage
    : undefined;
  const suggestedStage = MAIL_REVIEW_STAGES.has(input.suggestedStage as DesktopMailReviewStage)
    ? input.suggestedStage as DesktopMailReviewStage
    : undefined;
  return {
    id,
    accountId,
    messageId,
    from: optionalString(input.from) ?? '',
    subject: optionalString(input.subject) ?? '',
    receivedAt,
    summary: optionalString(input.summary) ?? '',
    category: optionalString(input.category) ?? 'unknown',
    suggestedStage,
    companyName: optionalString(input.companyName),
    candidateRecordIds: Array.isArray(input.candidateRecordIds)
      ? input.candidateRecordIds.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : [],
    extractedAt: optionalString(input.extractedAt),
    deadlineAt: optionalString(input.deadlineAt),
    actionUrl: optionalString(input.actionUrl),
    state: MAIL_REVIEW_STATES.has(input.state ?? '')
      ? input.state as DesktopMailReview['state']
      : 'pending',
    reviewedAt: optionalString(input.reviewedAt),
    selectedRecordId: optionalString(input.selectedRecordId),
    selectedStage: stage,
  };
}

function normalizeSourceBackup(value: unknown): BackupDocument | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const parsed = parseAndValidateBackup(JSON.stringify(value));
  return parsed.success ? parsed.document : undefined;
}

export function normalizeDesktopData(value: unknown): DesktopData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyData();
  const input = value as Partial<DesktopData>;
  const records = normalizeApplicationRecords(input.records);
  const recordIds = new Set(records.map(record => record.id));
  return {
    schemaVersion: DESKTOP_DATA_SCHEMA_VERSION,
    records,
    favoriteRecordIds: Array.isArray(input.favoriteRecordIds)
      ? [...new Set(input.favoriteRecordIds.filter(
          (id): id is string => typeof id === 'string' && recordIds.has(id),
        ))]
      : [],
    careerFairs: normalizeCareerFairs(input.careerFairs),
    sourceBackup: normalizeSourceBackup(input.sourceBackup),
    webdav: normalizeWebDav(input.webdav),
    mobileSync: normalizeMobileSync(input.mobileSync),
    desktopReminder: normalizeDesktopReminder(input.desktopReminder),
    mailInbox: normalizeMailInbox(input.mailInbox),
    sync: normalizeSyncState(input.sync),
  };
}

export class DesktopStore {
  readonly filePath: string;
  readonly backupPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
  }

  async read(): Promise<DesktopData> {
    try {
      return normalizeDesktopData(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyData();
      return this.readBackup(error);
    }
  }

  async write(data: DesktopData): Promise<void> {
    const normalized = normalizeDesktopData(data);
    await this.writePrimary(normalized, true);
  }

  private async writePrimary(data: DesktopData, preserveCurrent: boolean): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      if (preserveCurrent) await copyFile(this.filePath, this.backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  private async readBackup(primaryError: unknown): Promise<DesktopData> {
    try {
      const recovered = normalizeDesktopData(JSON.parse(await readFile(this.backupPath, 'utf8')));
      console.error('桌面端主数据文件读取失败，已使用备份恢复', primaryError);
      await this.writePrimary(recovered, false);
      return recovered;
    } catch {
      throw new Error('桌面端本地数据损坏，且备份文件无法恢复');
    } finally {
      await rm(`${this.filePath}.tmp`, { force: true }).catch(() => undefined);
    }
  }
}
