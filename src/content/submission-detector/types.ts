export const DEFAULT_OBSERVATION_WINDOW_MS = 120_000;
export const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1_000;
export const SUBMISSION_CANDIDATE_THRESHOLD = 0.75;
export const HIGH_CONFIDENCE_SUBMISSION_THRESHOLD = 0.9;

export type SubmissionSignalType =
  | 'buttonClick'
  | 'successText'
  | 'successRoute'
  | 'pageStructure'
  | 'negativeSignal';

export interface SubmissionSignal {
  type: SubmissionSignalType;
  observedAt: string;
  fingerprint: string;
  detail?: string;
}

export interface SubmissionMetadataSnapshot {
  companyName?: string;
  jobTitle?: string;
  jobId?: string;
  location?: string;
  employmentType?: string;
  sourceSite?: string;
  sourceUrl?: string;
  pageTitle?: string;
  applicationId?: string;
  jdSnapshot?: {
    text: string;
    capturedAt: string;
    sourceUrl: string;
    contentHash: string;
    truncated: boolean;
  };
}

export interface SubmissionContext {
  id: string;
  tabId: number;
  sourceUrl: string;
  startedAt: string;
  resumeProfileId?: string;
  resumeProfileName?: string;
  resumeFileName?: string;
  resumeRevision?: string;
  applicationEmail?: string;
  metadata: Partial<SubmissionMetadataSnapshot>;
  expiresAt: string;
}

export interface PendingSubmission {
  id: string;
  contextId: string;
  score: number;
  signals: SubmissionSignalType[];
  createdAt: string;
  expiresAt: string;
  state: 'pending' | 'confirmed' | 'ignored';
}

export interface SubmissionAttemptSnapshot {
  sourceUrl: string;
  startedAt: string;
  applicationEmail?: string;
  triggerLabel: string;
  metadata?: Partial<SubmissionMetadataSnapshot>;
}

export interface SubmissionBaseline {
  successFingerprints: string[];
  sourceUrl: string;
  pageTitle: string;
}

export type SubmissionSessionStatus =
  | 'observing'
  | 'candidate'
  | 'confirmed'
  | 'ignored'
  | 'expired';

export interface SubmissionSession {
  status: SubmissionSessionStatus;
  context: SubmissionContext;
  baseline: SubmissionBaseline;
  observationExpiresAt: string;
  signals: SubmissionSignal[];
  score: number;
  pending?: PendingSubmission;
}

export type SubmissionCandidateConfidence = 'high' | 'low' | 'ignore';

export type SubmissionSessionAction =
  | {
    type: 'observe';
    signals: SubmissionSignal[];
    observedAt: string;
    pendingId: string;
    pendingTtlMs?: number;
  }
  | { type: 'confirm' }
  | { type: 'ignore' }
  | { type: 'expire'; observedAt: string };
