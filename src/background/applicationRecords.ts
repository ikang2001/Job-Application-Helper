import {
  areApplicationRecordCsvSummariesEqual,
  createApplicationRecordDraft,
  findApplicationRecordDuplicate,
  mergeApplicationRecordUpdate,
  normalizeApplicationRecord,
  parseApplicationRecordsCsv,
  serializeApplicationRecordsCsv,
} from '../shared/applicationRecords.ts';
import {
  mutateApplicationRecords,
  readApplicationRecords,
  removeApplicationEventFromRecord,
  restoreApplicationEventSource,
} from '../shared/applicationRecordRepository.ts';
import type {
  ApplicationPageMetadata,
  ApplicationRecord,
  ApplicationRecordDraft,
  ApplicationEventTombstoneReason,
  Message,
  MessageResponse,
} from '../shared/types.ts';

export const APPLICATION_RECORD_DRAFTS_STORAGE_KEY = 'applicationRecordDrafts';
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredApplicationRecordDraft {
  draft: ApplicationRecordDraft;
  expiresAt: string;
}

function createDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildExportFilename(date = new Date()): string {
  const compact = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `application-records-${compact}.csv`;
}

async function requestApplicationPageMetadata(
  tabId: number,
  tabUrl: string,
): Promise<MessageResponse<ApplicationPageMetadata>> {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'GET_APPLICATION_PAGE_METADATA',
    payload: null,
  } satisfies Message) as MessageResponse<ApplicationPageMetadata>;

  if (!response.success || !response.data) {
    return {
      success: false,
      error: response.error || '未能提取当前页面投递信息',
    };
  }

  return {
    success: true,
    data: {
      ...response.data,
      sourceUrl: response.data.sourceUrl || tabUrl,
      sourceSite: response.data.sourceSite || new URL(tabUrl).host,
    },
  };
}

export async function handleCreateApplicationRecordDraft(
  tabId: number,
): Promise<MessageResponse<{ draftId: string }>> {
  const tab = await chrome.tabs.get(tabId);
  const tabUrl = tab.url?.trim();
  if (!tabUrl) {
    return { success: false, error: '当前标签页缺少可用链接' };
  }

  const metadataResponse = await requestApplicationPageMetadata(tabId, tabUrl);
  if (!metadataResponse.success || !metadataResponse.data) {
    return { success: false, error: metadataResponse.error || '创建投递草稿失败' };
  }

  const draftId = createDraftId();
  const now = new Date();
  const stored = await readDrafts(now);
  stored[draftId] = {
    draft: createApplicationRecordDraft(now.toISOString(), metadataResponse.data),
    expiresAt: new Date(now.getTime() + DRAFT_TTL_MS).toISOString(),
  };
  await chrome.storage.local.set({ [APPLICATION_RECORD_DRAFTS_STORAGE_KEY]: stored });
  return { success: true, data: { draftId } };
}

export async function handleGetApplicationRecordDraft(
  draftId: string,
): Promise<MessageResponse<{ draft: ApplicationRecordDraft; duplicate: ApplicationRecord | null }>> {
  const stored = await readDrafts(new Date());
  const entry = stored[draftId];
  if (!entry) {
    return { success: false, error: '投递草稿不存在' };
  }
  const draft = entry.draft;

  const records = await readApplicationRecords();
  const duplicate = findApplicationRecordDuplicate(records, draft);
  return {
    success: true,
    data: {
      draft,
      duplicate,
    },
  };
}

async function readDrafts(now: Date): Promise<Record<string, StoredApplicationRecordDraft>> {
  const result = await chrome.storage.local.get(APPLICATION_RECORD_DRAFTS_STORAGE_KEY);
  const input = result[APPLICATION_RECORD_DRAFTS_STORAGE_KEY];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input as Record<string, unknown>).filter((entry): entry is [string, StoredApplicationRecordDraft] => {
    const value = entry[1];
    return value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && 'draft' in value
      && 'expiresAt' in value
      && typeof value.expiresAt === 'string'
      && Date.parse(value.expiresAt) > now.getTime();
  }));
}

export async function handleGetApplicationRecords(): Promise<MessageResponse<ApplicationRecord[]>> {
  return {
    success: true,
    data: await readApplicationRecords(),
  };
}

export async function handleCreateApplicationRecord(
  record: ApplicationRecord,
): Promise<MessageResponse<{ duplicate: ApplicationRecord | null }>> {
  const duplicate = await mutateApplicationRecords((records) => {
    const normalized = normalizeApplicationRecord(record);
    const duplicateRecord = findApplicationRecordDuplicate(
      records.filter(existingRecord => existingRecord.id !== normalized.id),
      normalized,
    );
    const existingIndex = records.findIndex(existingRecord => existingRecord.id === normalized.id);
    if (existingIndex < 0) {
      return {
        records: [...records, normalized],
        result: duplicateRecord,
      };
    }

    const nextRecords = [...records];
    nextRecords[existingIndex] = mergeApplicationRecordUpdate(records[existingIndex], record);
    return { records: nextRecords, result: duplicateRecord };
  });
  return {
    success: true,
    data: { duplicate },
  };
}

export async function handleUpdateApplicationRecord(record: ApplicationRecord): Promise<MessageResponse> {
  await mutateApplicationRecords((records) => {
    const recordIndex = records.findIndex(existingRecord => existingRecord.id === record.id);
    if (recordIndex < 0) return { records, result: undefined, write: false };
    const nextRecords = [...records];
    nextRecords[recordIndex] = mergeApplicationRecordUpdate(records[recordIndex], record);
    return { records: nextRecords, result: undefined };
  });
  return { success: true };
}

export async function handleDeleteApplicationRecord(id: string): Promise<MessageResponse> {
  await mutateApplicationRecords(records => ({
    records: records.filter(record => record.id !== id),
    result: undefined,
  }));
  return { success: true };
}

export async function handleRemoveApplicationEvent(
  recordId: string,
  sourceKey: string,
  reason: ApplicationEventTombstoneReason,
): Promise<MessageResponse> {
  const result = await removeApplicationEventFromRecord(
    recordId,
    sourceKey,
    reason,
    new Date().toISOString(),
  );
  return result.record
    ? { success: true, data: result }
    : { success: false, error: '投递记录或事件不存在' };
}

export async function handleRestoreApplicationEventSource(
  recordId: string,
  sourceKey: string,
): Promise<MessageResponse> {
  return { success: true, data: { restored: await restoreApplicationEventSource(recordId, sourceKey) } };
}

export async function handleExportApplicationRecordsCsv(): Promise<MessageResponse<{ csv: string; filename: string }>> {
  const records = await readApplicationRecords();
  return {
    success: true,
    data: {
      csv: serializeApplicationRecordsCsv(records),
      filename: buildExportFilename(),
    },
  };
}

export async function handleImportApplicationRecordsCsv(
  csv: string,
): Promise<MessageResponse<{ imported: number; warnings: string[] }>> {
  const { records, warnings, error } = parseApplicationRecordsCsv(csv);
  if (error) {
    return {
      success: false,
      error,
    };
  }
  const imported = await mutateApplicationRecords((existingRecords) => {
    const nextRecords = [...existingRecords];
    let importedCount = 0;
    records.forEach((record, index) => {
      const duplicate = nextRecords.find(existingRecord => existingRecord.id === record.id)
        ?? findApplicationRecordDuplicate(nextRecords, record);
      if (duplicate) {
        const difference = areApplicationRecordCsvSummariesEqual(duplicate, record)
          ? '内容完全相同，已跳过'
          : '摘要字段存在差异，已跳过并保留现有记录';
        warnings.push(
          `第 ${index + 2} 行与已有记录重复（${difference}）：${record.companyName || '未命名公司'} ${record.sourceUrl || '(缺少链接)'}`,
        );
        return;
      }
      nextRecords.push(record);
      importedCount += 1;
    });
    return { records: nextRecords, result: importedCount, write: importedCount > 0 };
  });
  return {
    success: true,
    data: {
      imported,
      warnings,
    },
  };
}
