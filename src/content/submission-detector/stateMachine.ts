import { addMilliseconds, clampScore, createPendingSubmission } from './model.ts';
import {
  DEFAULT_OBSERVATION_WINDOW_MS,
  DEFAULT_PENDING_TTL_MS,
  HIGH_CONFIDENCE_SUBMISSION_THRESHOLD,
  SUBMISSION_CANDIDATE_THRESHOLD,
  type SubmissionBaseline,
  type SubmissionCandidateConfidence,
  type SubmissionContext,
  type SubmissionSession,
  type SubmissionSessionAction,
  type SubmissionSignal,
  type SubmissionSignalType,
} from './types.ts';

export const SUBMISSION_SIGNAL_WEIGHTS: Readonly<Record<SubmissionSignalType, number>> = {
  buttonClick: 0.2,
  successText: 0.55,
  successRoute: 0.3,
  pageStructure: 0.1,
  negativeSignal: -0.6,
};

export function beginSubmissionSession(
  context: SubmissionContext,
  baseline: SubmissionBaseline,
  observationWindowMs: number = DEFAULT_OBSERVATION_WINDOW_MS,
): SubmissionSession {
  return {
    status: 'observing',
    context,
    baseline: {
      ...baseline,
      successFingerprints: [...baseline.successFingerprints],
    },
    observationExpiresAt: addMilliseconds(context.startedAt, observationWindowMs),
    signals: [],
    score: 0,
  };
}

export function transitionSubmissionSession(
  session: SubmissionSession,
  action: SubmissionSessionAction,
): SubmissionSession {
  if (action.type === 'confirm') return confirmSession(session);
  if (action.type === 'ignore') return ignoreSession(session);
  if (action.type === 'expire') return expireSession(session, action.observedAt);
  return observeSignals(session, action);
}

export function scoreSubmissionSignals(signals: readonly SubmissionSignal[]): number {
  const uniqueTypes = new Set(signals.map(signal => signal.type));
  const score = Array.from(uniqueTypes).reduce(
    (total, type) => total + SUBMISSION_SIGNAL_WEIGHTS[type],
    0,
  );
  return clampScore(Math.round(score * 100) / 100);
}

export function classifySubmissionScore(score: number): SubmissionCandidateConfidence {
  if (score >= HIGH_CONFIDENCE_SUBMISSION_THRESHOLD) return 'high';
  if (score >= SUBMISSION_CANDIDATE_THRESHOLD) return 'low';
  return 'ignore';
}

function observeSignals(
  session: SubmissionSession,
  action: Extract<SubmissionSessionAction, { type: 'observe' }>,
): SubmissionSession {
  if (isTerminal(session.status)) return session;
  if (hasExpired(session, action.observedAt)) {
    return expireSession(session, action.observedAt);
  }

  const signals = mergeUniqueSignals(session, action.signals);
  if (signals.length === session.signals.length) return session;

  const score = scoreSubmissionSignals(signals);
  const confidence = classifySubmissionScore(score);
  if (confidence === 'ignore') {
    return downgradeOrContinue(session, signals, score);
  }

  const signalTypes = signals.map(signal => signal.type);
  const pending = session.pending
    ? {
      ...session.pending,
      score,
      signals: signalTypes,
      state: 'pending' as const,
    }
    : createPendingSubmission(
      {
        id: action.pendingId,
        contextId: session.context.id,
        score,
        signals: signalTypes,
      },
      action.observedAt,
      action.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS,
    );

  return {
    ...session,
    status: 'candidate',
    signals,
    score,
    pending,
  };
}

function mergeUniqueSignals(
  session: SubmissionSession,
  incoming: SubmissionSignal[],
): SubmissionSignal[] {
  const seenTypes = new Set(session.signals.map(signal => signal.type));
  const baseline = new Set(session.baseline.successFingerprints);
  const additions: SubmissionSignal[] = [];

  for (const signal of incoming) {
    if (seenTypes.has(signal.type)) continue;
    if (signal.type === 'successText' && baseline.has(signal.fingerprint)) continue;
    seenTypes.add(signal.type);
    additions.push(signal);
  }
  return additions.length > 0 ? [...session.signals, ...additions] : session.signals;
}

function downgradeOrContinue(
  session: SubmissionSession,
  signals: SubmissionSignal[],
  score: number,
): SubmissionSession {
  if (!session.pending) {
    return { ...session, signals, score };
  }

  return {
    ...session,
    status: 'ignored',
    signals,
    score,
    pending: {
      ...session.pending,
      score,
      signals: signals.map(signal => signal.type),
      state: 'ignored',
    },
  };
}

function confirmSession(session: SubmissionSession): SubmissionSession {
  if (session.status !== 'candidate' || !session.pending) return session;
  return {
    ...session,
    status: 'confirmed',
    pending: { ...session.pending, state: 'confirmed' },
  };
}

function ignoreSession(session: SubmissionSession): SubmissionSession {
  if (isTerminal(session.status)) return session;
  return {
    ...session,
    status: 'ignored',
    pending: session.pending ? { ...session.pending, state: 'ignored' } : undefined,
  };
}

function expireSession(session: SubmissionSession, observedAt: string): SubmissionSession {
  if (isTerminal(session.status) || !hasExpired(session, observedAt)) return session;
  return {
    ...session,
    status: 'expired',
    pending: session.pending ? { ...session.pending, state: 'ignored' } : undefined,
  };
}

function hasExpired(session: SubmissionSession, observedAt: string): boolean {
  return new Date(observedAt).getTime() >= new Date(session.observationExpiresAt).getTime();
}

function isTerminal(status: SubmissionSession['status']): boolean {
  return status === 'confirmed' || status === 'ignored' || status === 'expired';
}
