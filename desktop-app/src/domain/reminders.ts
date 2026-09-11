import type {
  ApplicationRecord,
  RecruitmentScheduleEntry,
} from '../../../src/shared/types.ts';

export const RECRUITMENT_REMINDER_OFFSETS_MINUTES = [1440, 300] as const;

export type RecruitmentReminderOffsetMinutes =
  typeof RECRUITMENT_REMINDER_OFFSETS_MINUTES[number];

export interface RecruitmentReminder {
  id: string;
  eventId: string;
  recordId: string;
  companyName: string;
  jobTitle: string;
  label: string;
  scheduledAt: string;
  eventAt: string;
  dueAt: string;
  offsetMinutes: RecruitmentReminderOffsetMinutes;
  url: string;
  timeKind: 'start' | 'deadline';
}

export interface DueReminderGroup {
  reminder: RecruitmentReminder;
  handledIds: string[];
}

const SCHEDULE_LABELS = [
  ['writtenTest', '笔试'],
  ['assessment', '测评'],
  ['ai', 'AI 面'],
  ['first', '一面'],
  ['second', '二面'],
  ['third', '三面'],
  ['hr', 'HR 面'],
] as const;

export function buildRecruitmentReminders(
  records: readonly ApplicationRecord[],
): RecruitmentReminder[] {
  return records.flatMap(record => scheduleEntries(record).flatMap(({ kind, label, entry }) => (
    remindersForEntry(record, kind, label, entry)
  )));
}

export function selectDueReminderGroups(
  reminders: readonly RecruitmentReminder[],
  handledIds: ReadonlySet<string>,
  now = Date.now(),
): DueReminderGroup[] {
  const dueByEvent = new Map<string, RecruitmentReminder[]>();
  for (const reminder of reminders) {
    if (handledIds.has(reminder.id)) continue;
    const dueAt = Date.parse(reminder.dueAt);
    const eventAt = Date.parse(reminder.eventAt);
    if (!Number.isFinite(dueAt) || !Number.isFinite(eventAt) || dueAt > now || eventAt <= now) continue;
    const due = dueByEvent.get(reminder.eventId) ?? [];
    due.push(reminder);
    dueByEvent.set(reminder.eventId, due);
  }
  return [...dueByEvent.values()].map(due => {
    due.sort((left, right) => Date.parse(right.dueAt) - Date.parse(left.dueAt));
    return { reminder: due[0], handledIds: due.map(item => item.id) };
  });
}

export function reminderLeadLabel(offsetMinutes: RecruitmentReminderOffsetMinutes): string {
  return offsetMinutes === 1440 ? '24 小时' : '5 小时';
}

export function recruitmentReminderMessage(reminder: RecruitmentReminder): {
  title: string;
  body: string;
} {
  const scheduledAt = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(reminder.eventAt));
  const action = reminder.timeKind === 'deadline' ? '截止' : '开始';
  return {
    title: `${reminder.companyName} · ${reminder.label}${action}提醒`,
    body: `${reminder.jobTitle}，${scheduledAt} ${action}（提前 ${reminderLeadLabel(reminder.offsetMinutes)}提醒）`,
  };
}

export function pushPlusReminderMessage(reminder: RecruitmentReminder): {
  title: string;
  body: string;
} {
  const scheduledAt = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(reminder.eventAt));
  const action = reminder.timeKind === 'deadline' ? '截止' : '开始';
  return {
    title: `${reminder.companyName} · ${reminder.label}${action}提醒`,
    body: `${scheduledAt} ${action}（提前 ${reminderLeadLabel(reminder.offsetMinutes)}提醒）`,
  };
}

function scheduleEntries(record: ApplicationRecord): Array<{
  kind: string;
  label: string;
  entry: RecruitmentScheduleEntry;
}> {
  const schedule = record.recruitmentSchedule;
  if (!schedule) return [];
  const values: Record<string, RecruitmentScheduleEntry | undefined> = {
    writtenTest: schedule.writtenTest,
    assessment: schedule.assessment,
    ...schedule.interviews,
  };
  return SCHEDULE_LABELS.flatMap(([kind, label]) => {
    const entry = values[kind];
    return entry?.scheduledAt && !entry.completedAt ? [{ kind, label, entry }] : [];
  });
}

function remindersForEntry(
  record: ApplicationRecord,
  kind: string,
  label: string,
  entry: RecruitmentScheduleEntry,
): RecruitmentReminder[] {
  const eventTime = Date.parse(entry.scheduledAt);
  if (!Number.isFinite(eventTime)) return [];
  const timeKind = entry.timeKind ?? 'start';
  const eventId = [record.id, kind, entry.scheduledAt, timeKind].map(encodeURIComponent).join(':');
  return RECRUITMENT_REMINDER_OFFSETS_MINUTES.map(offsetMinutes => ({
    id: `${eventId}:${offsetMinutes}`,
    eventId,
    recordId: record.id,
    companyName: record.companyName,
    jobTitle: record.jobTitle,
    label,
    scheduledAt: entry.scheduledAt,
    eventAt: new Date(eventTime).toISOString(),
    dueAt: new Date(eventTime - offsetMinutes * 60_000).toISOString(),
    offsetMinutes,
    url: entry.url,
    timeKind,
  }));
}
