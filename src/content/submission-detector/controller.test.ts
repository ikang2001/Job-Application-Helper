import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubmissionDetectorController } from './controller.ts';
import { createSubmissionContext } from './model.ts';
import type { PendingSubmission, SubmissionAttemptSnapshot } from './types.ts';

type Listener = (event: Event) => void;

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly attributes: Record<string, string>;
  textContent: string;
  parentElement: FakeElement | null = null;
  previousElementSibling: FakeElement | null = null;
  isConnected = true;
  hidden = false;
  disabled = false;

  constructor(
    ownerDocument: FakeDocument,
    tagName: string,
    text: string,
    attributes: Record<string, string> = {},
  ) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.textContent = text;
    this.attributes = attributes;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  closest(selector: string): FakeElement | null {
    if (/button|input|role/.test(selector) && ['BUTTON', 'INPUT'].includes(this.tagName)) return this;
    if (selector === 'form') return this.parentElement?.tagName === 'FORM' ? this.parentElement : null;
    return null;
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }
}

class FakeDocument {
  title = 'Application form';
  defaultView: FakeWindow | null = null;
  readonly documentElement: FakeElement;
  readonly clickListeners = new Set<Listener>();
  readonly iframes: Array<{ contentDocument: FakeDocument | null }> = [];
  readonly signalElements: FakeElement[] = [];
  readonly emailInputs: Array<FakeElement & { value?: string }> = [];

  constructor() {
    this.documentElement = new FakeElement(this, 'html', '');
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'click' && typeof listener === 'function') {
      this.clickListeners.add(listener as Listener);
    }
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'click' && typeof listener === 'function') {
      this.clickListeners.delete(listener as Listener);
    }
  }

  querySelectorAll(selector: string): unknown[] {
    if (selector === 'iframe') return this.iframes;
    if (selector.startsWith('input[type="email"]')) return this.emailInputs;
    return this.signalElements;
  }

  click(target: FakeElement): void {
    for (const listener of this.clickListeners) {
      listener({ target, currentTarget: this } as unknown as Event);
    }
  }
}

class FakeWindow {
  readonly location: { href: string };
  readonly history: {
    pushState: History['pushState'];
    replaceState: History['replaceState'];
  };
  readonly listeners = new Map<string, Set<() => void>>();

  constructor(readonly document: FakeDocument, initialUrl: string) {
    this.location = { href: initialUrl };
    this.history = {
      pushState: (_data, _unused, url) => this.navigate(url),
      replaceState: (_data, _unused, url) => this.navigate(url),
    };
    document.defaultView = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== 'function') return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as () => void);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === 'function') this.listeners.get(type)?.delete(listener as () => void);
  }

  private navigate(url: string | URL | null | undefined): void {
    if (url === undefined || url === null) return;
    this.location.href = new URL(String(url), this.location.href).toString();
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(options: {
  root?: FakeDocument;
  now?: string;
  captureMetadata?: (document: Document, url: string) => SubmissionAttemptSnapshot['metadata'];
} = {}) {
  const root = options.root ?? new FakeDocument();
  const rootWindow = root.defaultView ?? new FakeWindow(root, 'https://jobs.example.com/apply');
  const observerCallbacks: MutationCallback[] = [];
  const pendingUpdates: PendingSubmission[] = [];
  const attempts: SubmissionAttemptSnapshot[] = [];
  let timerCallback: (() => void) | undefined;
  let currentTime = options.now ?? '2026-09-03T10:00:00.000Z';
  let id = 0;

  const controller = createSubmissionDetectorController({
    rootDocument: root as unknown as Document,
    rootWindow: rootWindow as unknown as Window,
    now: () => new Date(currentTime),
    createId: () => `pending-${++id}`,
    observerFactory: (callback) => {
      observerCallbacks.push(callback);
      return { observe() {}, disconnect() {} };
    },
    scheduleTimeout: (callback) => {
      timerCallback = callback;
      return 1 as ReturnType<typeof setTimeout>;
    },
    cancelTimeout: () => {
      timerCallback = undefined;
    },
    captureMetadata: options.captureMetadata,
    resolveContext: (attempt) => {
      attempts.push(attempt);
      return createSubmissionContext({
        id: `context-${attempts.length}`,
        tabId: 12,
        sourceUrl: attempt.sourceUrl,
        applicationEmail: attempt.applicationEmail,
        metadata: { companyName: 'Acme', jobTitle: 'Engineer' },
      }, attempt.startedAt);
    },
    onPendingSubmission: (pending) => {
      pendingUpdates.push({ ...pending, signals: [...pending.signals] });
    },
  });

  return {
    root,
    rootWindow,
    observerCallbacks,
    pendingUpdates,
    attempts,
    controller,
    setTime: (value: string) => {
      currentTime = value;
    },
    fireTimer: () => timerCallback?.(),
  };
}

function emitAddedNode(callback: MutationCallback, element: FakeElement): void {
  callback([{
    type: 'childList',
    addedNodes: [element],
    target: element.ownerDocument.documentElement,
  } as unknown as MutationRecord], {} as MutationObserver);
}

test('DOM controller ignores ordinary Apply, then creates only a pending candidate after final submit success', async () => {
  const harness = createHarness();
  harness.controller.start();
  const apply = new FakeElement(harness.root, 'button', 'Apply now');
  harness.root.click(apply);
  await flushPromises();
  assert.equal(harness.controller.getSession(), null);

  const form = new FakeElement(harness.root, 'form', '');
  const submit = new FakeElement(harness.root, 'button', 'Submit application');
  submit.parentElement = form;
  harness.root.click(submit);
  await flushPromises();

  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.controller.getSession()?.score, 0.2);
  assert.equal(harness.pendingUpdates.length, 0);

  const success = new FakeElement(
    harness.root,
    'div',
    'Your application has been submitted.',
    { id: 'success-message' },
  );
  emitAddedNode(harness.observerCallbacks[0], success);

  assert.equal(harness.pendingUpdates.length, 1);
  assert.equal(harness.pendingUpdates[0].state, 'pending');
  assert.equal(harness.pendingUpdates[0].score, 0.75);
  assert.deepEqual(harness.pendingUpdates[0].signals, ['buttonClick', 'successText']);
  harness.controller.stop();
});

test('controller freezes page metadata before the website replaces the submission DOM', async () => {
  const harness = createHarness({
    captureMetadata: (document, url) => ({
      companyName: '小黑盒',
      jobTitle: document.title,
      sourceUrl: url.replace('/apply', '/jobs/agent-engineer'),
    }),
  });
  harness.root.title = 'Agent开发工程师';
  harness.controller.start();

  harness.root.click(new FakeElement(harness.root, 'button', '提交申请'));
  harness.root.title = '投递岗位';
  await flushPromises();

  assert.equal(harness.attempts[0]?.metadata?.jobTitle, 'Agent开发工程师');
  assert.equal(
    harness.attempts[0]?.metadata?.sourceUrl,
    'https://jobs.example.com/jobs/agent-engineer',
  );
  harness.controller.stop();
});

test('initial success text is excluded, a negative signal suppresses candidate, and timeout closes observation', async () => {
  const harness = createHarness();
  const existingSuccess = new FakeElement(
    harness.root,
    'div',
    'Application submitted',
    { id: 'existing-success' },
  );
  harness.root.signalElements.push(existingSuccess);
  harness.controller.start();
  harness.root.click(new FakeElement(harness.root, 'button', '确认投递'));
  await flushPromises();

  emitAddedNode(harness.observerCallbacks[0], existingSuccess);
  assert.equal(harness.controller.getSession()?.score, 0.2);

  emitAddedNode(harness.observerCallbacks[0], new FakeElement(
    harness.root,
    'div',
    'Application received, but please correct the required fields.',
    { id: 'mixed-result' },
  ));
  assert.equal(harness.controller.getSession()?.score, 0.15);
  assert.equal(harness.pendingUpdates.length, 0);

  harness.setTime('2026-09-03T10:02:00.000Z');
  harness.fireTimer();
  assert.equal(harness.controller.getSession()?.status, 'expired');
  harness.controller.stop();
});

test('SPA history route strengthens a candidate and confirm/ignore remain explicit decisions', async () => {
  const harness = createHarness();
  harness.controller.start();
  harness.root.click(new FakeElement(harness.root, 'button', 'Submit application'));
  await flushPromises();

  const success = new FakeElement(
    harness.root,
    'div',
    'Application submitted',
    { id: 'result' },
  );
  emitAddedNode(harness.observerCallbacks[0], success);
  harness.rootWindow.history.pushState({}, '', '/application/success');

  assert.equal(harness.controller.getSession()?.score, 1);
  assert.equal(harness.pendingUpdates.at(-1)?.score, 1);
  assert.equal(harness.controller.confirm()?.state, 'confirmed');
  assert.equal(harness.pendingUpdates.at(-1)?.state, 'confirmed');
  assert.equal(harness.controller.ignore()?.state, 'confirmed');
  harness.controller.stop();
});

test('controller observes final submission clicks inside accessible same-origin iframes', async () => {
  const root = new FakeDocument();
  new FakeWindow(root, 'https://jobs.example.com/apply');
  const frame = new FakeDocument();
  new FakeWindow(frame, 'https://apply.vendor.example/form');
  root.iframes.push({ contentDocument: frame });
  const harness = createHarness({ root });
  harness.controller.start();

  frame.click(new FakeElement(frame, 'button', '提交申请'));
  await flushPromises();

  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].sourceUrl, 'https://apply.vendor.example/form');
  assert.equal(harness.controller.getSession()?.score, 0.2);
  harness.controller.stop();
});
