import {
  areApplicationRecordCsvSummariesEqual,
  findApplicationRecordDuplicate,
  mergeApplicationRecordUpdate,
  normalizeApplicationRecord,
  normalizeApplicationRecords,
  normalizeRecruitmentSchedule,
  parseApplicationRecordsCsv,
} from '../../../src/shared/applicationRecords.ts';
import { createApplicationEvent, isApplicationRecordStatus } from '../../../src/shared/applicationEvents.ts';
import type {
  ApplicationEventType,
  ApplicationRecord,
  ApplicationRecordStatus,
  BackupDocument,
} from '../../../src/shared/types.ts';
import { parseAndValidateBackup } from '../../../src/shared/backup.ts';
import type {
  CareerFair,
  DesktopRecordInput,
} from '../shared/contracts.ts';
import { normalizeCareerFairs } from './careerFairs.ts';

export const DESKTOP_EXPORT_SCHEMA_VERSION = 1;
export const DESKTOP_EXPORT_SOURCE = 'job-application-helper-desktop';

interface DesktopExportDocument {
  schemaVersion: 1;
  source: typeof DESKTOP_EXPORT_SOURCE;
  exportedAt: string;
  applicationRecords: ApplicationRecord[];
  careerFairs?: CareerFair[];
}

export interface ParsedDesktopImport {
  records: ApplicationRecord[];
  careerFairs?: CareerFair[];
  sourceBackup?: BackupDocument;
  warnings: string[];
}

export interface CsvMergeResult {
  records: ApplicationRecord[];
  imported: number;
  warnings: string[];
}

const STATUS_EVENT_TYPE: Record<ApplicationRecordStatus, ApplicationEventType> = {
  待投递: 'application_created',
  已投递: 'applied',
  等待中: 'status_override',
  '笔试/测评': 'assessment_invite',
  面试中: 'interview',
  offer: 'offer',
  主动放弃: 'withdrawn',
  职位关闭: 'job_closed',
  终止: 'status_override',
};

function recordId(): string {
  return crypto.randomUUID();
}

function trimmedInput(input: DesktopRecordInput): DesktopRecordInput {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => (
    [key, typeof value === 'string' ? value.trim() : value]
  ))) as unknown as DesktopRecordInput;
}

export function desktopRecordInput(record: ApplicationRecord): DesktopRecordInput {
  return {
    id: record.id,
    companyName: record.companyName,
    jobTitle: record.jobTitle,
    sourceSite: record.sourceSite,
    sourceUrl: record.sourceUrl,
    status: record.status,
    notes: record.notes,
    appliedAt: record.appliedAt,
    location: record.location,
    applicationEmail: record.applicationEmail,
    jobId: record.jobId,
    applicationId: record.applicationId,
    employmentType: record.employmentType,
    recruitmentSchedule: record.recruitmentSchedule,
  };
}

export function validateDesktopRecordInput(value: unknown): DesktopRecordInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('投递记录格式无效');
  }
  const input = value as Record<string, unknown>;
  const requiredFields = [
    'companyName', 'jobTitle', 'sourceSite', 'sourceUrl', 'status', 'notes', 'appliedAt', 'location',
  ] as const;
  const optionalFields = ['id', 'applicationEmail', 'jobId', 'applicationId', 'employmentType'] as const;
  for (const field of requiredFields) {
    if (typeof input[field] !== 'string') throw new Error(`投递记录字段 ${field} 必须是字符串`);
  }
  for (const field of optionalFields) {
    if (input[field] !== undefined && typeof input[field] !== 'string') {
      throw new Error(`投递记录字段 ${field} 必须是字符串`);
    }
  }
  if (!isApplicationRecordStatus(input.status)) throw new Error('投递状态无效');
  const normalized = {
    ...trimmedInput(input as unknown as DesktopRecordInput),
    recruitmentSchedule: validateRecruitmentSchedule(input.recruitmentSchedule),
  };
  if (!normalized.companyName || !normalized.jobTitle) throw new Error('公司名称和岗位名称不能为空');
  if (normalized.notes.length > 100_000) throw new Error('备注超过 100000 字符上限');
  const boundedFields = [...requiredFields, ...optionalFields].filter(field => field !== 'notes');
  if (boundedFields.some(field => String(normalized[field] ?? '').length > 2_000)) {
    throw new Error('投递记录字段超过 2000 字符上限');
  }
  if (normalized.appliedAt && !/^\d{4}-\d{2}-\d{2}$/.test(normalized.appliedAt)) {
    throw new Error('投递日期格式无效');
  }
  if (normalized.sourceUrl) {
    try {
      const url = new URL(normalized.sourceUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('职位链接只支持 HTTP 或 HTTPS');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('只支持')) throw error;
      throw new Error('职位链接格式无效');
    }
  }
  return normalized;
}

function validateRecruitmentSchedule(value: unknown): DesktopRecordInput['recruitmentSchedule'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('笔试、测评与面试安排格式无效');
  }
  const rawSchedule = value as Record<string, unknown>;
  for (const kind of ['writtenTest', 'assessment', 'interview'] as const) {
    validateRawScheduleEntry(rawSchedule[kind]);
  }
  const rawInterviews = rawSchedule.interviews;
  if (rawInterviews !== undefined) {
    if (!rawInterviews || typeof rawInterviews !== 'object' || Array.isArray(rawInterviews)) {
      throw new Error('笔试、测评与面试安排格式无效');
    }
    const rounds = rawInterviews as Record<string, unknown>;
    for (const kind of ['ai', 'first', 'second', 'third', 'hr'] as const) {
      validateRawScheduleEntry(rounds[kind]);
    }
  }
  const normalized = normalizeRecruitmentSchedule(value);
  for (const [label, entry] of [
    ['笔试', normalized?.writtenTest],
    ['测评', normalized?.assessment],
    ['AI面', normalized?.interviews?.ai],
    ['一面', normalized?.interviews?.first],
    ['二面', normalized?.interviews?.second],
    ['三面', normalized?.interviews?.third],
    ['HR面', normalized?.interviews?.hr],
  ] as const) {
    if (!entry) continue;
    if (entry.scheduledAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(entry.scheduledAt)) {
      throw new Error(`${label}时间格式无效`);
    }
    if (entry.completedAt && !Number.isFinite(Date.parse(entry.completedAt))) {
      throw new Error(`${label}完成时间格式无效`);
    }
    if (entry.url) validateHttpUrl(entry.url, `${label}链接`);
  }
  return normalized;
}

function validateRawScheduleEntry(entry: unknown): void {
  if (entry === undefined) return;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('笔试、测评与面试安排格式无效');
  }
  const rawEntry = entry as Record<string, unknown>;
  for (const field of ['scheduledAt', 'url', 'completedAt'] as const) {
    if (rawEntry[field] !== undefined && typeof rawEntry[field] !== 'string') {
      throw new Error('笔试、测评与面试安排字段必须是字符串');
    }
  }
  if (rawEntry.timeKind !== undefined && rawEntry.timeKind !== 'start' && rawEntry.timeKind !== 'deadline') {
    throw new Error('笔试、测评与面试安排时间类型无效');
  }
}

function validateHttpUrl(value: string, label: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`${label}只支持 HTTP 或 HTTPS`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('只支持')) throw error;
    throw new Error(`${label}格式无效`);
  }
}

function initialEvent(id: string, status: ApplicationRecordStatus, occurredAt: string) {
  const type = STATUS_EVENT_TYPE[status];
  return createApplicationEvent({
    type,
    occurredAt,
    source: 'manual',
    title: status === '待投递' ? '创建投递计划' : `手动记录：${status}`,
    sourceKey: `manual:${id}:created`,
    metadata: type === 'status_override' ? { status } : undefined,
  });
}

export function saveDesktopRecord(
  recordsInput: readonly ApplicationRecord[],
  inputValue: DesktopRecordInput,
  nowIso = new Date().toISOString(),
): { records: ApplicationRecord[]; record: ApplicationRecord; duplicate: ApplicationRecord | null } {
  const records = normalizeApplicationRecords(recordsInput);
  const input = validateDesktopRecordInput(inputValue);
  const current = input.id ? records.find(record => record.id === input.id) : undefined;
  const id = current?.id ?? recordId();
  const occurredAt = input.appliedAt || nowIso;
  const candidate = current
    ? mergeApplicationRecordUpdate(current, { ...current, ...input, id, updatedAt: nowIso })
    : normalizeApplicationRecord({
        ...input,
        id,
        events: [initialEvent(id, input.status, occurredAt)],
        createdAt: nowIso,
        updatedAt: nowIso,
      });
  const duplicate = findApplicationRecordDuplicate(
    records.filter(record => record.id !== candidate.id),
    candidate,
  );
  const next = current
    ? records.map(record => record.id === candidate.id ? candidate : record)
    : [...records, candidate];
  return { records: next, record: candidate, duplicate };
}

export function deleteDesktopRecord(
  recordsInput: readonly ApplicationRecord[],
  id: string,
): ApplicationRecord[] {
  const normalizedId = id.trim();
  if (!normalizedId) throw new Error('投递记录 ID 不能为空');
  return normalizeApplicationRecords(recordsInput).filter(record => record.id !== normalizedId);
}

function isDesktopExport(value: unknown): value is DesktopExportDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const document = value as Partial<DesktopExportDocument>;
  return document.schemaVersion === DESKTOP_EXPORT_SCHEMA_VERSION
    && document.source === DESKTOP_EXPORT_SOURCE
    && typeof document.exportedAt === 'string'
    && Array.isArray(document.applicationRecords);
}

export function serializeDesktopRecords(
  records: readonly ApplicationRecord[],
  exportedAt = new Date().toISOString(),
): string {
  const document: DesktopExportDocument = {
    schemaVersion: DESKTOP_EXPORT_SCHEMA_VERSION,
    source: DESKTOP_EXPORT_SOURCE,
    exportedAt,
    applicationRecords: normalizeApplicationRecords(records),
  };
  return JSON.stringify(document, null, 2);
}

export function serializeDesktopData(
  records: readonly ApplicationRecord[],
  careerFairs: readonly CareerFair[],
  exportedAt = new Date().toISOString(),
): string {
  const document: DesktopExportDocument = {
    schemaVersion: DESKTOP_EXPORT_SCHEMA_VERSION,
    source: DESKTOP_EXPORT_SOURCE,
    exportedAt,
    applicationRecords: normalizeApplicationRecords(records),
    careerFairs: normalizeCareerFairs(careerFairs),
  };
  return JSON.stringify(document, null, 2);
}

export function parseDesktopRecordsJson(raw: string): ParsedDesktopImport {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  if (isDesktopExport(value)) {
    return {
      records: normalizeApplicationRecords(value.applicationRecords),
      careerFairs: Array.isArray(value.careerFairs) ? normalizeCareerFairs(value.careerFairs) : undefined,
      warnings: [],
    };
  }
  const parsed = parseAndValidateBackup(raw);
  if (!parsed.success) throw new Error(parsed.error.message);
  return {
    records: normalizeApplicationRecords(parsed.document.data.applicationRecords ?? []),
    sourceBackup: parsed.document,
    warnings: parsed.document.legacySecrets
      ? ['旧版备份中的密钥和 WebDAV 凭据不会导入桌面端']
      : [],
  };
}

export function mergeDesktopCsv(
  currentInput: readonly ApplicationRecord[],
  csv: string,
): CsvMergeResult {
  const current = normalizeApplicationRecords(currentInput);
  const parsed = parseApplicationRecordsCsv(csv);
  if (parsed.error) throw new Error(parsed.error);
  const records = [...current];
  const warnings = [...parsed.warnings];
  let imported = 0;
  parsed.records.forEach((record, index) => {
    const duplicate = records.find(item => item.id === record.id)
      ?? findApplicationRecordDuplicate(records, record);
    if (duplicate) {
      const reason = areApplicationRecordCsvSummariesEqual(duplicate, record)
        ? '内容完全相同'
        : '摘要字段存在差异';
      warnings.push(`第 ${index + 2} 行与已有记录重复（${reason}），已保留现有记录`);
      return;
    }
    records.push(record);
    imported += 1;
  });
  return { records, imported, warnings };
}
