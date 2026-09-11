import {
  DEFAULT_PENDING_TTL_MS,
  type PendingSubmission,
  type SubmissionContext,
  type SubmissionMetadataSnapshot,
  type SubmissionSignalType,
} from './types.ts';

export interface CreateSubmissionContextInput {
  id: string;
  tabId: number;
  sourceUrl: string;
  resumeProfileId?: string;
  resumeRevision?: string;
  applicationEmail?: string;
  metadata?: Partial<SubmissionMetadataSnapshot>;
}

export interface CreatePendingSubmissionInput {
  id: string;
  contextId: string;
  score: number;
  signals: SubmissionSignalType[];
}

export function createSubmissionContext(
  input: CreateSubmissionContextInput,
  startedAt: string,
  ttlMs: number = DEFAULT_PENDING_TTL_MS,
): SubmissionContext {
  return {
    id: input.id,
    tabId: input.tabId,
    sourceUrl: input.sourceUrl,
    startedAt,
    resumeProfileId: normalizeOptional(input.resumeProfileId),
    resumeRevision: normalizeOptional(input.resumeRevision),
    applicationEmail: normalizeOptional(input.applicationEmail),
    metadata: { ...input.metadata },
    expiresAt: addMilliseconds(startedAt, ttlMs),
  };
}

export function createPendingSubmission(
  input: CreatePendingSubmissionInput,
  createdAt: string,
  ttlMs: number = DEFAULT_PENDING_TTL_MS,
): PendingSubmission {
  return {
    id: input.id,
    contextId: input.contextId,
    score: clampScore(input.score),
    signals: [...new Set(input.signals)],
    createdAt,
    expiresAt: addMilliseconds(createdAt, ttlMs),
    state: 'pending',
  };
}

export function addMilliseconds(isoTimestamp: string, milliseconds: number): string {
  return new Date(new Date(isoTimestamp).getTime() + milliseconds).toISOString();
}

export function clampScore(score: number): number {
  return Math.min(1, Math.max(0, score));
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
