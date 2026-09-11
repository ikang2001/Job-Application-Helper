import type { MailProviderKind, RecruitmentEventType } from './types.ts';

export interface SourceKeyLike {
  sourceKey: string;
}

export function buildMailSourceKey(
  provider: MailProviderKind,
  accountId: string,
  stableMessageId: string,
  eventType: RecruitmentEventType,
): string {
  return [
    'email',
    provider,
    encodeSourceSegment(accountId),
    encodeSourceSegment(stableMessageId),
    eventType,
  ].join(':');
}

export function buildMailMessageSourcePrefix(
  provider: MailProviderKind,
  accountId: string,
  stableMessageId: string,
): string {
  return [
    'email',
    provider,
    encodeSourceSegment(accountId),
    encodeSourceSegment(stableMessageId),
    '',
  ].join(':');
}

export function hasSourceKey(
  sourceKey: string,
  values: Iterable<string | SourceKeyLike>,
): boolean {
  for (const value of values) {
    if ((typeof value === 'string' ? value : value.sourceKey) === sourceKey) return true;
  }
  return false;
}

export function hasProcessedMailMessage(
  provider: MailProviderKind,
  accountId: string,
  stableMessageId: string,
  values: Iterable<string | SourceKeyLike>,
): boolean {
  const prefix = buildMailMessageSourcePrefix(provider, accountId, stableMessageId);
  for (const value of values) {
    if ((typeof value === 'string' ? value : value.sourceKey).startsWith(prefix)) return true;
  }
  return false;
}

export function appendUniqueBySourceKey<T extends SourceKeyLike>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set(existing.map(value => value.sourceKey));
  const result = [...existing];
  for (const value of incoming) {
    if (seen.has(value.sourceKey)) continue;
    seen.add(value.sourceKey);
    result.push(value);
  }
  return result;
}

function encodeSourceSegment(value: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) throw new TypeError('source key segment must not be empty');
  return encodeURIComponent(normalized);
}
