import type {
  ApplicationRecord,
  InterviewRound,
  RecruitmentSchedule,
  RecruitmentScheduleEntry,
} from '../../../src/shared/types.ts';

export type RecruitmentScheduleRow =
  | { group: 'stage'; kind: 'writtenTest' | 'assessment'; label: string }
  | { group: 'interview'; kind: InterviewRound; label: string };

export type RecruitmentScheduleCategoryFilter = 'all' | 'assessment' | 'ai' | 'interview';

export interface UpcomingRecruitmentSchedule {
  recordId: string;
  companyName: string;
  jobTitle: string;
  status: ApplicationRecord['status'];
  kind: RecruitmentScheduleRow['kind'];
  label: string;
  scheduledAt: string;
  eventAt: number;
  timeKind?: RecruitmentScheduleEntry['timeKind'];
  completedAt?: string;
  url: string;
}

const TERMINAL_STATUSES = new Set<ApplicationRecord['status']>(['已拒绝', '主动放弃', '职位关闭']);

export const RECRUITMENT_SCHEDULE_ROWS: readonly RecruitmentScheduleRow[] = [
  { group: 'stage', kind: 'writtenTest', label: '笔试' },
  { group: 'stage', kind: 'assessment', label: '测评' },
  { group: 'interview', kind: 'ai', label: 'AI面' },
  { group: 'interview', kind: 'first', label: '一面' },
  { group: 'interview', kind: 'second', label: '二面' },
  { group: 'interview', kind: 'third', label: '三面' },
  { group: 'interview', kind: 'hr', label: 'HR面' },
];

export function scheduleEntry(
  schedule: RecruitmentSchedule | undefined,
  row: RecruitmentScheduleRow,
): RecruitmentScheduleEntry {
  const entry = row.group === 'stage'
    ? schedule?.[row.kind]
    : schedule?.interviews?.[row.kind];
  return entry ?? { scheduledAt: '', url: '' };
}

export function updateScheduleEntry(
  schedule: RecruitmentSchedule | undefined,
  row: RecruitmentScheduleRow,
  field: keyof RecruitmentScheduleEntry,
  value: RecruitmentScheduleEntry[keyof RecruitmentScheduleEntry],
): RecruitmentSchedule {
  const entry = { ...scheduleEntry(schedule, row), [field]: value };
  if (row.group === 'stage') return { ...schedule, [row.kind]: entry };
  return {
    ...schedule,
    interviews: { ...schedule?.interviews, [row.kind]: entry },
  };
}

export function scheduleDisplayLabel(label: string, entry: RecruitmentScheduleEntry): string {
  const timeLabel = entry.timeKind === 'deadline'
    ? `${label}截止`
    : entry.timeKind === 'start' ? `${label}开始` : label;
  return entry.completedAt ? `${timeLabel} · 已完成` : timeLabel;
}

export function formatScheduleTime(value: string): string {
  if (!value) return '时间待定';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function upcomingRecruitmentSchedules(
  records: readonly ApplicationRecord[],
  now = Date.now(),
): UpcomingRecruitmentSchedule[] {
  return recruitmentScheduleItems(records)
    .filter(item => !TERMINAL_STATUSES.has(item.status) && !item.completedAt && item.eventAt > now)
    .sort((left, right) => left.eventAt - right.eventAt
      || left.companyName.localeCompare(right.companyName, 'zh-CN'));
}

export function completedRecruitmentSchedules(
  records: readonly ApplicationRecord[],
): UpcomingRecruitmentSchedule[] {
  return recruitmentScheduleItems(records)
    .filter((item): item is UpcomingRecruitmentSchedule & { completedAt: string } => Boolean(item.completedAt))
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
}

export function filterRecruitmentSchedules(
  items: readonly UpcomingRecruitmentSchedule[],
  category: RecruitmentScheduleCategoryFilter,
): UpcomingRecruitmentSchedule[] {
  if (category === 'all') return [...items];
  return items.filter(item => recruitmentScheduleCategory(item.kind) === category);
}

export function recruitmentScheduleCategory(
  kind: RecruitmentScheduleRow['kind'],
): Exclude<RecruitmentScheduleCategoryFilter, 'all'> {
  if (kind === 'writtenTest' || kind === 'assessment') return 'assessment';
  if (kind === 'ai') return 'ai';
  return 'interview';
}

export function setRecruitmentScheduleCompleted(
  schedule: RecruitmentSchedule | undefined,
  kind: RecruitmentScheduleRow['kind'],
  completedAt: string | undefined,
): RecruitmentSchedule {
  const row = RECRUITMENT_SCHEDULE_ROWS.find(item => item.kind === kind);
  return row ? updateScheduleEntry(schedule, row, 'completedAt', completedAt) : { ...schedule };
}

function recruitmentScheduleItems(
  records: readonly ApplicationRecord[],
): UpcomingRecruitmentSchedule[] {
  return records.flatMap(record => RECRUITMENT_SCHEDULE_ROWS.flatMap(row => {
    const entry = scheduleEntry(record.recruitmentSchedule, row);
    const eventAt = Date.parse(entry.scheduledAt);
    if (!Number.isFinite(eventAt)) return [];
    return [{
      recordId: record.id,
      companyName: record.companyName,
      jobTitle: record.jobTitle,
      status: record.status,
      kind: row.kind,
      label: row.label,
      scheduledAt: entry.scheduledAt,
      eventAt,
      timeKind: entry.timeKind,
      completedAt: entry.completedAt,
      url: entry.url,
    }];
  }));
}
