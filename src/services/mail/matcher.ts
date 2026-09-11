import {
  RECRUITMENT_MAIL_CATEGORY,
  type ExtractedRecruitmentData,
  type MailClassification,
  type MailDecision,
  type MailMatchSignal,
  type MailMatchableApplicationRecord,
  type MailRecordMatch,
  type MailRecordScore,
  type NormalizedEmail,
} from './types.ts';

export const MAIL_MATCH_PENDING_THRESHOLD = 0.75;
export const MAIL_MATCH_AUTO_THRESHOLD = 0.95;
export const MAIL_CLASSIFICATION_AUTO_THRESHOLD = 0.95;
export const MAIL_DECISION_AUTO_THRESHOLD = 0.95;

export function matchEmailToApplication(
  email: NormalizedEmail,
  extracted: ExtractedRecruitmentData,
  records: readonly MailMatchableApplicationRecord[],
): MailRecordMatch {
  const scores = records
    .map(record => scoreRecord(email, extracted, record))
    .sort((left, right) => right.score - left.score || left.recordId.localeCompare(right.recordId));
  const top = scores[0];
  const runnerUp = scores[1];
  if (!top || top.score <= 0) {
    return { matchConfidence: 0, ambiguous: false, scores };
  }

  const ambiguous = Boolean(
    runnerUp
    && runnerUp.score >= MAIL_MATCH_PENDING_THRESHOLD
    && top.score - runnerUp.score < 0.1,
  );
  return {
    recordId: top.recordId,
    matchConfidence: ambiguous ? Math.min(top.score, 0.94) : top.score,
    ambiguous,
    scores,
  };
}

export function decideMailAction(
  classification: MailClassification,
  match: MailRecordMatch,
): MailDecision {
  const classificationConfidence = clamp01(classification.classificationConfidence);
  const matchConfidence = clamp01(match.matchConfidence);
  const decisionConfidence = match.recordId
    ? clamp01(Math.min(classificationConfidence, matchConfidence))
    : 0;
  const isRecruitment = classification.category !== RECRUITMENT_MAIL_CATEGORY.NOT_RECRUITING
    && classification.category !== RECRUITMENT_MAIL_CATEGORY.UNKNOWN;
  const reasons: string[] = [];

  if (!isRecruitment) reasons.push('classification-not-actionable');
  if (!match.recordId) reasons.push('no-record-match');
  if (match.ambiguous) reasons.push('ambiguous-record-match');
  if (classificationConfidence < MAIL_CLASSIFICATION_AUTO_THRESHOLD) reasons.push('classification-below-auto');
  if (matchConfidence < MAIL_MATCH_AUTO_THRESHOLD) reasons.push('match-below-auto');
  if (decisionConfidence < MAIL_DECISION_AUTO_THRESHOLD) reasons.push('decision-below-auto');

  const canAutoUpdate = isRecruitment
    && !match.ambiguous
    && Boolean(match.recordId)
    && classificationConfidence >= MAIL_CLASSIFICATION_AUTO_THRESHOLD
    && matchConfidence >= MAIL_MATCH_AUTO_THRESHOLD
    && decisionConfidence >= MAIL_DECISION_AUTO_THRESHOLD;
  if (canAutoUpdate) {
    return {
      disposition: 'auto-update',
      classificationConfidence,
      matchConfidence,
      decisionConfidence,
      reasons: ['all-auto-thresholds-met'],
    };
  }

  if (isRecruitment && Boolean(match.recordId) && matchConfidence >= MAIL_MATCH_PENDING_THRESHOLD) {
    return {
      disposition: 'pending-review',
      classificationConfidence,
      matchConfidence,
      decisionConfidence,
      reasons,
    };
  }
  return {
    disposition: 'ignore',
    classificationConfidence,
    matchConfidence,
    decisionConfidence,
    reasons,
  };
}

function scoreRecord(
  email: NormalizedEmail,
  extracted: ExtractedRecruitmentData,
  record: MailMatchableApplicationRecord,
): MailRecordScore {
  const signals: MailMatchSignal[] = [];
  let identifierConflict = false;

  addIdentifierSignal('job-id', extracted.jobId, record.jobId, signals, () => {
    identifierConflict = true;
  });
  addIdentifierSignal('application-id', extracted.applicationId, record.applicationId, signals, () => {
    identifierConflict = true;
  });
  addCompanySignal(extracted.companyName, record.companyName, signals);
  addJobTitleSignal(extracted.jobTitle, record.jobTitle, signals);
  addApplicationEmailSignal(email, record.applicationEmail, signals);
  addSenderDomainSignal(email.from.address, record, signals);
  addTimeSignal(email.receivedAt, record.appliedAt ?? record.createdAt, signals);

  const rawScore = signals.reduce((sum, signal) => sum + signal.score, 0);
  return {
    recordId: record.id,
    score: identifierConflict ? Math.min(0.49, clamp01(rawScore)) : clamp01(rawScore),
    signals,
  };
}

function addIdentifierSignal(
  kind: 'job-id' | 'application-id',
  extracted: string | undefined,
  stored: string | undefined,
  signals: MailMatchSignal[],
  onConflict: () => void,
): void {
  if (!extracted || !stored) return;
  if (normalizeIdentifier(extracted) === normalizeIdentifier(stored)) {
    signals.push({ kind, score: 0.6 });
  } else {
    signals.push({ kind: 'identifier-conflict', score: -0.6 });
    onConflict();
  }
}

function addCompanySignal(
  extracted: string | undefined,
  stored: string,
  signals: MailMatchSignal[],
): void {
  if (!extracted || !stored) return;
  if (normalizeComparable(extracted) === normalizeComparable(stored)) {
    signals.push({ kind: 'company-exact', score: 0.25 });
    return;
  }
  if (normalizeCompany(extracted) === normalizeCompany(stored)) {
    signals.push({ kind: 'company-normalized', score: 0.2 });
  }
}

function addJobTitleSignal(
  extracted: string | undefined,
  stored: string,
  signals: MailMatchSignal[],
): void {
  if (!extracted || !stored) return;
  const left = normalizeJobTitle(extracted);
  const right = normalizeJobTitle(stored);
  if (!left || !right) return;
  if (left === right || (Math.min(left.length, right.length) >= 4 && (left.includes(right) || right.includes(left)))) {
    signals.push({ kind: 'job-title-strong', score: 0.25 });
    return;
  }
  const similarity = diceCoefficient(left, right);
  if (similarity >= 0.55) {
    const score = Math.round((0.1 + (similarity - 0.55) / 0.45 * 0.1) * 100) / 100;
    signals.push({ kind: 'job-title-fuzzy', score: Math.min(0.2, score) });
  }
}

function addApplicationEmailSignal(
  email: NormalizedEmail,
  applicationEmail: string | undefined,
  signals: MailMatchSignal[],
): void {
  if (!applicationEmail) return;
  const expected = applicationEmail.trim().toLowerCase();
  if (email.to.some(address => address.trim().toLowerCase() === expected)) {
    signals.push({ kind: 'application-email', score: 0.1 });
  }
}

function addSenderDomainSignal(
  senderAddress: string,
  record: MailMatchableApplicationRecord,
  signals: MailMatchSignal[],
): void {
  const senderDomain = addressDomain(senderAddress);
  if (!senderDomain) return;
  const sourceDomain = hostname(record.sourceSite ?? '');
  const companyToken = normalizeCompany(record.companyName);
  const senderToken = normalizeCompany(senderDomain.split('.')[0] ?? '');
  if (
    (sourceDomain && registrableDomain(senderDomain) === registrableDomain(sourceDomain))
    || (companyToken.length >= 3 && senderToken.length >= 3
      && (companyToken.includes(senderToken) || senderToken.includes(companyToken)))
  ) {
    signals.push({ kind: 'sender-domain', score: 0.1 });
  }
}

function addTimeSignal(
  receivedAt: string,
  appliedAt: string | undefined,
  signals: MailMatchSignal[],
): void {
  if (!appliedAt) return;
  const received = Date.parse(receivedAt);
  const applied = Date.parse(appliedAt);
  if (!Number.isFinite(received) || !Number.isFinite(applied)) return;
  const deltaDays = (received - applied) / 86_400_000;
  if (deltaDays >= -1 && deltaDays <= 730) {
    signals.push({ kind: 'time-plausible', score: 0.05 });
  }
}

function normalizeComparable(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeCompany(value: string): string {
  return normalizeComparable(value)
    .replace(/(?:股份)?有限公司|有限责任公司|集团|公司|corporation|corp\.?|inc\.?|ltd\.?|limited|llc/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeJobTitle(value: string): string {
  return normalizeComparable(value)
    .replace(/(?:职位|岗位|position|role)/gi, '')
    .replace(/[^\p{L}\p{N}+#]+/gu, '');
}

function normalizeIdentifier(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function diceCoefficient(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const count = counts.get(pair) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(pair, count - 1);
    }
  }
  return 2 * overlap / (left.length + right.length - 2);
}

function addressDomain(address: string): string | undefined {
  const domain = address.trim().toLowerCase().split('@')[1];
  return domain ? hostname(domain) : undefined;
}

function hostname(value: string): string {
  const candidate = value.trim().toLowerCase();
  if (!candidate) return '';
  try {
    return new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname;
  } catch {
    return candidate.split('/')[0] ?? '';
  }
}

function registrableDomain(host: string): string {
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const suffix = labels.slice(-2).join('.');
  if (new Set(['co.uk', 'com.cn', 'com.hk', 'com.au']).has(suffix) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return suffix;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}
