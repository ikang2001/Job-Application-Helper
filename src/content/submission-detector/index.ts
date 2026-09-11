export { createSubmissionDetectorController } from './controller.ts';
export type {
  SubmissionDetectorController,
  SubmissionDetectorControllerOptions,
} from './controller.ts';
export {
  collectAccessibleDocuments,
  collectBaselineSuccessFingerprints,
  createButtonClickSignal,
  createPageStructureSignal,
  detectNavigationSignals,
  detectSubmissionTextSignals,
  findApplicationEmail,
  findSubmissionControl,
  getSubmissionControlLabel,
  isFinalSubmissionControl,
  isSubmissionFormUnavailable,
  scanMutationsForSubmissionSignals,
  scanNodeForSubmissionSignals,
} from './signals.ts';
export {
  createPendingSubmission,
  createSubmissionContext,
} from './model.ts';
export {
  beginSubmissionSession,
  classifySubmissionScore,
  scoreSubmissionSignals,
  SUBMISSION_SIGNAL_WEIGHTS,
  transitionSubmissionSession,
} from './stateMachine.ts';
export {
  DEFAULT_OBSERVATION_WINDOW_MS,
  DEFAULT_PENDING_TTL_MS,
  HIGH_CONFIDENCE_SUBMISSION_THRESHOLD,
  SUBMISSION_CANDIDATE_THRESHOLD,
} from './types.ts';
export type {
  PendingSubmission,
  SubmissionAttemptSnapshot,
  SubmissionBaseline,
  SubmissionCandidateConfidence,
  SubmissionContext,
  SubmissionMetadataSnapshot,
  SubmissionSession,
  SubmissionSessionAction,
  SubmissionSessionStatus,
  SubmissionSignal,
  SubmissionSignalType,
} from './types.ts';
