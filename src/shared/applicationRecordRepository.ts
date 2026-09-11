import {
  addApplicationEvent,
  createApplicationEventTombstone,
  isApplicationEventSuppressed,
  normalizeApplicationEvent,
  normalizeApplicationEventTombstones,
  removeApplicationEvent,
  removeApplicationEventTombstone,
} from './applicationEvents.ts';
import { normalizeApplicationRecord, normalizeApplicationRecords } from './applicationRecords.ts';
import { StorageService, STORAGE_KEYS } from './storage.ts';
import type {
  ApplicationEvent,
  ApplicationEventTombstone,
  ApplicationEventTombstoneReason,
  ApplicationRecord,
} from './types.ts';

export const APPLICATION_EVENT_TOMBSTONES_STORAGE_KEY = 'applicationEventTombstones';

let mutationQueue: Promise<void> = Promise.resolve();

/** Global FIFO for every application-record read-modify-write transaction in this worker. */
export function withApplicationRecordMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export interface ApplicationRecordsMutation<T> {
  records: readonly ApplicationRecord[];
  result: T;
  write?: boolean;
}

export function mutateApplicationRecords<T>(
  mutation: (records: ApplicationRecord[]) => ApplicationRecordsMutation<T> | Promise<ApplicationRecordsMutation<T>>,
): Promise<T> {
  return withApplicationRecordMutation(async () => {
    const current = await StorageService.getApplicationRecords();
    const outcome = await mutation(current);
    if (outcome.write !== false) {
      await StorageService.saveApplicationRecords([...outcome.records]);
    }
    return outcome.result;
  });
}

export async function readApplicationRecords(): Promise<ApplicationRecord[]> {
  const pendingMutations = mutationQueue;
  await pendingMutations;
  return StorageService.getApplicationRecords();
}

export function replaceApplicationRecords(records: readonly ApplicationRecord[]): Promise<void> {
  return withApplicationRecordMutation(() => StorageService.saveApplicationRecords([...records]));
}

async function readEventTombstonesUnlocked(): Promise<ApplicationEventTombstone[]> {
  const result = await chrome.storage.local.get(APPLICATION_EVENT_TOMBSTONES_STORAGE_KEY);
  return normalizeApplicationEventTombstones(result[APPLICATION_EVENT_TOMBSTONES_STORAGE_KEY]);
}

export async function readApplicationEventTombstones(): Promise<ApplicationEventTombstone[]> {
  const pendingMutations = mutationQueue;
  await pendingMutations;
  return readEventTombstonesUnlocked();
}

async function saveRecordsAndTombstones(
  records: readonly ApplicationRecord[],
  tombstones: readonly ApplicationEventTombstone[],
): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.APPLICATION_RECORDS]: normalizeApplicationRecords(records),
    [APPLICATION_EVENT_TOMBSTONES_STORAGE_KEY]: normalizeApplicationEventTombstones(tombstones),
  });
}

export interface AppendApplicationEventResult {
  record: ApplicationRecord | null;
  added: boolean;
  suppressed: boolean;
}

export function appendApplicationEventToRecord(
  recordId: string,
  eventInput: ApplicationEvent,
  updatedAt = eventInput.occurredAt,
  now = new Date(),
): Promise<AppendApplicationEventResult> {
  return withApplicationRecordMutation(async () => {
    const [records, tombstones] = await Promise.all([
      StorageService.getApplicationRecords(),
      readEventTombstonesUnlocked(),
    ]);
    const recordIndex = records.findIndex(record => record.id === recordId);
    if (recordIndex < 0) return { record: null, added: false, suppressed: false };

    const event = normalizeApplicationEvent(eventInput, recordId);
    const canBeSuppressed = event.source === 'website' || event.source === 'email';
    if (canBeSuppressed && isApplicationEventSuppressed(tombstones, recordId, event.sourceKey, now)) {
      return { record: records[recordIndex]!, added: false, suppressed: true };
    }
    const current = records[recordIndex]!;
    const updated = addApplicationEvent(current, event, updatedAt);
    if (updated === current) return { record: current, added: false, suppressed: false };

    const nextRecords = [...records];
    nextRecords[recordIndex] = updated;
    await StorageService.saveApplicationRecords(nextRecords);
    return { record: updated, added: true, suppressed: false };
  });
}

export interface RemoveApplicationEventResult {
  record: ApplicationRecord | null;
  removed: boolean;
  tombstoneCreated: boolean;
}

export function removeApplicationEventFromRecord(
  recordId: string,
  sourceKey: string,
  reason: ApplicationEventTombstoneReason,
  removedAt: string,
  expiresAt?: string,
): Promise<RemoveApplicationEventResult> {
  return withApplicationRecordMutation(async () => {
    const [records, tombstones] = await Promise.all([
      StorageService.getApplicationRecords(),
      readEventTombstonesUnlocked(),
    ]);
    const recordIndex = records.findIndex(record => record.id === recordId);
    if (recordIndex < 0) return { record: null, removed: false, tombstoneCreated: false };

    const current = normalizeApplicationRecord(records[recordIndex]);
    const event = current.events.find(item => item.sourceKey === sourceKey);
    if (!event) return { record: current, removed: false, tombstoneCreated: false };

    const updated = removeApplicationEvent(current, sourceKey, removedAt);
    const shouldSuppress = event.source === 'website' || event.source === 'email';
    const nextTombstones = shouldSuppress
      ? normalizeApplicationEventTombstones([
          ...tombstones,
          createApplicationEventTombstone(recordId, sourceKey, reason, removedAt, expiresAt),
        ])
      : tombstones;
    const nextRecords = [...records];
    nextRecords[recordIndex] = updated;
    await saveRecordsAndTombstones(nextRecords, nextTombstones);
    return { record: updated, removed: true, tombstoneCreated: shouldSuppress };
  });
}

/** Persists an ignored/unlinked automatic source even when no event was accepted yet. */
export function suppressApplicationEventSource(
  recordId: string,
  sourceKey: string,
  reason: ApplicationEventTombstoneReason,
  createdAt: string,
  expiresAt?: string,
): Promise<ApplicationEventTombstone> {
  if (sourceKey.startsWith('manual:') || sourceKey.startsWith('migration:')) {
    return Promise.reject(new Error('只允许抑制网站或邮件自动事件来源'));
  }
  return withApplicationRecordMutation(async () => {
    const tombstones = await readEventTombstonesUnlocked();
    const tombstone = createApplicationEventTombstone(recordId, sourceKey, reason, createdAt, expiresAt);
    await chrome.storage.local.set({
      [APPLICATION_EVENT_TOMBSTONES_STORAGE_KEY]: normalizeApplicationEventTombstones([
        ...tombstones,
        tombstone,
      ]),
    });
    return tombstone;
  });
}

/** Explicit restore path: only removing the persisted tombstone allows that source to be ingested again. */
export function restoreApplicationEventSource(recordId: string, sourceKey: string): Promise<boolean> {
  return withApplicationRecordMutation(async () => {
    const tombstones = await readEventTombstonesUnlocked();
    const restored = removeApplicationEventTombstone(tombstones, recordId, sourceKey);
    if (restored.length === tombstones.length) return false;
    await chrome.storage.local.set({ [APPLICATION_EVENT_TOMBSTONES_STORAGE_KEY]: restored });
    return true;
  });
}

export class ApplicationRecordRepository {
  list(): Promise<ApplicationRecord[]> {
    return readApplicationRecords();
  }

  mutate<T>(
    mutation: (records: ApplicationRecord[]) => ApplicationRecordsMutation<T> | Promise<ApplicationRecordsMutation<T>>,
  ): Promise<T> {
    return mutateApplicationRecords(mutation);
  }

  appendEvent(
    recordId: string,
    event: ApplicationEvent,
    updatedAt = event.occurredAt,
    now = new Date(),
  ): Promise<AppendApplicationEventResult> {
    return appendApplicationEventToRecord(recordId, event, updatedAt, now);
  }

  removeEvent(
    recordId: string,
    sourceKey: string,
    reason: ApplicationEventTombstoneReason,
    removedAt: string,
    expiresAt?: string,
  ): Promise<RemoveApplicationEventResult> {
    return removeApplicationEventFromRecord(recordId, sourceKey, reason, removedAt, expiresAt);
  }

  restoreEventSource(recordId: string, sourceKey: string): Promise<boolean> {
    return restoreApplicationEventSource(recordId, sourceKey);
  }
}
