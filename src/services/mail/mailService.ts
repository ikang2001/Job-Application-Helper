import { classifyRecruitmentEmail, filterRecruitmentHeader } from './classifier.ts';
import {
  buildMailSourceKey,
  hasProcessedMailMessage,
  hasSourceKey,
  type SourceKeyLike,
} from './dedup.ts';
import { extractRecruitmentData } from './extractor.ts';
import { decideMailAction, matchEmailToApplication } from './matcher.ts';
import type { MailProvider } from './provider.ts';
import {
  RECRUITMENT_MAIL_CATEGORY,
  type MailMatchableApplicationRecord,
  type MailQueryOptions,
  type MailScanResult,
  type PendingMailReview,
  type ProcessedMailCandidate,
  type RecruitmentEventType,
  type RecruitmentMailCategory,
} from './types.ts';

export interface ScanMailPageOptions extends MailQueryOptions {
  existingSourceKeys?: Iterable<string | SourceKeyLike>;
  suppressedSourceKeys?: Iterable<string | SourceKeyLike>;
}

/**
 * Processes exactly one provider page. This function never persists the cursor:
 * callers may commit nextCursor/syncCursor only after their own storage write
 * succeeds, so a partial batch cannot silently skip mail.
 */
export async function scanMailPage(
  provider: MailProvider,
  records: readonly MailMatchableApplicationRecord[],
  options: ScanMailPageOptions,
): Promise<MailScanResult> {
  const page = await provider.listHeaders(options);
  const existing = [...(options.existingSourceKeys ?? [])];
  const suppressed = [...(options.suppressedSourceKeys ?? [])];
  const candidates: ProcessedMailCandidate[] = [];
  const pendingReviews: PendingMailReview[] = [];
  const seenMessageIds = new Set<string>();
  let fetchedMessages = 0;
  let skippedDuplicates = 0;

  for (const header of page.items) {
    if (seenMessageIds.has(header.id)) {
      skippedDuplicates += 1;
      continue;
    }
    seenMessageIds.add(header.id);
    if (
      hasProcessedMailMessage(provider.kind, provider.accountId, header.id, existing)
      || hasProcessedMailMessage(provider.kind, provider.accountId, header.id, suppressed)
    ) {
      skippedDuplicates += 1;
      continue;
    }
    if (!filterRecruitmentHeader(header).candidate) continue;

    const email = await provider.getMessage(header.id, options.signal);
    fetchedMessages += 1;
    const classification = classifyRecruitmentEmail(email);
    const eventType = eventTypeForCategory(classification.category);
    if (!eventType) continue;

    const sourceKey = buildMailSourceKey(
      provider.kind,
      provider.accountId,
      email.id,
      eventType,
    );
    if (hasSourceKey(sourceKey, existing) || hasSourceKey(sourceKey, suppressed)) {
      skippedDuplicates += 1;
      continue;
    }
    existing.push({ sourceKey });

    const extracted = extractRecruitmentData(email);
    const match = matchEmailToApplication(email, extracted, records);
    const decision = decideMailAction(classification, match);
    const candidate: ProcessedMailCandidate = {
      sourceKey,
      eventType,
      email,
      classification,
      extracted,
      match,
      decision,
    };
    if (decision.disposition === 'pending-review') {
      const pendingReview: PendingMailReview = {
        id: sourceKey,
        sourceKey,
        state: 'pending',
        email,
        classification,
        extracted,
        recordId: match.recordId,
        confidences: {
          classificationConfidence: decision.classificationConfidence,
          matchConfidence: decision.matchConfidence,
          decisionConfidence: decision.decisionConfidence,
        },
        reasons: decision.reasons,
      };
      candidate.pendingReview = pendingReview;
      pendingReviews.push(pendingReview);
    }
    candidates.push(candidate);
  }

  return {
    candidates,
    pendingReviews,
    nextCursor: page.nextCursor,
    syncCursor: page.syncCursor,
    inspectedHeaders: page.items.length,
    fetchedMessages,
    skippedDuplicates,
  };
}

export function eventTypeForCategory(
  category: RecruitmentMailCategory,
): RecruitmentEventType | undefined {
  if (category === RECRUITMENT_MAIL_CATEGORY.RECRUITER_MESSAGE) return 'note';
  if (
    category === RECRUITMENT_MAIL_CATEGORY.UNKNOWN
    || category === RECRUITMENT_MAIL_CATEGORY.NOT_RECRUITING
  ) return undefined;
  return category;
}
