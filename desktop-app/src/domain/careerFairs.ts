import {
  CAREER_FAIR_MODES,
  CAREER_FAIR_STATUSES,
  type CareerFair,
  type DesktopCareerFairInput,
} from '../shared/contracts.ts';

const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function normalizeCareerFairs(value: unknown): CareerFair[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    try {
      return [normalizeStoredCareerFair(item)];
    } catch {
      return [];
    }
  });
}

export function validateCareerFairInput(value: unknown): DesktopCareerFairInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('招聘会记录格式无效');
  const raw = value as Record<string, unknown>;
  const fields = [
    'name', 'status', 'startsAt', 'endsAt', 'mode', 'location', 'organizer',
    'registrationDeadline', 'eventUrl', 'targetCompanies', 'targetRoles', 'preparation', 'notes',
  ] as const;
  for (const field of fields) {
    if (typeof raw[field] !== 'string') throw new Error(`招聘会字段 ${field} 必须是字符串`);
  }
  if (raw.id !== undefined && typeof raw.id !== 'string') throw new Error('招聘会记录 ID 必须是字符串');
  const input = trimCareerFairInput(raw as unknown as DesktopCareerFairInput);
  if (!input.name) throw new Error('招聘会名称不能为空');
  if (!CAREER_FAIR_STATUSES.includes(input.status)) throw new Error('招聘会参加状态无效');
  if (!CAREER_FAIR_MODES.includes(input.mode)) throw new Error('招聘会举办形式无效');
  validateDateTime(input.startsAt, '开始时间', true);
  validateDateTime(input.endsAt, '结束时间');
  validateDateTime(input.registrationDeadline, '报名截止时间');
  if (input.endsAt && Date.parse(input.endsAt) < Date.parse(input.startsAt)) {
    throw new Error('招聘会结束时间不能早于开始时间');
  }
  if (input.eventUrl) validateHttpUrl(input.eventUrl);
  if (input.notes.length > 100_000) throw new Error('招聘会备注超过 100000 字符上限');
  const bounded = Object.entries(input).filter(([key]) => key !== 'notes');
  if (bounded.some(([, fieldValue]) => String(fieldValue ?? '').length > 2_000)) {
    throw new Error('招聘会字段超过 2000 字符上限');
  }
  return input;
}

export function careerFairInput(fair: CareerFair): DesktopCareerFairInput {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = fair;
  return input;
}

export function saveCareerFair(
  fairsInput: readonly CareerFair[],
  inputValue: DesktopCareerFairInput,
  nowIso = new Date().toISOString(),
): { careerFairs: CareerFair[]; careerFair: CareerFair } {
  const fairs = normalizeCareerFairs(fairsInput);
  const input = validateCareerFairInput(inputValue);
  const current = input.id ? fairs.find(fair => fair.id === input.id) : undefined;
  const careerFair: CareerFair = {
    ...input,
    id: current?.id ?? crypto.randomUUID(),
    createdAt: current?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  return {
    careerFairs: current
      ? fairs.map(fair => fair.id === careerFair.id ? careerFair : fair)
      : [...fairs, careerFair],
    careerFair,
  };
}

export function deleteCareerFair(fairsInput: readonly CareerFair[], id: string): CareerFair[] {
  const normalizedId = id.trim();
  if (!normalizedId) throw new Error('招聘会记录 ID 不能为空');
  return normalizeCareerFairs(fairsInput).filter(fair => fair.id !== normalizedId);
}

export function filterAndSortCareerFairs(
  fairsInput: readonly CareerFair[],
  query: string,
  now = new Date(),
): CareerFair[] {
  const keyword = query.trim().toLocaleLowerCase();
  const nowTime = now.getTime();
  return normalizeCareerFairs(fairsInput)
    .filter(fair => !keyword || careerFairSearchValues(fair).some(value => (
      value.toLocaleLowerCase().includes(keyword)
    )))
    .sort((left, right) => compareCareerFairs(left, right, nowTime));
}

export function upcomingCareerFairCount(fairsInput: readonly CareerFair[], now = new Date()): number {
  const nowTime = now.getTime();
  return normalizeCareerFairs(fairsInput).filter(fair => isUpcomingCareerFair(fair, nowTime)).length;
}

function normalizeStoredCareerFair(value: unknown): CareerFair {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('招聘会记录格式无效');
  const raw = value as Partial<CareerFair>;
  const input = validateCareerFairInput({
    id: raw.id,
    name: raw.name ?? '',
    status: raw.status ?? '计划参加',
    startsAt: raw.startsAt ?? '',
    endsAt: raw.endsAt ?? '',
    mode: raw.mode ?? '线下',
    location: raw.location ?? '',
    organizer: raw.organizer ?? '',
    registrationDeadline: raw.registrationDeadline ?? '',
    eventUrl: raw.eventUrl ?? '',
    targetCompanies: raw.targetCompanies ?? '',
    targetRoles: raw.targetRoles ?? '',
    preparation: raw.preparation ?? '',
    notes: raw.notes ?? '',
  });
  if (!input.id || typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') {
    throw new Error('招聘会记录缺少标识或时间');
  }
  if (!Number.isFinite(Date.parse(raw.createdAt)) || !Number.isFinite(Date.parse(raw.updatedAt))) {
    throw new Error('招聘会记录时间无效');
  }
  return { ...input, id: input.id, createdAt: raw.createdAt, updatedAt: raw.updatedAt };
}

function trimCareerFairInput(input: DesktopCareerFairInput): DesktopCareerFairInput {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => (
    [key, typeof value === 'string' ? value.trim() : value]
  ))) as unknown as DesktopCareerFairInput;
}

function validateDateTime(value: string, label: string, required = false): void {
  if (!value && !required) return;
  if (!DATE_TIME_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label}格式无效`);
}

function validateHttpUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('招聘会链接只支持 HTTP 或 HTTPS');
  } catch (error) {
    if (error instanceof Error && error.message.includes('只支持')) throw error;
    throw new Error('招聘会链接格式无效');
  }
}

function careerFairSearchValues(fair: CareerFair): string[] {
  return [
    fair.name, fair.status, fair.mode, fair.location, fair.organizer,
    fair.targetCompanies, fair.targetRoles, fair.preparation, fair.notes,
  ];
}

function compareCareerFairs(left: CareerFair, right: CareerFair, nowTime: number): number {
  const leftTime = Date.parse(left.startsAt);
  const rightTime = Date.parse(right.startsAt);
  const leftUpcoming = isUpcomingCareerFair(left, nowTime);
  const rightUpcoming = isUpcomingCareerFair(right, nowTime);
  if (leftUpcoming !== rightUpcoming) return leftUpcoming ? -1 : 1;
  return leftUpcoming ? leftTime - rightTime : rightTime - leftTime;
}

function isUpcomingCareerFair(fair: CareerFair, nowTime: number): boolean {
  return fair.status !== '已参加'
    && fair.status !== '不参加'
    && Date.parse(fair.endsAt || fair.startsAt) >= nowTime;
}
