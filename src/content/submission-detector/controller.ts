import {
  collectAccessibleDocuments,
  collectBaselineSuccessFingerprints,
  createButtonClickSignal,
  createPageStructureSignal,
  detectNavigationSignals,
  findApplicationEmail,
  findSubmissionControl,
  getSubmissionControlLabel,
  isSubmissionFormUnavailable,
  scanMutationsForSubmissionSignals,
} from './signals.ts';
import { beginSubmissionSession, transitionSubmissionSession } from './stateMachine.ts';
import {
  DEFAULT_OBSERVATION_WINDOW_MS,
  DEFAULT_PENDING_TTL_MS,
  type PendingSubmission,
  type SubmissionAttemptSnapshot,
  type SubmissionContext,
  type SubmissionSession,
  type SubmissionSignal,
} from './types.ts';

interface MutationObserverHandle {
  observe(target: Node, options?: MutationObserverInit): void;
  disconnect(): void;
}

export interface SubmissionDetectorControllerOptions {
  rootDocument: Document;
  rootWindow: Window;
  captureMetadata?(
    document: Document,
    url: string,
  ): Partial<SubmissionContext['metadata']> | Promise<Partial<SubmissionContext['metadata']>>;
  onNavigation?(document: Document, url: string): void;
  resolveContext(attempt: SubmissionAttemptSnapshot): SubmissionContext | Promise<SubmissionContext>;
  onPendingSubmission(
    pending: PendingSubmission,
    context: SubmissionContext,
  ): void | Promise<void>;
  onStateChange?(session: SubmissionSession): void;
  onError?(error: unknown): void;
  now?: () => Date;
  createId?: () => string;
  observationWindowMs?: number;
  pendingTtlMs?: number;
  observerFactory?: (callback: MutationCallback) => MutationObserverHandle;
  scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface SubmissionDetectorController {
  start(): void;
  stop(): void;
  confirm(metadata?: Partial<SubmissionContext['metadata']>): PendingSubmission | undefined;
  ignore(): PendingSubmission | undefined;
  getSession(): SubmissionSession | null;
}

export function createSubmissionDetectorController(
  options: SubmissionDetectorControllerOptions,
): SubmissionDetectorController {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? createRandomId;
  const observerFactory = options.observerFactory
    ?? (callback => new MutationObserver(callback));
  const scheduleTimeout = options.scheduleTimeout ?? globalThis.setTimeout.bind(globalThis);
  const cancelTimeout = options.cancelTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const observationWindowMs = options.observationWindowMs ?? DEFAULT_OBSERVATION_WINDOW_MS;
  const pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const documentObservers = new Map<Document, MutationObserverHandle>();
  const navigationCleanups = new Map<Window, () => void>();
  const lastUrls = new Map<Window, string>();
  let session: SubmissionSession | null = null;
  let activeForm: Element | null = null;
  let observationTimer: ReturnType<typeof setTimeout> | null = null;
  let attemptVersion = 0;
  let starting = false;
  let queuedSignals: SubmissionSignal[] = [];
  let started = false;

  function start(): void {
    if (started) return;
    started = true;
    refreshDocuments();
  }

  function stop(): void {
    if (!started) return;
    started = false;
    attemptVersion += 1;
    starting = false;
    queuedSignals = [];
    clearObservationTimer();
    for (const [doc, observer] of documentObservers) {
      doc.removeEventListener('click', handleClick, true);
      observer.disconnect();
    }
    documentObservers.clear();
    for (const cleanup of navigationCleanups.values()) cleanup();
    navigationCleanups.clear();
    lastUrls.clear();
  }

  function refreshDocuments(): void {
    for (const doc of collectAccessibleDocuments(options.rootDocument)) {
      if (!documentObservers.has(doc)) attachDocument(doc);
      const frameWindow = doc.defaultView ?? (doc === options.rootDocument ? options.rootWindow : null);
      if (frameWindow && !navigationCleanups.has(frameWindow)) attachNavigation(frameWindow);
    }
  }

  function attachDocument(doc: Document): void {
    doc.addEventListener('click', handleClick, true);
    const observer = observerFactory(handleMutations);
    observer.observe(doc.documentElement ?? doc, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-hidden', 'style'],
    });
    documentObservers.set(doc, observer);
  }

  function attachNavigation(frameWindow: Window): void {
    const handleNavigation = () => processNavigation(frameWindow);
    const history = frameWindow.history;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const wrappedPushState: History['pushState'] = (...args) => {
      originalPushState.apply(history, args);
      handleNavigation();
    };
    const wrappedReplaceState: History['replaceState'] = (...args) => {
      originalReplaceState.apply(history, args);
      handleNavigation();
    };

    history.pushState = wrappedPushState;
    history.replaceState = wrappedReplaceState;
    frameWindow.addEventListener('popstate', handleNavigation);
    frameWindow.addEventListener('hashchange', handleNavigation);
    lastUrls.set(frameWindow, frameWindow.location.href);

    navigationCleanups.set(frameWindow, () => {
      if (history.pushState === wrappedPushState) history.pushState = originalPushState;
      if (history.replaceState === wrappedReplaceState) history.replaceState = originalReplaceState;
      frameWindow.removeEventListener('popstate', handleNavigation);
      frameWindow.removeEventListener('hashchange', handleNavigation);
    });
  }

  function handleClick(event: Event): void {
    const eventDocument = (event.currentTarget as Document | null) ?? options.rootDocument;
    const control = findSubmissionControl(event.target, eventDocument);
    if (!control) return;

    const clickedDocument = control.ownerDocument ?? eventDocument;
    const clickedWindow = clickedDocument.defaultView ?? options.rootWindow;
    const sourceUrl = clickedWindow.location.href;
    const startedAt = now().toISOString();
    const documents = [...documentObservers.keys()];
    const baseline = {
      successFingerprints: collectBaselineSuccessFingerprints(documents),
      sourceUrl,
      pageTitle: clickedDocument.title,
    };
    const attempt: SubmissionAttemptSnapshot = {
      sourceUrl,
      startedAt,
      applicationEmail: findApplicationEmail(clickedDocument),
      triggerLabel: getSubmissionControlLabel(control),
    };
    const capturedMetadata = options.captureMetadata?.(clickedDocument, sourceUrl);
    const buttonSignal = createButtonClickSignal(control, startedAt);

    session = null;
    activeForm = control.closest?.('form') ?? null;
    queuedSignals = [buttonSignal];
    starting = true;
    clearObservationTimer();
    const version = ++attemptVersion;

    Promise.resolve(capturedMetadata).then(metadata => (
      options.resolveContext(metadata ? { ...attempt, metadata } : attempt)
    )).then((context) => {
      if (!started || version !== attemptVersion) return;
      starting = false;
      session = beginSubmissionSession(context, baseline, observationWindowMs);
      const capturedSignals = queuedSignals;
      queuedSignals = [];
      applySignals(capturedSignals);
      scheduleObservationExpiry();
    }).catch(reportError);
  }

  function handleMutations(mutations: MutationRecord[]): void {
    refreshDocuments();
    const observedAt = now().toISOString();
    const signals = scanMutationsForSubmissionSignals(mutations, observedAt);
    if (isSubmissionFormUnavailable(activeForm)) {
      signals.push(createPageStructureSignal(observedAt));
    }
    acceptSignals(signals);
  }

  function processNavigation(frameWindow: Window): void {
    const previousUrl = lastUrls.get(frameWindow) ?? frameWindow.location.href;
    const nextUrl = frameWindow.location.href;
    lastUrls.set(frameWindow, nextUrl);
    options.onNavigation?.(frameWindow.document, nextUrl);
    const observedAt = now().toISOString();
    acceptSignals(detectNavigationSignals(
      previousUrl,
      nextUrl,
      frameWindow.document.title,
      observedAt,
    ));
  }

  function acceptSignals(signals: SubmissionSignal[]): void {
    if (signals.length === 0) return;
    if (starting) {
      queuedSignals.push(...signals);
      return;
    }
    applySignals(signals);
  }

  function applySignals(signals: SubmissionSignal[]): void {
    if (!session || signals.length === 0) return;
    const previousPending = session.pending;
    session = transitionSubmissionSession(session, {
      type: 'observe',
      signals,
      observedAt: now().toISOString(),
      pendingId: previousPending?.id ?? createId(),
      pendingTtlMs,
    });
    notifyState(previousPending);
  }

  function scheduleObservationExpiry(): void {
    if (!session) return;
    const delay = Math.max(
      0,
      new Date(session.observationExpiresAt).getTime() - now().getTime(),
    );
    observationTimer = scheduleTimeout(expireCurrentSession, delay);
  }

  function expireCurrentSession(): void {
    observationTimer = null;
    if (!session) return;
    const previousPending = session.pending;
    session = transitionSubmissionSession(session, {
      type: 'expire',
      observedAt: session.observationExpiresAt,
    });
    notifyState(previousPending);
  }

  function confirm(metadata?: Partial<SubmissionContext['metadata']>): PendingSubmission | undefined {
    if (session && metadata) {
      session = {
        ...session,
        context: {
          ...session.context,
          metadata: { ...session.context.metadata, ...metadata },
        },
      };
    }
    return applyDecision('confirm');
  }

  function ignore(): PendingSubmission | undefined {
    return applyDecision('ignore');
  }

  function applyDecision(type: 'confirm' | 'ignore'): PendingSubmission | undefined {
    if (!session) return undefined;
    const previousPending = session.pending;
    session = transitionSubmissionSession(session, { type });
    notifyState(previousPending);
    if (session.status === 'confirmed' || session.status === 'ignored') {
      clearObservationTimer();
    }
    return session.pending;
  }

  function notifyState(previousPending: PendingSubmission | undefined): void {
    if (!session) return;
    options.onStateChange?.(session);
    if (hasPendingChanged(previousPending, session.pending) && session.pending) {
      Promise.resolve(options.onPendingSubmission(session.pending, session.context)).catch(reportError);
    }
  }

  function clearObservationTimer(): void {
    if (observationTimer === null) return;
    cancelTimeout(observationTimer);
    observationTimer = null;
  }

  function reportError(error: unknown): void {
    starting = false;
    queuedSignals = [];
    activeForm = null;
    options.onError?.(error);
  }

  return {
    start,
    stop,
    confirm,
    ignore,
    getSession: () => session,
  };
}

function hasPendingChanged(
  previous: PendingSubmission | undefined,
  current: PendingSubmission | undefined,
): boolean {
  if (!previous || !current) return previous !== current;
  return previous.state !== current.state
    || previous.score !== current.score
    || previous.signals.join('|') !== current.signals.join('|');
}

function createRandomId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
