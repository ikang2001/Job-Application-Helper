export const MAIL_PROVIDER = {
  GMAIL: 'gmail',
  OUTLOOK: 'outlook',
  IMAP: 'imap',
} as const;

export type MailProviderKind = typeof MAIL_PROVIDER[keyof typeof MAIL_PROVIDER];

export interface EmailAddress {
  name?: string;
  address: string;
}

/** Provider-neutral header used before a potentially expensive body fetch. */
export interface MailHeader {
  id: string;
  threadId?: string;
  from: string;
  to: string[];
  subject: string;
  receivedAt: string;
}

export interface NormalizedEmail {
  id: string;
  threadId?: string;
  accountId: string;
  provider: MailProviderKind;
  from: EmailAddress;
  to: string[];
  subject: string;
  receivedAt: string;
  text?: string;
  html?: string;
}

export interface MailQueryOptions {
  since?: string;
  /** Opaque provider cursor returned by a previous call. */
  cursor?: string;
  limit: number;
  signal?: AbortSignal;
}

/**
 * A page cursor is only valid for the next page in the current round. A sync
 * cursor is a completed checkpoint and is safe to persist after processing the
 * whole page succeeds.
 */
export interface MailPage<T> {
  items: T[];
  nextCursor?: string;
  syncCursor?: string;
}

export interface MailConnectionResult {
  connected: boolean;
  accountId: string;
  emailAddress?: string;
  displayName?: string;
  errorCode?: string;
  message?: string;
}

export const RECRUITMENT_MAIL_CATEGORY = {
  APPLICATION_RECEIVED: 'application_received',
  ASSESSMENT_INVITE: 'assessment_invite',
  INTERVIEW_INVITE: 'interview_invite',
  OFFER: 'offer',
  REJECTION: 'rejection',
  JOB_CLOSED: 'job_closed',
  RECRUITER_MESSAGE: 'recruiter_message',
  UNKNOWN: 'unknown',
  NOT_RECRUITING: 'not_recruiting',
} as const;

export type RecruitmentMailCategory =
  typeof RECRUITMENT_MAIL_CATEGORY[keyof typeof RECRUITMENT_MAIL_CATEGORY];

export type RecruitmentEventType = Exclude<
  RecruitmentMailCategory,
  'unknown' | 'not_recruiting' | 'recruiter_message'
> | 'note';

export interface MailHeaderFilterResult {
  candidate: boolean;
  confidence: number;
  reasons: string[];
}

export interface MailClassification {
  category: RecruitmentMailCategory;
  /** Confidence that this is recruiting mail and that the category is correct. */
  classificationConfidence: number;
  reasons: string[];
}

export interface ExtractedRecruitmentData {
  companyName?: string;
  jobTitle?: string;
  jobId?: string;
  applicationId?: string;
  scheduledAt?: string;
  interviewAt?: string;
  deadlineAt?: string;
  meetingUrl?: string;
  summary?: string;
}

/** Structural subset accepted by the pure matcher. */
export interface MailMatchableApplicationRecord {
  id: string;
  companyName: string;
  jobTitle: string;
  sourceSite?: string;
  appliedAt?: string;
  createdAt?: string;
  jobId?: string;
  applicationId?: string;
  applicationEmail?: string;
}

export interface MailMatchSignal {
  kind:
    | 'job-id'
    | 'application-id'
    | 'company-exact'
    | 'company-normalized'
    | 'job-title-strong'
    | 'job-title-fuzzy'
    | 'application-email'
    | 'sender-domain'
    | 'time-plausible'
    | 'identifier-conflict';
  score: number;
}

export interface MailRecordScore {
  recordId: string;
  score: number;
  signals: MailMatchSignal[];
}

export interface MailRecordMatch {
  recordId?: string;
  matchConfidence: number;
  ambiguous: boolean;
  scores: MailRecordScore[];
}

export interface MailConfidenceSet {
  classificationConfidence: number;
  matchConfidence: number;
  decisionConfidence: number;
}

export type MailDisposition = 'auto-update' | 'pending-review' | 'ignore';

export interface MailDecision extends MailConfidenceSet {
  disposition: MailDisposition;
  reasons: string[];
}

export interface PendingMailReview {
  id: string;
  sourceKey: string;
  state: 'pending';
  email: NormalizedEmail;
  classification: MailClassification;
  extracted: ExtractedRecruitmentData;
  recordId?: string;
  confidences: MailConfidenceSet;
  reasons: string[];
}

export interface ProcessedMailCandidate {
  sourceKey: string;
  eventType: RecruitmentEventType;
  email: NormalizedEmail;
  classification: MailClassification;
  extracted: ExtractedRecruitmentData;
  match: MailRecordMatch;
  decision: MailDecision;
  pendingReview?: PendingMailReview;
}

export interface MailScanResult {
  candidates: ProcessedMailCandidate[];
  pendingReviews: PendingMailReview[];
  nextCursor?: string;
  syncCursor?: string;
  inspectedHeaders: number;
  fetchedMessages: number;
  skippedDuplicates: number;
}
