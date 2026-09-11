import { normalizeApplicationRecords } from '../shared/applicationRecords.ts';
import { StorageService, STORAGE_KEYS } from '../shared/storage.ts';
import type { ApplicationRecord, LocalDesktopSyncState } from '../shared/types.ts';

export const LOCAL_DESKTOP_SYNC_ALARM_NAME = 'job-application-helper-local-desktop-sync';
export const LOCAL_DESKTOP_SYNC_PERIOD_MINUTES = 1;
export const LOCAL_DESKTOP_SYNC_STATUS_KEY = 'localDesktopSyncStatus';
const NATIVE_HOST_NAME = 'com.job_application_helper.mail';

interface NativeResponse<T> {
  protocolVersion: 1;
  requestId: string;
  success: boolean;
  data?: T;
  error?: { code: string; message: string; retryable: boolean };
}

interface LocalRecordsMeta {
  revision: number;
  updatedAt: string;
  writer: 'edge' | 'desktop';
  recordCount: number;
  sizeBytes: number;
  chunkBytes: number;
  chunkCount: number;
  sha256: string;
  filePath: string;
}

interface LocalRecordsChunk {
  revision: number;
  index: number;
  chunkCount: number;
  base64: string;
}

interface LocalRecordsDocument {
  schemaVersion: 1;
  revision: number;
  records: unknown[];
}

export class LocalDesktopSyncService {
  private queue: Promise<LocalDesktopSyncState> = Promise.resolve({ status: 'checking' });

  getStatus(): Promise<LocalDesktopSyncState> {
    return chrome.storage.local.get(LOCAL_DESKTOP_SYNC_STATUS_KEY).then(result => (
      normalizeStatus(result[LOCAL_DESKTOP_SYNC_STATUS_KEY])
    ));
  }

  requestSync(deletedIds: readonly string[] = []): Promise<LocalDesktopSyncState> {
    const deletedAt = new Date().toISOString();
    const tombstones = [...new Set(deletedIds.filter(Boolean))].map(id => ({ id, deletedAt }));
    const operation = () => this.perform(tombstones);
    const result = this.queue.then(operation, operation);
    this.queue = result;
    return result;
  }

  private async perform(tombstones: Array<{ id: string; deletedAt: string }>): Promise<LocalDesktopSyncState> {
    await this.saveStatus({ status: 'syncing' });
    try {
      const records = await StorageService.getApplicationRecords();
      await sendNativeRequest<LocalRecordsMeta>({
        type: 'MERGE_APPLICATION_RECORDS',
        writer: 'edge',
        records,
        tombstones,
      });
      const { document, meta } = await this.readSharedDocument();
      const mergedRecords = normalizeApplicationRecords(document.records);
      if (!areRecordSnapshotsEqual(records, mergedRecords)) {
        await StorageService.saveApplicationRecords(mergedRecords);
      }
      return this.saveStatus({
        status: 'synced',
        lastSyncedAt: new Date().toISOString(),
        revision: meta.revision,
        recordCount: mergedRecords.length,
        filePath: meta.filePath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '本机桌面同步失败';
      return this.saveStatus({
        status: isNativeHostUnavailable(message) ? 'unavailable' : 'error',
        lastError: message,
      });
    }
  }

  private async readSharedDocument(): Promise<{ document: LocalRecordsDocument; meta: LocalRecordsMeta }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const meta = await sendNativeRequest<LocalRecordsMeta>({ type: 'GET_APPLICATION_RECORDS_META' });
        const bytes = new Uint8Array(meta.sizeBytes);
        let offset = 0;
        for (let index = 0; index < meta.chunkCount; index += 1) {
          const chunk = await sendNativeRequest<LocalRecordsChunk>({
            type: 'GET_APPLICATION_RECORDS_CHUNK',
            revision: meta.revision,
            index,
          });
          const decoded = decodeBase64(chunk.base64);
          bytes.set(decoded, offset);
          offset += decoded.length;
        }
        if (offset !== meta.sizeBytes) throw new Error('本机投递记录分块长度不一致');
        if (await sha256Hex(bytes) !== meta.sha256) throw new Error('本机投递记录完整性校验失败');
        return { document: parseSharedDocument(new TextDecoder().decode(bytes), meta.revision), meta };
      } catch (error) {
        if (attempt === 0 && isStaleRevision(error)) continue;
        throw error;
      }
    }
    throw new Error('本机投递记录持续发生变化，请稍后重试');
  }

  private async saveStatus(status: LocalDesktopSyncState): Promise<LocalDesktopSyncState> {
    await chrome.storage.local.set({ [LOCAL_DESKTOP_SYNC_STATUS_KEY]: status });
    return status;
  }
}

export function findDeletedRecordIds(
  previousInput: unknown,
  nextInput: unknown,
): string[] {
  const previous = normalizeApplicationRecords(previousInput);
  const nextIds = new Set(normalizeApplicationRecords(nextInput).map(record => record.id));
  return previous.filter(record => !nextIds.has(record.id)).map(record => record.id);
}

export function areRecordSnapshotsEqual(
  left: readonly ApplicationRecord[],
  right: readonly ApplicationRecord[],
): boolean {
  return JSON.stringify(normalizeApplicationRecords(left).sort(byRecordId))
    === JSON.stringify(normalizeApplicationRecords(right).sort(byRecordId));
}

export async function ensureLocalDesktopSyncAlarm(
  alarms: Pick<typeof chrome.alarms, 'get' | 'create'>,
): Promise<void> {
  if (await alarms.get(LOCAL_DESKTOP_SYNC_ALARM_NAME)) return;
  await alarms.create(LOCAL_DESKTOP_SYNC_ALARM_NAME, {
    delayInMinutes: LOCAL_DESKTOP_SYNC_PERIOD_MINUTES,
    periodInMinutes: LOCAL_DESKTOP_SYNC_PERIOD_MINUTES,
  });
}

function normalizeStatus(value: unknown): LocalDesktopSyncState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'checking' };
  const input = value as Partial<LocalDesktopSyncState>;
  const statuses = new Set<LocalDesktopSyncState['status']>([
    'checking', 'syncing', 'synced', 'unavailable', 'error',
  ]);
  return {
    status: statuses.has(input.status as LocalDesktopSyncState['status'])
      ? input.status as LocalDesktopSyncState['status']
      : 'checking',
    lastSyncedAt: optionalString(input.lastSyncedAt),
    lastError: optionalString(input.lastError),
    filePath: optionalString(input.filePath),
    revision: typeof input.revision === 'number' ? input.revision : undefined,
    recordCount: typeof input.recordCount === 'number' ? input.recordCount : undefined,
  };
}

async function sendNativeRequest<T>(payload: Record<string, unknown>): Promise<T> {
  let response: NativeResponse<T>;
  try {
    response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      protocolVersion: 1,
      requestId: globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}`,
      ...payload,
    }) as NativeResponse<T>;
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法连接本地组件';
    throw new Error(/host.*not found|not registered/i.test(message) ? '本地组件未安装或未注册到 Edge' : message);
  }
  if (!response.success || response.data === undefined) {
    const error = new Error(response.error?.message || '本地组件调用失败');
    error.name = response.error?.code || 'NATIVE_ERROR';
    throw error;
  }
  return response.data;
}

function parseSharedDocument(raw: string, expectedRevision: number): LocalRecordsDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('本机投递记录不是有效 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('本机投递记录格式无效');
  }
  const document = value as Partial<LocalRecordsDocument>;
  if (
    document.schemaVersion !== 1
    || document.revision !== expectedRevision
    || !Array.isArray(document.records)
  ) {
    throw new Error('本机投递记录版本不一致');
  }
  return document as LocalRecordsDocument;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function isStaleRevision(error: unknown): boolean {
  return error instanceof Error && error.name === 'STALE_REVISION';
}

function isNativeHostUnavailable(message: string): boolean {
  return /未安装|未注册|native messaging host|specified native messaging host|host.*not found/i.test(message);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function byRecordId(left: ApplicationRecord, right: ApplicationRecord): number {
  return left.id.localeCompare(right.id);
}

export function isApplicationRecordsStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): boolean {
  return areaName === 'local' && Object.hasOwn(changes, STORAGE_KEYS.APPLICATION_RECORDS);
}
