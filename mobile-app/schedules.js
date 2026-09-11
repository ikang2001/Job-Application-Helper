const TERMINAL_STATUSES = new Set(['已拒绝', '主动放弃', '职位关闭']);

const SCHEDULE_ROWS = [
  { group: 'stage', kind: 'writtenTest', label: '笔试' },
  { group: 'stage', kind: 'assessment', label: '测评' },
  { group: 'interview', kind: 'ai', label: 'AI 面' },
  { group: 'interview', kind: 'first', label: '一面' },
  { group: 'interview', kind: 'second', label: '二面' },
  { group: 'interview', kind: 'third', label: '三面' },
  { group: 'interview', kind: 'hr', label: 'HR 面' },
];

export function scheduleEntries(schedule) {
  if (!schedule) return [];
  return SCHEDULE_ROWS.flatMap(row => {
    const entry = row.group === 'stage' ? schedule[row.kind] : schedule.interviews?.[row.kind];
    return entry ? [{ label: row.label, kind: row.kind, entry }] : [];
  }).sort((left, right) => scheduleTime(left.entry) - scheduleTime(right.entry));
}

export function upcomingScheduleItems(records, now = Date.now()) {
  return scheduleItems(records)
    .filter(item => !TERMINAL_STATUSES.has(item.status) && !item.completedAt && item.eventAt > now)
    .sort(compareScheduleTime);
}

export function completedScheduleItems(records) {
  return scheduleItems(records)
    .filter(item => Boolean(item.completedAt))
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
}

export function filterScheduleItems(items, category) {
  if (category === 'all') return [...items];
  return items.filter(item => scheduleCategory(item) === category);
}

export function scheduleCategory(item) {
  if (item.kind === 'writtenTest' || item.kind === 'assessment') return 'assessment';
  if (item.kind === 'ai') return 'ai';
  return 'interview';
}

export function scheduleDisplayLabel(label, entry) {
  if (entry.timeKind === 'deadline') return `${label}截止`;
  if (entry.timeKind === 'start') return `${label}开始`;
  return label;
}

function scheduleItems(records) {
  return records.flatMap(record => scheduleEntries(record.recruitmentSchedule).flatMap(item => {
    const eventAt = scheduleTime(item.entry);
    if (!Number.isFinite(eventAt)) return [];
    return [{
      recordId: record.id,
      companyName: record.companyName,
      jobTitle: record.jobTitle,
      status: record.status,
      label: item.label,
      kind: item.kind,
      scheduledAt: item.entry.scheduledAt,
      eventAt,
      timeKind: item.entry.timeKind,
      completedAt: item.entry.completedAt,
      url: item.entry.url,
    }];
  }));
}

function scheduleTime(entry) {
  return Date.parse(entry?.scheduledAt || '');
}

function compareScheduleTime(left, right) {
  return left.eventAt - right.eventAt
    || left.companyName.localeCompare(right.companyName, 'zh-CN');
}
