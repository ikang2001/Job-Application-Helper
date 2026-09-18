import {
  addApplicationEvent,
  createApplicationEvent,
} from '../../../src/shared/applicationEvents.ts';
import type {
  ApplicationEventType,
  ApplicationRecord,
  ApplicationRecordStatus,
  RecruitmentSchedule,
  RecruitmentScheduleEntry,
} from '../../../src/shared/types.ts';
import type {
  DesktopMailReview,
  DesktopMailReviewDecisionInput,
  DesktopMailReviewStage,
} from '../shared/contracts.ts';
import { desktopRecordInput, saveDesktopRecord } from './records.ts';

export interface DesktopMailCompanyMatch {
  companyName?: string;
  recordIds: string[];
}

export const DESKTOP_MAIL_REVIEW_STAGES: ReadonlyArray<{
  value: DesktopMailReviewStage;
  label: string;
}> = [
  { value: 'applicationReceived', label: '投递确认' },
  { value: 'writtenTest', label: '笔试' },
  { value: 'assessment', label: '测评' },
  { value: 'ai', label: 'AI 面' },
  { value: 'first', label: '一面' },
  { value: 'second', label: '二面' },
  { value: 'third', label: '三面' },
  { value: 'hr', label: 'HR 面' },
  { value: 'offer', label: 'Offer' },
  { value: 'rejection', label: '未通过' },
  { value: 'jobClosed', label: '职位关闭' },
];

const STAGES = new Set(DESKTOP_MAIL_REVIEW_STAGES.map(item => item.value));

export function matchDesktopMailCompany(
  content: string,
  extractedCompany: string | undefined,
  records: readonly ApplicationRecord[],
): DesktopMailCompanyMatch {
  const normalizedContent = normalizeSearchText(content);
  const normalizedExtracted = normalizeCompany(extractedCompany ?? '');
  const groups = new Map<string, { companyName: string; recordIds: string[]; score: number }>();
  for (const record of records) {
    const key = normalizeCompany(record.companyName);
    if (!key) continue;
    const group = groups.get(key) ?? { companyName: record.companyName, recordIds: [], score: 0 };
    group.recordIds.push(record.id);
    group.score = Math.max(group.score, companyMatchScore(
      normalizedContent,
      normalizedExtracted,
      record.companyName,
    ));
    groups.set(key, group);
  }
  const ranked = [...groups.values()]
    .filter(group => group.score > 0)
    .sort((left, right) => right.score - left.score
      || normalizeCompany(right.companyName).length - normalizeCompany(left.companyName).length
      || left.companyName.localeCompare(right.companyName, 'zh-CN'));
  const best = ranked[0];
  if (best && ranked[1]?.score === best.score) return { recordIds: [] };
  return best
    ? { companyName: best.companyName, recordIds: best.recordIds }
    : { recordIds: [] };
}

export function suggestedDesktopMailStage(
  category: string,
  content: string,
  subject = '',
): DesktopMailReviewStage | undefined {
  const normalized = content.normalize('NFKC');
  if (category === 'assessment_invite') {
    const normalizedSubject = subject.normalize('NFKC');
    if (/笔试|编程|coding\s*(?:test|challenge)/i.test(normalizedSubject)) return 'writtenTest';
    if (/测评|assessment/i.test(normalizedSubject)) return 'assessment';
    return /笔试|编程|coding\s*(?:test|challenge)/i.test(normalized) ? 'writtenTest' : 'assessment';
  }
  if (category === 'interview_invite') {
    if (/AI\s*面(?:试)?|智能面试|数字人面试|机器面试/i.test(normalized)) return 'ai';
    if (/HR\s*面|人力(?:资源)?面/i.test(normalized)) return 'hr';
    if (/三面|第\s*三\s*轮/i.test(normalized)) return 'third';
    if (/二面|第\s*二\s*轮/i.test(normalized)) return 'second';
    return 'first';
  }
  return ({
    application_received: 'applicationReceived',
    offer: 'offer',
    rejection: 'rejection',
    job_closed: 'jobClosed',
  } as Partial<Record<string, DesktopMailReviewStage>>)[category];
}

export function confirmDesktopMailReview(
  records: readonly ApplicationRecord[],
  reviews: readonly DesktopMailReview[],
  input: DesktopMailReviewDecisionInput,
  nowIso = new Date().toISOString(),
): { records: ApplicationRecord[]; reviews: DesktopMailReview[] } {
  const review = reviews.find(item => item.id === input.reviewId);
  if (!review || review.state !== 'pending') throw new Error('待审核邮件不存在或已经处理');
  if (!STAGES.has(input.stage)) throw new Error('请选择正确的邮件阶段');
  const record = records.find(item => item.id === input.recordId);
  if (!record) throw new Error('请选择该公司对应的投递岗位');
  const selectedCompany = normalizeCompany(record.companyName);
  const selectedCompanyRecordIds = records
    .filter(item => normalizeCompany(item.companyName) === selectedCompany)
    .map(item => item.id);

  const entry = scheduleEntryForReview(review, input);
  const recruitmentSchedule = scheduleForReview(record.recruitmentSchedule, entry, input.stage);
  const scheduleNote = entry
    ? `[邮件审核] ${stageLabel(input.stage)}${entry.timeKind === 'deadline' ? '截止' : '开始'}：${formatScheduleNoteTime(entry.scheduledAt)}`
    : '';
  const saved = saveDesktopRecord(records, {
    ...desktopRecordInput(record),
    status: statusForStage(input.stage),
    recruitmentSchedule,
    notes: appendRecordNotes(record.notes, scheduleNote, input.notes),
  }, nowIso);
  const emailEvent = createApplicationEvent({
    type: eventTypeForStage(input.stage),
    occurredAt: review.receivedAt,
    source: 'email',
    title: `人工审核邮件：${stageLabel(input.stage)}`,
    sourceKey: `email:desktop:${encodeURIComponent(review.accountId)}:${encodeURIComponent(review.messageId)}:${input.stage}`,
    metadata: {
      status: statusForStage(input.stage),
      interviewAt: entry?.timeKind === 'start' ? entry.scheduledAt : review.extractedAt,
      deadlineAt: entry?.timeKind === 'deadline' ? entry.scheduledAt : review.deadlineAt,
      meetingUrl: entry?.url || review.actionUrl,
      emailSubject: review.subject,
      summary: input.notes?.trim() || review.summary,
      classification: review.category,
    },
  });
  const updatedRecord = addApplicationEvent(saved.record, emailEvent, nowIso);

  return {
    records: saved.records.map(item => item.id === updatedRecord.id ? updatedRecord : item),
    reviews: reviews.map(item => item.id === review.id ? {
      ...item,
      state: 'confirmed',
      reviewedAt: nowIso,
      companyName: record.companyName,
      candidateRecordIds: selectedCompanyRecordIds,
      selectedRecordId: record.id,
      selectedStage: input.stage,
      actionUrl: entry?.url || review.actionUrl,
      extractedAt: entry?.timeKind === 'start' ? entry.scheduledAt : review.extractedAt,
      deadlineAt: entry?.timeKind === 'deadline' ? entry.scheduledAt : review.deadlineAt,
    } : item),
  };
}

export function ignoreDesktopMailReview(
  reviews: readonly DesktopMailReview[],
  reviewId: string,
  nowIso = new Date().toISOString(),
): DesktopMailReview[] {
  return ignoreDesktopMailReviews(reviews, [reviewId], nowIso);
}

export function ignoreDesktopMailReviews(
  reviews: readonly DesktopMailReview[],
  reviewIds: readonly string[],
  nowIso = new Date().toISOString(),
): DesktopMailReview[] {
  const selectedIds = new Set(reviewIds.map(id => id.trim()).filter(Boolean));
  if (selectedIds.size === 0) throw new Error('请至少选择一封待审核邮件');
  const pendingIds = new Set(
    reviews.filter(review => review.state === 'pending').map(review => review.id),
  );
  if ([...selectedIds].some(id => !pendingIds.has(id))) {
    throw new Error('部分待审核邮件不存在或已经处理，请刷新后重试');
  }
  return reviews.map(item => selectedIds.has(item.id)
    ? { ...item, state: 'ignored', reviewedAt: nowIso }
    : item);
}

export function statusForStage(stage: DesktopMailReviewStage): ApplicationRecordStatus {
  if (stage === 'applicationReceived') return '已投递';
  if (stage === 'writtenTest' || stage === 'assessment') return '笔试/测评';
  if (['ai', 'first', 'second', 'third', 'hr'].includes(stage)) return '面试中';
  if (stage === 'offer') return 'offer';
  if (stage === 'rejection') return '主动放弃';
  return '职位关闭';
}

function companyMatchScore(content: string, extracted: string, companyName: string): number {
  const company = normalizeCompany(companyName);
  if (!company) return 0;
  if (extracted && extracted === company) return 100 + company.length;
  if (extracted && companyNamesOverlap(extracted, company)) {
    return 90 + Math.min(extracted.length, company.length);
  }
  if (content.includes(company)) return 80 + company.length;
  const alias = companyAlias(company);
  if (alias.length >= 2 && content.includes(alias)) return 50 + alias.length;
  return 0;
}

function companyNamesOverlap(left: string, right: string): boolean {
  const leftAliases = [left, companyAlias(left)];
  const rightAliases = [right, companyAlias(right)];
  return leftAliases.some(leftAlias => rightAliases.some(rightAlias => (
    leftAlias.length >= 4
    && rightAlias.length >= 4
    && (leftAlias.endsWith(rightAlias) || rightAlias.endsWith(leftAlias))
  )));
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeCompany(value: string): string {
  return normalizeSearchText(value.replace(/[（(][^（）()]{1,20}[）)]/gu, ''))
    .replace(/(?:股份)?有限公司|有限责任公司|集团|公司|corporation|corp|inc|ltd|limited|llc/gi, '');
}

function companyAlias(company: string): string {
  const alias = company.replace(/(?:科技|技术|网络|电子|信息|智能|软件|通信)$/u, '');
  return alias.length >= 2 ? alias : company;
}

function scheduleEntryForReview(
  review: DesktopMailReview,
  input: DesktopMailReviewDecisionInput,
): RecruitmentScheduleEntry | undefined {
  if (!isScheduledStage(input.stage)) return undefined;
  const timeKind = input.scheduleType ?? defaultScheduleType(review, input.stage);
  const sourceTime = input.scheduledAt === undefined
    ? preferredReviewTime(review, timeKind)
    : input.scheduledAt;
  const scheduledAt = normalizeScheduleTime(sourceTime, timeKind === 'deadline' ? '23:59' : '00:00');
  if (!scheduledAt) throw new Error('请填写有效的安排或截止时间');
  const url = normalizeActionUrl(input.actionUrl === undefined ? review.actionUrl : input.actionUrl);
  return { scheduledAt, url, timeKind };
}

function normalizeScheduleTime(value: string | undefined, dateOnlyTime: string): string {
  const normalized = value?.trim() ?? '';
  const dateOnly = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly && isValidDateTimeParts(dateOnly.slice(1).map(Number), [0, 0])) {
    return `${normalized}T${dateOnlyTime}`;
  }
  const dateTime = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (!dateTime || !isValidDateTimeParts(dateTime.slice(1, 4).map(Number), dateTime.slice(4, 6).map(Number))) {
    return '';
  }
  if (/Z|[+-]\d{2}:?\d{2}$/.test(normalized)) {
    const instant = new Date(normalized);
    if (Number.isNaN(instant.getTime())) return '';
    const date = [
      instant.getFullYear(),
      String(instant.getMonth() + 1).padStart(2, '0'),
      String(instant.getDate()).padStart(2, '0'),
    ].join('-');
    return `${date}T${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`;
  }
  return `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}T${dateTime[4]}:${dateTime[5]}`;
}

function isValidDateTimeParts(dateParts: number[], timeParts: number[]): boolean {
  const [year, month, day] = dateParts;
  const [hour, minute] = timeParts;
  if ([year, month, day, hour, minute].some(value => !Number.isInteger(value))) return false;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function scheduleForReview(
  current: RecruitmentSchedule | undefined,
  entry: RecruitmentScheduleEntry | undefined,
  stage: DesktopMailReviewStage,
): RecruitmentSchedule | undefined {
  if (!entry || !isScheduledStage(stage)) {
    return current;
  }
  const next = structuredClone(current ?? {});
  if (stage === 'writtenTest') next.writtenTest = entry;
  else if (stage === 'assessment') next.assessment = entry;
  else next.interviews = { ...next.interviews, [stage]: entry };
  return next;
}

function isScheduledStage(stage: DesktopMailReviewStage): boolean {
  return ['writtenTest', 'assessment', 'ai', 'first', 'second', 'third', 'hr'].includes(stage);
}

function defaultScheduleType(
  review: DesktopMailReview,
  stage: DesktopMailReviewStage,
): 'start' | 'deadline' {
  if (stage === 'assessment' || stage === 'ai') return 'deadline';
  if (stage === 'writtenTest' && review.deadlineAt && !review.extractedAt) return 'deadline';
  return 'start';
}

function preferredReviewTime(
  review: DesktopMailReview,
  timeKind: 'start' | 'deadline',
): string | undefined {
  return timeKind === 'deadline'
    ? review.deadlineAt ?? review.extractedAt
    : review.extractedAt ?? review.deadlineAt;
}

function normalizeActionUrl(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) return '';
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('邮件中的安排链接格式无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('邮件中的安排链接只支持 HTTP 或 HTTPS');
  }
  return parsed.toString();
}

function appendRecordNotes(current: string, scheduleNote: string, manualNote: string | undefined): string {
  const additions = [scheduleNote, manualNote?.trim() ?? '']
    .filter(note => note && !current.includes(note));
  return [current.trim(), ...additions].filter(Boolean).join('\n');
}

function formatScheduleNoteTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false });
}

function eventTypeForStage(stage: DesktopMailReviewStage): ApplicationEventType {
  if (stage === 'applicationReceived') return 'application_received';
  if (stage === 'writtenTest' || stage === 'assessment') return 'assessment_invite';
  if (['ai', 'first', 'second', 'third', 'hr'].includes(stage)) return 'interview_invite';
  if (stage === 'offer') return 'offer';
  if (stage === 'rejection') return 'rejection';
  return 'job_closed';
}

function stageLabel(stage: DesktopMailReviewStage): string {
  return DESKTOP_MAIL_REVIEW_STAGES.find(item => item.value === stage)?.label ?? stage;
}
