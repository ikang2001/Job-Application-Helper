import {
  APPLICATION_RECORD_STATUSES as CANONICAL_APPLICATION_RECORD_STATUSES,
  createApplicationEvent,
  createStatusOverrideEvent,
  deriveApplicationStatus,
  isApplicationRecordStatus,
  normalizeApplicationEvents,
  upsertApplicationEvent,
} from './applicationEvents.ts';
import type {
  ApplicationEvent,
  ApplicationEventType,
  ApplicationPageMetadata,
  ApplicationRecord,
  ApplicationRecordDraft,
  ApplicationRecordStatus,
  InterviewRound,
  JobDescriptionSnapshot,
  RecruitmentSchedule,
  RecruitmentScheduleEntry,
  ResumeSnapshot,
} from './types.ts';

export const APPLICATION_RECORD_STATUSES = CANONICAL_APPLICATION_RECORD_STATUSES;

const LEGACY_APPLICATION_RECORD_STATUS_MAP: Record<string, ApplicationRecordStatus> = {
  待投: '待投递',
  待投递: '待投递',
  pending: '待投递',
  draft: '待投递',
  已投递: '已投递',
  applied: '已投递',
  submitted: '已投递',
  笔试: '笔试/测评',
  已笔试: '笔试/测评',
  '笔试/测评': '笔试/测评',
  assessment: '笔试/测评',
  面试: '面试中',
  面试中: '面试中',
  interview: '面试中',
  offer: 'offer',
  已拒绝: '已拒绝',
  拒绝: '已拒绝',
  rejected: '已拒绝',
  rejection: '已拒绝',
  主动放弃: '主动放弃',
  放弃: '主动放弃',
  withdrawn: '主动放弃',
  职位关闭: '职位关闭',
  岗位关闭: '职位关闭',
  job_closed: '职位关闭',
  终止: '终止',
  terminated: '终止',
};

export const APPLICATION_RECORD_CSV_HEADERS = [
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
] as const;

export const APPLICATION_RECORD_CSV_V2_HEADERS = [
  'schemaVersion',
  'id',
  'companyName',
  'jobTitle',
  'jobId',
  'applicationId',
  'sourceSite',
  'sourceUrl',
  'status',
  'notes',
  'appliedAt',
  'location',
  'employmentType',
  'applicationEmail',
  'writtenTestAt',
  'writtenTestUrl',
  'assessmentAt',
  'assessmentUrl',
  'aiInterviewAt',
  'aiInterviewUrl',
  'firstInterviewAt',
  'firstInterviewUrl',
  'secondInterviewAt',
  'secondInterviewUrl',
  'thirdInterviewAt',
  'thirdInterviewUrl',
  'hrInterviewAt',
  'hrInterviewUrl',
  'resumeProfileName',
  'resumeFileName',
  'createdAt',
  'updatedAt',
] as const;

export const APPLICATION_RECORD_TABLE_CSV_HEADERS = [
  '公司',
  '岗位',
  '链接',
  '状态',
  '投递日期',
  '工作地点',
] as const;

const SINGLE_INTERVIEW_APPLICATION_RECORD_CSV_V2_HEADERS = [
  'schemaVersion',
  'id',
  'companyName',
  'jobTitle',
  'jobId',
  'applicationId',
  'sourceSite',
  'sourceUrl',
  'status',
  'notes',
  'appliedAt',
  'location',
  'employmentType',
  'applicationEmail',
  'writtenTestAt',
  'writtenTestUrl',
  'assessmentAt',
  'assessmentUrl',
  'interviewAt',
  'interviewUrl',
  'resumeProfileName',
  'resumeFileName',
  'createdAt',
  'updatedAt',
] as const;

const LEGACY_APPLICATION_RECORD_CSV_V2_HEADERS = [
  'schemaVersion',
  'id',
  'companyName',
  'jobTitle',
  'jobId',
  'applicationId',
  'sourceSite',
  'sourceUrl',
  'status',
  'notes',
  'appliedAt',
  'location',
  'employmentType',
  'applicationEmail',
  'resumeProfileName',
  'resumeFileName',
  'createdAt',
  'updatedAt',
] as const;

const COMPACT_APPLICATION_RECORD_CSV_V2_HEADERS = [
  'schemaVersion',
  'id',
  'companyName',
  'jobTitle',
  'jobId',
  'sourceSite',
  'sourceUrl',
  'status',
  'notes',
  'appliedAt',
  'location',
  'applicationEmail',
  'resumeProfileName',
  'resumeFileName',
  'createdAt',
  'updatedAt',
] as const;

export type ApplicationRecordCsvVersion = 1 | 2;

type UnknownRecord = Record<string, unknown>;
type CsvHeader = typeof APPLICATION_RECORD_CSV_V2_HEADERS[number];

export interface ApplicationRecordNormalizationResult {
  record: ApplicationRecord;
  warnings: string[];
}

export type ApplicationRecordDuplicateMatchKind =
  | 'company_job_id'
  | 'source_url'
  | 'company_title_location';

export interface ApplicationRecordDuplicateMatch {
  record: ApplicationRecord;
  kind: ApplicationRecordDuplicateMatchKind;
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | undefined {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function normalizeIdentityText(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, ' ').toLocaleLowerCase();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function generateRecordId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `app_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function deterministicLegacyRecordId(record: UnknownRecord): string {
  const identity = [
    normalizeText(record.companyName),
    normalizeText(record.jobTitle),
    normalizeText(record.sourceUrl),
    normalizeText(record.appliedAt),
    normalizeText(record.createdAt),
  ].join('\0');
  return `legacy_${stableHash(identity)}`;
}

function normalizeResumeSnapshot(value: unknown): ResumeSnapshot | undefined {
  const snapshot = asRecord(value);
  if (Object.keys(snapshot).length === 0) return undefined;
  return {
    ...snapshot,
    profileId: optionalText(snapshot.profileId),
    profileName: optionalText(snapshot.profileName),
    fileName: optionalText(snapshot.fileName),
    profileUpdatedAt: optionalText(snapshot.profileUpdatedAt),
  };
}

function normalizeJobDescriptionSnapshot(value: unknown): JobDescriptionSnapshot | undefined {
  const snapshot = asRecord(value);
  if (Object.keys(snapshot).length === 0) return undefined;
  return {
    ...snapshot,
    text: normalizeText(snapshot.text),
    capturedAt: normalizeText(snapshot.capturedAt),
    sourceUrl: normalizeText(snapshot.sourceUrl),
    contentHash: normalizeText(snapshot.contentHash),
    truncated: snapshot.truncated === true,
  };
}

function normalizeRecruitmentScheduleEntry(value: unknown): RecruitmentScheduleEntry | undefined {
  const entry = asRecord(value);
  const scheduledAt = normalizeText(entry.scheduledAt);
  const url = normalizeText(entry.url);
  const timeKind = entry.timeKind === 'deadline' || entry.timeKind === 'start'
    ? entry.timeKind
    : undefined;
  const completedAt = normalizeText(entry.completedAt);
  return scheduledAt || url ? {
    scheduledAt,
    url,
    ...(timeKind ? { timeKind } : {}),
    ...(completedAt ? { completedAt } : {}),
  } : undefined;
}

function normalizeInterviewSchedules(value: unknown): RecruitmentSchedule['interviews'] {
  const interviews = asRecord(value);
  const entries = (['ai', 'first', 'second', 'third', 'hr'] as const)
    .map(round => [round, normalizeRecruitmentScheduleEntry(interviews[round])] as const)
    .filter(([, entry]) => entry);
  return entries.length > 0
    ? Object.fromEntries(entries) as RecruitmentSchedule['interviews']
    : undefined;
}

export function normalizeRecruitmentSchedule(value: unknown): RecruitmentSchedule | undefined {
  const schedule = asRecord(value);
  const entries = [
    ['writtenTest', normalizeRecruitmentScheduleEntry(schedule.writtenTest)],
    ['assessment', normalizeRecruitmentScheduleEntry(schedule.assessment)],
  ] as const;
  const normalized = Object.fromEntries(entries.filter(([, entry]) => entry)) as RecruitmentSchedule;
  const interviews: NonNullable<RecruitmentSchedule['interviews']> = (
    normalizeInterviewSchedules(schedule.interviews) ?? {}
  );
  const legacyInterview = normalizeRecruitmentScheduleEntry(schedule.interview);
  if (legacyInterview && !interviews.first) interviews.first = legacyInterview;
  if (Object.keys(interviews).length > 0) normalized.interviews = interviews;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function appendWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

export function normalizeApplicationRecordStatus(value: unknown): ApplicationRecordStatus | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (isApplicationRecordStatus(normalized)) return normalized;
  return LEGACY_APPLICATION_RECORD_STATUS_MAP[normalized]
    ?? LEGACY_APPLICATION_RECORD_STATUS_MAP[normalized.toLocaleLowerCase()]
    ?? null;
}

function migrationEventType(status: ApplicationRecordStatus): ApplicationEventType {
  switch (status) {
    case '待投递': return 'application_created';
    case '已投递': return 'applied';
    case '笔试/测评': return 'assessment_invite';
    case '面试中': return 'interview';
    case 'offer': return 'offer';
    case '已拒绝': return 'rejection';
    case '主动放弃': return 'withdrawn';
    case '职位关闭': return 'job_closed';
    case '终止': return 'status_override';
  }
}

function createMigrationEvent(
  recordId: string,
  legacyStatus: string,
  status: ApplicationRecordStatus,
  occurredAt: string,
): ApplicationEvent {
  const sourceKey = `migration:${recordId}:${legacyStatus || status}`;
  return createApplicationEvent({
    type: migrationEventType(status),
    occurredAt: occurredAt || '1970-01-01',
    source: 'migration',
    title: `迁移旧状态：${legacyStatus || status}`,
    sourceKey,
    metadata: status === '终止' ? { status } : undefined,
  });
}

export function normalizeApplicationRecordWithWarnings(input: unknown): ApplicationRecordNormalizationResult {
  const source = asRecord(input);
  const id = normalizeText(source.id) || deterministicLegacyRecordId(source);
  const rawStatus = normalizeText(source.status);
  const normalizedStatus = normalizeApplicationRecordStatus(rawStatus) ?? '已投递';
  const warnings = Array.isArray(source.migrationWarnings)
    ? source.migrationWarnings.map(normalizeText).filter(Boolean)
    : [];
  if (rawStatus && !normalizeApplicationRecordStatus(rawStatus)) {
    appendWarning(warnings, `无法识别旧投递状态“${rawStatus}”，已按“已投递”迁移`);
  }

  const eventsWereProvided = Array.isArray(source.events);
  let events = normalizeApplicationEvents(source.events, id);
  if (events.length === 0 && (!eventsWereProvided || normalizedStatus !== '待投递')) {
    const occurredAt = normalizeText(source.appliedAt)
      || normalizeText(source.createdAt)
      || normalizeText(source.updatedAt)
      || '1970-01-01';
    events = [createMigrationEvent(id, rawStatus || normalizedStatus, normalizedStatus, occurredAt)];
  }

  const derivedStatus = deriveApplicationStatus(events);
  if (eventsWereProvided && rawStatus && normalizeApplicationRecordStatus(rawStatus) !== derivedStatus) {
    appendWarning(warnings, `状态缓存“${rawStatus}”已根据生命周期事件重建为“${derivedStatus}”`);
  }

  const record: ApplicationRecord = {
    ...source,
    id,
    companyName: normalizeText(source.companyName),
    jobTitle: normalizeText(source.jobTitle),
    jobId: optionalText(source.jobId),
    applicationId: optionalText(source.applicationId),
    sourceSite: normalizeText(source.sourceSite),
    sourceUrl: normalizeText(source.sourceUrl),
    location: normalizeText(source.location),
    employmentType: optionalText(source.employmentType),
    status: derivedStatus,
    notes: normalizeText(source.notes),
    appliedAt: normalizeText(source.appliedAt),
    applicationEmail: optionalText(source.applicationEmail),
    recruitmentSchedule: normalizeRecruitmentSchedule(source.recruitmentSchedule),
    resumeSnapshot: normalizeResumeSnapshot(source.resumeSnapshot),
    jdSnapshot: normalizeJobDescriptionSnapshot(source.jdSnapshot),
    events,
    migrationWarnings: warnings.length > 0 ? warnings : undefined,
    createdAt: normalizeText(source.createdAt),
    updatedAt: normalizeText(source.updatedAt),
  };
  return { record, warnings };
}

export function normalizeApplicationRecord(input: unknown): ApplicationRecord {
  return normalizeApplicationRecordWithWarnings(input).record;
}

export function normalizeApplicationRecords(records: unknown): ApplicationRecord[] {
  return Array.isArray(records) ? records.map(normalizeApplicationRecord) : [];
}

export function compareApplicationRecordSubmissionTime(
  left: ApplicationRecord,
  right: ApplicationRecord,
  ascending = false,
): number {
  const leftMoment = applicationSubmissionMoment(left);
  const rightMoment = applicationSubmissionMoment(right);
  const leftDay = left.appliedAt || leftMoment.slice(0, 10);
  const rightDay = right.appliedAt || rightMoment.slice(0, 10);
  const dayDifference = leftDay.localeCompare(rightDay);
  if (dayDifference !== 0) return ascending ? dayDifference : -dayDifference;

  const momentDifference = leftMoment.localeCompare(rightMoment);
  return ascending ? momentDifference : -momentDifference;
}

function applicationSubmissionMoment(record: ApplicationRecord): string {
  const appliedEventAt = (record.events ?? [])
    .filter(event => event.type === 'applied' && event.timePrecision === 'datetime')
    .map(event => event.occurredAt)
    .sort()[0];
  return appliedEventAt || record.createdAt || record.updatedAt || record.appliedAt;
}

const TRACKING_QUERY_PARAMETER = /^(?:utm_.+|session(?:id)?|sid|phpsessid|jsessionid|gclid|fbclid|_ga)$/i;
const MEANINGLESS_HASH = /^(?:top|content|details?|description|job-description|apply|application|_)$/i;

export function normalizeApplicationRecordUrl(value: unknown): string {
  const rawUrl = normalizeText(value);
  if (!rawUrl) return '';

  try {
    const url = new URL(rawUrl);
    url.protocol = url.protocol.toLocaleLowerCase();
    url.hostname = url.hostname.toLocaleLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }

    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_QUERY_PARAMETER.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();

    const hash = url.hash.slice(1);
    const hashCarriesIdentity = /^!?\//.test(hash) || /(?:job|position|req)(?:id)?[=/:-]/i.test(hash);
    if (!hashCarriesIdentity || MEANINGLESS_HASH.test(hash)) url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return rawUrl.replace(/\/+$/, '');
  }
}

export function createApplicationRecordDraft(
  nowIso: string,
  metadata: ApplicationPageMetadata,
): ApplicationRecordDraft {
  const normalizedUrl = normalizeApplicationRecordUrl(metadata.sourceUrl);
  const sourceKey = `website:${normalizedUrl || metadata.sourceSite || 'unknown'}:applied`;
  const appliedEvent = createApplicationEvent({
    type: 'applied',
    occurredAt: nowIso,
    source: 'website',
    title: '已投递',
    sourceKey,
    metadata: {
      jobId: metadata.jobId,
      applicationId: metadata.applicationId,
    },
  });

  return {
    companyName: metadata.companyName,
    jobTitle: metadata.jobTitle ?? '',
    jobId: metadata.jobId,
    applicationId: metadata.applicationId,
    sourceSite: metadata.sourceSite,
    sourceUrl: metadata.sourceUrl,
    status: '已投递',
    notes: '',
    appliedAt: nowIso.slice(0, 10),
    location: metadata.location ?? '',
    employmentType: metadata.employmentType,
    jdSnapshot: metadata.jdSnapshot,
    events: [appliedEvent],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

type DuplicateCandidate = Pick<ApplicationRecord, 'companyName' | 'sourceUrl'>
  & Partial<Pick<ApplicationRecord, 'jobId' | 'jobTitle' | 'location'>>;

export function findApplicationRecordDuplicateMatch(
  records: readonly ApplicationRecord[],
  candidate: DuplicateCandidate,
): ApplicationRecordDuplicateMatch | null {
  const companyName = normalizeIdentityText(candidate.companyName);
  const jobId = normalizeIdentityText(candidate.jobId);
  if (companyName && jobId) {
    const record = records.find(item => (
      normalizeIdentityText(item.companyName) === companyName
      && normalizeIdentityText(item.jobId) === jobId
    ));
    if (record) return { record, kind: 'company_job_id' };
  }

  const sourceUrl = normalizeApplicationRecordUrl(candidate.sourceUrl);
  if (sourceUrl) {
    const record = records.find(item => normalizeApplicationRecordUrl(item.sourceUrl) === sourceUrl);
    if (record) return { record, kind: 'source_url' };
  }

  const jobTitle = normalizeIdentityText(candidate.jobTitle);
  const location = normalizeIdentityText(candidate.location);
  if (companyName && jobTitle && location) {
    const record = records.find(item => (
      normalizeIdentityText(item.companyName) === companyName
      && normalizeIdentityText(item.jobTitle) === jobTitle
      && normalizeIdentityText(item.location) === location
    ));
    if (record) return { record, kind: 'company_title_location' };
  }
  return null;
}

export function findApplicationRecordDuplicate(
  records: readonly ApplicationRecord[],
  candidate: DuplicateCandidate,
): ApplicationRecord | null {
  return findApplicationRecordDuplicateMatch(records, candidate)?.record ?? null;
}

function mergeEvents(current: ApplicationRecord, incoming: UnknownRecord): ApplicationEvent[] {
  const incomingEvents = Array.isArray(incoming.events) ? incoming.events : [];
  return normalizeApplicationEvents([...current.events, ...incomingEvents], current.id);
}

/** Keeps events added after a form was opened and converts a legacy flat status edit into an override event. */
export function mergeApplicationRecordUpdate(currentInput: unknown, incomingInput: unknown): ApplicationRecord {
  const current = normalizeApplicationRecord(currentInput);
  const incoming = asRecord(incomingInput);
  const requestedStatus = normalizeApplicationRecordStatus(incoming.status);
  const updatedAt = normalizeText(incoming.updatedAt) || current.updatedAt || '1970-01-01';
  let merged = normalizeApplicationRecord({
    ...current,
    ...incoming,
    id: current.id,
    status: current.status,
    events: mergeEvents(current, incoming),
  });

  if (requestedStatus && requestedStatus !== current.status) {
    const clientMutationId = `status-${stableHash(`${updatedAt}\0${requestedStatus}`)}`;
    merged = upsertApplicationEvent(
      merged,
      createStatusOverrideEvent(current.id, requestedStatus, updatedAt, clientMutationId),
      updatedAt,
    );
  }
  return merged;
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

function spreadsheetSafeText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function restoreSpreadsheetSafeText(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

function validHttpUrl(value: string): string {
  const candidate = normalizeText(value);
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? candidate : '';
  } catch {
    return '';
  }
}

function excelHyperlinkCell(value: string): string {
  const url = validHttpUrl(value);
  if (!url) return spreadsheetSafeText(normalizeText(value));
  const escapedUrl = url.replaceAll('"', '""');
  return `=HYPERLINK("${escapedUrl}","${escapedUrl}")`;
}

function sourceUrlFromTableCell(value: string): string {
  const candidate = normalizeText(value);
  const formulaMatch = candidate.match(/^=HYPERLINK\("((?:""|[^"])*)"\s*[,;]\s*"((?:""|[^"])*)"\)$/i);
  const formulaUrl = formulaMatch?.[1]?.replaceAll('""', '"') ?? '';
  const formulaLabel = formulaMatch?.[2]?.replaceAll('""', '"') ?? '';
  const isSupportedFormula = Boolean(formulaMatch)
    && (formulaLabel === formulaUrl || formulaLabel === '打开投递页面');
  const sourceUrl = isSupportedFormula ? formulaUrl : restoreSpreadsheetSafeText(candidate);
  return validHttpUrl(sourceUrl);
}

function sourceSiteFromUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function singleLineTableText(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const nextChar = csv[index + 1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      row.push(cell);
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell);
    if (row.some(value => value !== '')) rows.push(row);
  }
  return rows;
}

function headerEquals(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((header, index) => actual[index] === header);
}

function csvValue(record: ApplicationRecord, header: CsvHeader): string {
  switch (header) {
    case 'schemaVersion': return '2';
    case 'writtenTestAt': return record.recruitmentSchedule?.writtenTest?.scheduledAt ?? '';
    case 'writtenTestUrl': return record.recruitmentSchedule?.writtenTest?.url ?? '';
    case 'assessmentAt': return record.recruitmentSchedule?.assessment?.scheduledAt ?? '';
    case 'assessmentUrl': return record.recruitmentSchedule?.assessment?.url ?? '';
    case 'aiInterviewAt': return record.recruitmentSchedule?.interviews?.ai?.scheduledAt ?? '';
    case 'aiInterviewUrl': return record.recruitmentSchedule?.interviews?.ai?.url ?? '';
    case 'firstInterviewAt': return record.recruitmentSchedule?.interviews?.first?.scheduledAt ?? '';
    case 'firstInterviewUrl': return record.recruitmentSchedule?.interviews?.first?.url ?? '';
    case 'secondInterviewAt': return record.recruitmentSchedule?.interviews?.second?.scheduledAt ?? '';
    case 'secondInterviewUrl': return record.recruitmentSchedule?.interviews?.second?.url ?? '';
    case 'thirdInterviewAt': return record.recruitmentSchedule?.interviews?.third?.scheduledAt ?? '';
    case 'thirdInterviewUrl': return record.recruitmentSchedule?.interviews?.third?.url ?? '';
    case 'hrInterviewAt': return record.recruitmentSchedule?.interviews?.hr?.scheduledAt ?? '';
    case 'hrInterviewUrl': return record.recruitmentSchedule?.interviews?.hr?.url ?? '';
    case 'resumeProfileName': return record.resumeSnapshot?.profileName ?? '';
    case 'resumeFileName': return record.resumeSnapshot?.fileName ?? '';
    default: return String(record[header as keyof ApplicationRecord] ?? '');
  }
}

function interviewSchedulesFromCsv(values: Record<string, string>): RecruitmentSchedule['interviews'] {
  const interviews = Object.fromEntries(([
    ['ai', 'aiInterviewAt', 'aiInterviewUrl'],
    ['first', 'firstInterviewAt', 'firstInterviewUrl'],
    ['second', 'secondInterviewAt', 'secondInterviewUrl'],
    ['third', 'thirdInterviewAt', 'thirdInterviewUrl'],
    ['hr', 'hrInterviewAt', 'hrInterviewUrl'],
  ] as const).map(([round, scheduledAtHeader, urlHeader]) => [
    round,
    { scheduledAt: values[scheduledAtHeader], url: values[urlHeader] },
  ])) as Record<InterviewRound, RecruitmentScheduleEntry>;

  if (!interviews.first.scheduledAt && !interviews.first.url) {
    interviews.first = { scheduledAt: values.interviewAt, url: values.interviewUrl };
  }
  return interviews;
}

export function serializeApplicationRecordsCsv(
  records: readonly ApplicationRecord[],
  versionOrOptions: ApplicationRecordCsvVersion | { version?: ApplicationRecordCsvVersion } = 2,
): string {
  const version = typeof versionOrOptions === 'number'
    ? versionOrOptions
    : versionOrOptions.version ?? 2;
  const headers: readonly string[] = version === 1
    ? APPLICATION_RECORD_CSV_HEADERS
    : APPLICATION_RECORD_CSV_V2_HEADERS;
  const lines = [
    headers.join(','),
    ...records.map((rawRecord) => {
      const record = normalizeApplicationRecord(rawRecord);
      return headers.map(header => escapeCsvCell(
        version === 1
          ? String(record[header as keyof ApplicationRecord] ?? '')
          : csvValue(record, header as CsvHeader),
      )).join(',');
    }),
  ];
  return `\uFEFF${lines.join('\r\n')}`;
}

/** Human-readable CSV used by the manual download action. */
export function serializeApplicationRecordsTableCsv(records: readonly ApplicationRecord[]): string {
  const lines = [
    APPLICATION_RECORD_TABLE_CSV_HEADERS.join(','),
    ...records.map((rawRecord) => {
      const record = normalizeApplicationRecord(rawRecord);
      return [
        spreadsheetSafeText(record.companyName),
        spreadsheetSafeText(record.jobTitle),
        excelHyperlinkCell(record.sourceUrl),
        spreadsheetSafeText(record.status),
        spreadsheetSafeText(record.appliedAt),
        spreadsheetSafeText(record.location),
      ].map(escapeCsvCell).join(',');
    }),
  ];
  return `\uFEFF${lines.join('\r\n')}`;
}

export function buildApplicationRecordsClipboardContent(
  records: readonly ApplicationRecord[],
): { html: string; text: string } {
  const normalizedRecords = records.map(normalizeApplicationRecord);
  const textRows = [
    APPLICATION_RECORD_TABLE_CSV_HEADERS.join('\t'),
    ...normalizedRecords.map(record => [
      record.companyName,
      record.jobTitle,
      record.sourceUrl,
      record.status,
      record.appliedAt,
      record.location,
    ].map(singleLineTableText).join('\t')),
  ];
  const htmlRows = normalizedRecords.map((record) => {
    const url = validHttpUrl(record.sourceUrl);
    const linkCell = url
      ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
      : escapeHtml(record.sourceUrl);
    return `<tr><td>${escapeHtml(record.companyName)}</td><td>${escapeHtml(record.jobTitle)}</td><td>${linkCell}</td><td>${escapeHtml(record.status)}</td><td>${escapeHtml(record.appliedAt)}</td><td>${escapeHtml(record.location)}</td></tr>`;
  });
  const headerCells = APPLICATION_RECORD_TABLE_CSV_HEADERS
    .map(header => `<th>${escapeHtml(header)}</th>`)
    .join('');
  return {
    html: `<table><thead><tr>${headerCells}</tr></thead><tbody>${htmlRows.join('')}</tbody></table>`,
    text: textRows.join('\r\n'),
  };
}

function recordFromCsvValues(values: Record<string, string>, version: ApplicationRecordCsvVersion): ApplicationRecord {
  const resumeSnapshot = version === 2 && (values.resumeProfileName || values.resumeFileName)
    ? { profileName: values.resumeProfileName, fileName: values.resumeFileName }
    : undefined;
  return normalizeApplicationRecord({
    id: version === 2 ? values.id || generateRecordId() : generateRecordId(),
    companyName: values.companyName,
    jobTitle: values.jobTitle,
    jobId: version === 2 ? values.jobId : undefined,
    applicationId: version === 2 ? values.applicationId : undefined,
    sourceSite: values.sourceSite,
    sourceUrl: values.sourceUrl,
    status: values.status,
    notes: values.notes,
    appliedAt: values.appliedAt,
    location: values.location,
    employmentType: version === 2 ? values.employmentType : undefined,
    applicationEmail: version === 2 ? values.applicationEmail : undefined,
    recruitmentSchedule: version === 2 ? {
      writtenTest: { scheduledAt: values.writtenTestAt, url: values.writtenTestUrl },
      assessment: { scheduledAt: values.assessmentAt, url: values.assessmentUrl },
      interviews: interviewSchedulesFromCsv(values),
    } : undefined,
    resumeSnapshot,
    createdAt: values.createdAt,
    updatedAt: values.updatedAt,
  });
}

export function parseApplicationRecordsCsv(csv: string): {
  records: ApplicationRecord[];
  warnings: string[];
  version?: ApplicationRecordCsvVersion;
  error?: string;
} {
  const rows = parseCsvRows(csv.replace(/^\uFEFF/, ''));
  const warnings: string[] = [];
  if (rows.length === 0) return { records: [], warnings: ['CSV 内容为空'] };

  const [headerRow, ...dataRows] = rows;
  const headers = headerRow.map(header => header.trim());
  const isTableCsv = headerEquals(headers, APPLICATION_RECORD_TABLE_CSV_HEADERS);
  const version: ApplicationRecordCsvVersion | null = headerEquals(headers, APPLICATION_RECORD_CSV_HEADERS)
    || isTableCsv
    ? 1
    : headerEquals(headers, APPLICATION_RECORD_CSV_V2_HEADERS)
      || headerEquals(headers, SINGLE_INTERVIEW_APPLICATION_RECORD_CSV_V2_HEADERS)
      || headerEquals(headers, LEGACY_APPLICATION_RECORD_CSV_V2_HEADERS)
      || headerEquals(headers, COMPACT_APPLICATION_RECORD_CSV_V2_HEADERS)
      ? 2
      : null;
  if (!version) {
    const error = 'CSV 表头不合法，必须使用固定的 V1 或 V2 列头，或 6 列中文列头';
    return { records: [], warnings: [error], error };
  }

  const records: ApplicationRecord[] = [];
  dataRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const rawValues = Object.fromEntries(headers.map((header, headerIndex) => [header, row[headerIndex] ?? '']));
    const tableSourceUrl = isTableCsv ? sourceUrlFromTableCell(rawValues['链接']) : '';
    if (isTableCsv && rawValues['链接'].trim() && !tableSourceUrl) {
      warnings.push(`第 ${rowNumber} 行链接不是有效的 HTTP/HTTPS 地址，已留空`);
    }
    const values = isTableCsv ? {
      companyName: restoreSpreadsheetSafeText(rawValues['公司']),
      jobTitle: restoreSpreadsheetSafeText(rawValues['岗位']),
      sourceSite: sourceSiteFromUrl(tableSourceUrl),
      sourceUrl: tableSourceUrl,
      status: restoreSpreadsheetSafeText(rawValues['状态']),
      notes: '',
      appliedAt: restoreSpreadsheetSafeText(rawValues['投递日期']),
      location: restoreSpreadsheetSafeText(rawValues['工作地点']),
      createdAt: '',
      updatedAt: '',
    } : rawValues;
    if (version === 2 && !['2', 'v2', 'V2'].includes(values.schemaVersion)) {
      warnings.push(`第 ${rowNumber} 行缺少有效的 CSV V2 schemaVersion`);
      return;
    }
    if (!normalizeApplicationRecordStatus(values.status)) {
      warnings.push(`第 ${rowNumber} 行存在非法状态: ${values.status}`);
      return;
    }
    records.push(recordFromCsvValues(values, version));
  });
  return { records, warnings, version };
}

export function areApplicationRecordCsvSummariesEqual(
  leftInput: unknown,
  rightInput: unknown,
): boolean {
  const left = normalizeApplicationRecord(leftInput);
  const right = normalizeApplicationRecord(rightInput);
  const summary = (record: ApplicationRecord) => APPLICATION_RECORD_CSV_V2_HEADERS
    .filter(header => header !== 'schemaVersion' && header !== 'id')
    .map(header => csvValue(record, header));
  return JSON.stringify(summary(left)) === JSON.stringify(summary(right));
}
