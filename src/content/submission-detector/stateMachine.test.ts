import assert from 'node:assert/strict';
import test from 'node:test';
import { createPendingSubmission, createSubmissionContext } from './model.ts';
import {
  beginSubmissionSession,
  classifySubmissionScore,
  scoreSubmissionSignals,
  transitionSubmissionSession,
} from './stateMachine.ts';
import type {
  SubmissionBaseline,
  SubmissionSession,
  SubmissionSignal,
  SubmissionSignalType,
} from './types.ts';

const STARTED_AT = '2026-09-03T10:00:00.000Z';
const BASELINE: SubmissionBaseline = {
  successFingerprints: [],
  sourceUrl: 'https://jobs.example.com/apply',
  pageTitle: 'Apply',
};

function signal(type: SubmissionSignalType, fingerprint = type): SubmissionSignal {
  return {
    type,
    observedAt: STARTED_AT,
    fingerprint,
  };
}

function session(baseline = BASELINE): SubmissionSession {
  const context = createSubmissionContext({
    id: 'context-1',
    tabId: 7,
    sourceUrl: BASELINE.sourceUrl,
    resumeProfileId: ' profile-1 ',
    resumeRevision: ' revision-3 ',
    applicationEmail: ' candidate@example.com ',
    metadata: { companyName: 'Acme', jobTitle: 'Engineer' },
  }, STARTED_AT);
  return beginSubmissionSession(context, baseline, 120_000);
}

function observe(current: SubmissionSession, signals: SubmissionSignal[], at = STARTED_AT) {
  return transitionSubmissionSession(current, {
    type: 'observe',
    signals,
    observedAt: at,
    pendingId: 'pending-1',
  });
}

test('SubmissionContext and PendingSubmission factories are deterministic and apply a 24-hour TTL', () => {
  const context = session().context;
  assert.equal(context.resumeProfileId, 'profile-1');
  assert.equal(context.applicationEmail, 'candidate@example.com');
  assert.equal(context.expiresAt, '2026-09-04T10:00:00.000Z');

  const pending = createPendingSubmission({
    id: 'pending-1',
    contextId: context.id,
    score: 1.4,
    signals: ['buttonClick', 'successText', 'successText'],
  }, STARTED_AT);
  assert.equal(pending.score, 1);
  assert.deepEqual(pending.signals, ['buttonClick', 'successText']);
  assert.equal(pending.expiresAt, '2026-09-04T10:00:00.000Z');
});

test('signal scoring follows fixed weights, clamps to [0, 1], and never stacks duplicates', () => {
  assert.equal(scoreSubmissionSignals([
    signal('buttonClick'),
    signal('successText'),
    signal('successText', 'another-success-node'),
  ]), 0.75);
  assert.equal(scoreSubmissionSignals([
    signal('buttonClick'),
    signal('successText'),
    signal('successRoute'),
    signal('pageStructure'),
  ]), 1);
  assert.equal(scoreSubmissionSignals([
    signal('buttonClick'),
    signal('negativeSignal'),
  ]), 0);
  assert.equal(classifySubmissionScore(0.74), 'ignore');
  assert.equal(classifySubmissionScore(0.75), 'low');
  assert.equal(classifySubmissionScore(0.9), 'high');
});

test('button and success text create a low-confidence candidate, then route raises it to high confidence', () => {
  const low = observe(session(), [signal('buttonClick'), signal('successText')]);
  assert.equal(low.status, 'candidate');
  assert.equal(low.score, 0.75);
  assert.equal(low.pending?.state, 'pending');

  const high = observe(low, [signal('successRoute')], '2026-09-03T10:00:01.000Z');
  assert.equal(high.status, 'candidate');
  assert.equal(high.score, 1);
  assert.equal(high.pending?.id, low.pending?.id);
});

test('baseline success text and repeated signal categories cannot create or inflate a candidate', () => {
  const fingerprint = 'successText:existing-alert:application submitted';
  const current = session({ ...BASELINE, successFingerprints: [fingerprint] });
  const afterBaseline = observe(current, [
    signal('buttonClick'),
    signal('successText', fingerprint),
  ]);
  assert.equal(afterBaseline.score, 0.2);
  assert.equal(afterBaseline.pending, undefined);

  const afterDuplicates = observe(afterBaseline, [
    signal('buttonClick', 'second-button'),
    signal('buttonClick', 'third-button'),
  ]);
  assert.equal(afterDuplicates, afterBaseline);
});

test('negative signal suppresses success and downgrades an already-created candidate to ignored', () => {
  const simultaneous = observe(session(), [
    signal('buttonClick'),
    signal('successText'),
    signal('negativeSignal'),
  ]);
  assert.equal(simultaneous.score, 0.15);
  assert.equal(simultaneous.pending, undefined);

  const candidate = observe(session(), [signal('buttonClick'), signal('successText')]);
  const downgraded = observe(candidate, [signal('negativeSignal')]);
  assert.equal(downgraded.status, 'ignored');
  assert.equal(downgraded.pending?.state, 'ignored');
  assert.equal(downgraded.score, 0.15);
});

test('state machine supports explicit confirmation, ignore, and observation timeout', () => {
  const candidate = observe(session(), [signal('buttonClick'), signal('successText')]);
  const confirmed = transitionSubmissionSession(candidate, { type: 'confirm' });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.pending?.state, 'confirmed');
  assert.equal(transitionSubmissionSession(confirmed, { type: 'ignore' }), confirmed);

  const ignored = transitionSubmissionSession(candidate, { type: 'ignore' });
  assert.equal(ignored.status, 'ignored');
  assert.equal(ignored.pending?.state, 'ignored');

  const expired = transitionSubmissionSession(candidate, {
    type: 'expire',
    observedAt: '2026-09-03T10:02:00.000Z',
  });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.pending?.state, 'ignored');

  const lateSignal = observe(
    session(),
    [signal('buttonClick'), signal('successText')],
    '2026-09-03T10:02:00.000Z',
  );
  assert.equal(lateSignal.status, 'expired');
  assert.equal(lateSignal.pending, undefined);
});
