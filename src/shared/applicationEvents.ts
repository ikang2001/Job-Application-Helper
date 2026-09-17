import type {
  ApplicationEvent,
  ApplicationEventMetadata,
  ApplicationEventSource,
  ApplicationEventTombstone,
  ApplicationEventTombstoneReason,
  ApplicationEventType,
  ApplicationRecord,
  ApplicationRecordStatus,
} from './types.ts';

export const APPLICATION_RECORD_STATUSES: ApplicationRecordStatus[] = [
  '待投递',
  '已投递',
  '等待中',
  '笔试/测评',
  '面试中',
  'offer',
  '主动放弃',
  '职位关闭',
  '终止',
];

export const TERMINAL_APPLICATION_RECORD_STATUSES = new Set<ApplicationRecordStatus>([
  '主动放弃',
  '职位关闭',
  '终止',
]);

const APPLICATION_EVENT_TYPES = new Set<ApplicationEventType>([
  'application_created',
  'applied',
  'application_received',
  'assessment_invite',
  'assessment_completed',
  'interview_invite',
  'interview',
  'offer',
  'rejection',
  'withdrawn',
  'job_closed',
  'note',
  'status_override',
]);

const APPLICATION_EVENT_SOURCES = new Set<ApplicationEventSource>([
  'manual',
  'website',
  'email',
  'migration',
]);

const EVENT_STATUS: Partial<Record<ApplicationEventType, ApplicationRecordStatus>> = {
  application_created: '待投递',
  applied: '已投递',
  application_received: '已投递',
  assessment_invite: '笔试/测评',
  assessment_completed: '笔试/测评',
  interview_invite: '面试中',
  interview: '面试中',
  offer: 'offer',
  rejection: '主动放弃',
  withdrawn: '主动放弃',
  job_closed: '职位关闭',
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  return normalized || undefined;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function inferTimePrecision(occurredAt: string): ApplicationEvent['timePrecision'] {
  return /^\d{4}-\d{2}-\d{2}$/.test(occurredAt) ? 'date' : 'datetime';
}

function normalizeEventMetadata(value: unknown): ApplicationEventMetadata | undefined {
  const metadata = asRecord(value);
  if (Object.keys(metadata).length === 0) return undefined;

  const status = legacyApplicationRecordStatus(metadata.status);
  return {
    ...metadata,
    status,
    jobId: optionalString(metadata.jobId),
    applicationId: optionalString(metadata.applicationId),
    interviewAt: optionalString(metadata.interviewAt),
    deadlineAt: optionalString(metadata.deadlineAt),
    meetingUrl: optionalString(metadata.meetingUrl),
    emailSubject: optionalString(metadata.emailSubject),
    summary: optionalString(metadata.summary),
    classification: optionalString(metadata.classification),
  };
}

function legacyApplicationRecordStatus(value: unknown): ApplicationRecordStatus | undefined {
  if (value === '已拒绝' || value === '拒绝' || value === 'rejected' || value === 'rejection') {
    return '主动放弃';
  }
  return isApplicationRecordStatus(value) ? value : undefined;
}

function compareOccurredAt(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.localeCompare(right);
}

function compareEvents(left: ApplicationEvent, right: ApplicationEvent): number {
  const byTime = compareOccurredAt(left.occurredAt, right.occurredAt);
  if (byTime !== 0) return byTime;

  const bySourceKey = left.sourceKey.localeCompare(right.sourceKey);
  if (bySourceKey !== 0) return bySourceKey;

  return [left.id, left.type, left.source, left.title, left.note ?? ''].join('\0')
    .localeCompare([right.id, right.type, right.source, right.title, right.note ?? ''].join('\0'));
}

function eventStatus(event: ApplicationEvent): ApplicationRecordStatus | null {
  if (event.type === 'status_override') {
    return isApplicationRecordStatus(event.metadata?.status) ? event.metadata.status : null;
  }
  return EVENT_STATUS[event.type] ?? null;
}

export function isApplicationRecordStatus(value: unknown): value is ApplicationRecordStatus {
  return typeof value === 'string'
    && APPLICATION_RECORD_STATUSES.includes(value as ApplicationRecordStatus);
}

export function buildApplicationEventId(sourceKey: string): string {
  return `evt_${stableHash(sourceKey)}_${sourceKey.length.toString(36)}`;
}

export function normalizeApplicationEvent(
  input: unknown,
  recordId = 'unknown',
): ApplicationEvent {
  const event = asRecord(input);
  const type = APPLICATION_EVENT_TYPES.has(event.type as ApplicationEventType)
    ? event.type as ApplicationEventType
    : 'note';
  const occurredAt = normalizeString(event.occurredAt) || '1970-01-01';
  const rawId = normalizeString(event.id);
  const fallbackIdentity = [
    type,
    occurredAt,
    normalizeString(event.title),
    normalizeString(event.note),
    rawId,
  ].join('\0');
  const sourceKey = normalizeString(event.sourceKey)
    || `migration:${recordId}:event:${rawId || stableHash(fallbackIdentity)}`;
  const source = APPLICATION_EVENT_SOURCES.has(event.source as ApplicationEventSource)
    ? event.source as ApplicationEventSource
    : 'migration';
  const timePrecision = event.timePrecision === 'date' || event.timePrecision === 'datetime'
    ? event.timePrecision
    : inferTimePrecision(occurredAt);

  return {
    ...event,
    id: rawId || buildApplicationEventId(sourceKey),
    type,
    occurredAt,
    timePrecision,
    source,
    title: normalizeString(event.title) || type,
    note: optionalString(event.note),
    sourceKey,
    emailAccountId: optionalString(event.emailAccountId),
    emailMessageId: optionalString(event.emailMessageId),
    classificationConfidence: normalizeConfidence(event.classificationConfidence),
    matchConfidence: normalizeConfidence(event.matchConfidence),
    decisionConfidence: normalizeConfidence(event.decisionConfidence),
    metadata: normalizeEventMetadata(event.metadata),
  };
}

export function normalizeApplicationEvents(input: unknown, recordId = 'unknown'): ApplicationEvent[] {
  if (!Array.isArray(input)) return [];

  const events = input.map(event => normalizeApplicationEvent(event, recordId)).sort(compareEvents);
  const bySourceKey = new Map<string, ApplicationEvent>();
  for (const event of events) {
    if (!bySourceKey.has(event.sourceKey)) bySourceKey.set(event.sourceKey, event);
  }
  return [...bySourceKey.values()];
}

/**
 * Status is a projection of lifecycle facts. Manual overrides always win; otherwise
 * a terminal fact remains sticky until the user explicitly creates an override.
 */
export function deriveApplicationStatus(events: readonly ApplicationEvent[]): ApplicationRecordStatus {
  const ordered = [...events].sort(compareEvents);
  const latestOverride = ordered
    .filter(event => event.type === 'status_override' && eventStatus(event) !== null)
    .at(-1);
  if (latestOverride) return eventStatus(latestOverride)!;

  const statusEvents = ordered
    .map(event => ({ event, status: eventStatus(event) }))
    .filter((entry): entry is { event: ApplicationEvent; status: ApplicationRecordStatus } => entry.status !== null);
  const latestTerminal = statusEvents
    .filter(entry => TERMINAL_APPLICATION_RECORD_STATUSES.has(entry.status))
    .at(-1);
  if (latestTerminal) return latestTerminal.status;

  return statusEvents.at(-1)?.status ?? '待投递';
}

export type NewApplicationEvent = Omit<ApplicationEvent, 'id' | 'timePrecision'>
  & Partial<Pick<ApplicationEvent, 'id' | 'timePrecision'>>;

export function createApplicationEvent(input: NewApplicationEvent): ApplicationEvent {
  if (!normalizeString(input.sourceKey)) {
    throw new Error('ApplicationEvent sourceKey 不能为空');
  }
  return normalizeApplicationEvent(input);
}

export function buildManualApplicationEventSourceKey(recordId: string, clientMutationId: string): string {
  const normalizedRecordId = normalizeString(recordId);
  const normalizedMutationId = normalizeString(clientMutationId);
  if (!normalizedRecordId || !normalizedMutationId) {
    throw new Error('人工事件必须包含 recordId 和 clientMutationId');
  }
  return `manual:${normalizedRecordId}:${normalizedMutationId}`;
}

export function createStatusOverrideEvent(
  recordId: string,
  status: ApplicationRecordStatus,
  occurredAt: string,
  clientMutationId: string,
  note?: string,
): ApplicationEvent {
  const sourceKey = buildManualApplicationEventSourceKey(recordId, clientMutationId);
  return createApplicationEvent({
    type: 'status_override',
    occurredAt,
    timePrecision: inferTimePrecision(occurredAt),
    source: 'manual',
    title: `手动调整状态为${status}`,
    note,
    sourceKey,
    metadata: { status },
  });
}

export function addApplicationEvent(
  record: ApplicationRecord,
  eventInput: ApplicationEvent | NewApplicationEvent,
  updatedAt = eventInput.occurredAt,
): ApplicationRecord {
  const event = normalizeApplicationEvent(eventInput, record.id);
  if (record.events.some(existingEvent => existingEvent.sourceKey === event.sourceKey)) return record;

  const events = normalizeApplicationEvents([...record.events, event], record.id);
  return {
    ...record,
    events,
    status: deriveApplicationStatus(events),
    updatedAt,
  };
}

export const upsertApplicationEvent = addApplicationEvent;

export function removeApplicationEvent(
  record: ApplicationRecord,
  sourceKey: string,
  updatedAt: string,
): ApplicationRecord {
  const events = record.events.filter(event => event.sourceKey !== sourceKey);
  if (events.length === record.events.length) return record;

  return {
    ...record,
    events,
    status: deriveApplicationStatus(events),
    updatedAt,
  };
}

export function normalizeApplicationEventTombstones(input: unknown): ApplicationEventTombstone[] {
  if (!Array.isArray(input)) return [];

  const tombstones = input.flatMap((value): ApplicationEventTombstone[] => {
    const tombstone = asRecord(value);
    const recordId = normalizeString(tombstone.recordId);
    const sourceKey = normalizeString(tombstone.sourceKey);
    if (!recordId || !sourceKey) return [];

    const reason: ApplicationEventTombstoneReason = tombstone.reason === 'ignored'
      || tombstone.reason === 'unlinked'
      || tombstone.reason === 'deleted'
      ? tombstone.reason
      : 'deleted';
    return [{
      recordId,
      sourceKey,
      reason,
      createdAt: normalizeString(tombstone.createdAt) || '1970-01-01',
      expiresAt: optionalString(tombstone.expiresAt),
    }];
  }).sort((left, right) => {
    const byCreatedAt = compareOccurredAt(left.createdAt, right.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;
    return `${left.recordId}\0${left.sourceKey}\0${left.reason}`
      .localeCompare(`${right.recordId}\0${right.sourceKey}\0${right.reason}`);
  });

  const bySource = new Map<string, ApplicationEventTombstone>();
  for (const tombstone of tombstones) {
    bySource.set(`${tombstone.recordId}\0${tombstone.sourceKey}`, tombstone);
  }
  return [...bySource.values()].sort((left, right) => (
    `${left.recordId}\0${left.sourceKey}`.localeCompare(`${right.recordId}\0${right.sourceKey}`)
  ));
}

export function createApplicationEventTombstone(
  recordId: string,
  sourceKey: string,
  reason: ApplicationEventTombstoneReason,
  createdAt: string,
  expiresAt?: string,
): ApplicationEventTombstone {
  const [tombstone] = normalizeApplicationEventTombstones([{
    recordId,
    sourceKey,
    reason,
    createdAt,
    expiresAt,
  }]);
  if (!tombstone) throw new Error('事件 tombstone 必须包含 recordId 和 sourceKey');
  return tombstone;
}

export function isApplicationEventSuppressed(
  tombstones: readonly ApplicationEventTombstone[],
  recordId: string,
  sourceKey: string,
  now = new Date(),
): boolean {
  return tombstones.some((tombstone) => {
    if (tombstone.recordId !== recordId || tombstone.sourceKey !== sourceKey) return false;
    if (!tombstone.expiresAt) return true;
    const expiresAt = Date.parse(tombstone.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt > now.getTime();
  });
}

export function removeApplicationEventTombstone(
  tombstones: readonly ApplicationEventTombstone[],
  recordId: string,
  sourceKey: string,
): ApplicationEventTombstone[] {
  return tombstones.filter(tombstone => (
    tombstone.recordId !== recordId || tombstone.sourceKey !== sourceKey
  ));
}
