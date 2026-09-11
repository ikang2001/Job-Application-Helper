import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectAccessibleDocuments,
  detectNavigationSignals,
  detectSubmissionTextSignals,
  findApplicationEmail,
  findSubmissionControl,
  isFinalSubmissionControl,
} from './signals.ts';

interface FakeElementOptions {
  tagName?: string;
  text?: string;
  attributes?: Record<string, string>;
  ownerDocument?: Document;
  value?: string;
  parent?: Element | null;
}

function fakeElement(options: FakeElementOptions = {}): Element {
  const attributes = options.attributes ?? {};
  const element = {
    tagName: (options.tagName ?? 'button').toUpperCase(),
    textContent: options.text ?? '',
    ownerDocument: options.ownerDocument,
    parentElement: options.parent ?? null,
    previousElementSibling: null,
    value: options.value ?? '',
    disabled: false,
    hidden: false,
    getAttribute: (name: string) => attributes[name] ?? null,
    closest(selector: string) {
      if (/button|input|role/.test(selector)) return element;
      return null;
    },
    querySelectorAll: () => [],
  };
  return element as unknown as Element;
}

test('recognizes final submit controls but excludes ordinary Apply and navigation buttons', () => {
  const doc = {} as Document;
  const finalButton = fakeElement({ text: 'Submit application', ownerDocument: doc });
  const applyButton = fakeElement({ text: 'Apply now', ownerDocument: doc });
  const nextButton = fakeElement({ text: 'Next', ownerDocument: doc });
  const conciseSubmit = fakeElement({
    text: 'Submit',
    attributes: { type: 'submit' },
    ownerDocument: doc,
  });

  assert.equal(isFinalSubmissionControl(finalButton, doc), true);
  assert.equal(isFinalSubmissionControl(conciseSubmit, doc), true);
  assert.equal(isFinalSubmissionControl(applyButton, doc), false);
  assert.equal(isFinalSubmissionControl(nextButton, doc), false);
  assert.equal(findSubmissionControl(finalButton as unknown as EventTarget, doc), finalButton);
});

test('does not treat a button owned by a different frame document as a local click', () => {
  const topDocument = {} as Document;
  const frameDocument = {} as Document;
  const frameButton = fakeElement({ text: '确认投递', ownerDocument: frameDocument });

  assert.equal(isFinalSubmissionControl(frameButton, topDocument), false);
  assert.equal(isFinalSubmissionControl(frameButton, frameDocument), true);
});

test('detects multilingual success and negative text signals', () => {
  const success = detectSubmissionTextSignals(
    'Thank you. Your application has been submitted.',
    '2026-09-03T10:00:00.000Z',
    'alert-1',
  );
  const negative = detectSubmissionTextSignals(
    '请修正以下字段后重试，并完成验证码。',
    '2026-09-03T10:00:00.000Z',
    'alert-2',
  );

  assert.deepEqual(success.map(item => item.type), ['successText']);
  assert.deepEqual(negative.map(item => item.type), ['negativeSignal']);
});

test('detects SPA success routes and success page titles only after a route change', () => {
  const changed = detectNavigationSignals(
    'https://jobs.example.com/apply',
    'https://jobs.example.com/application/success',
    'Application submitted',
    '2026-09-03T10:00:00.000Z',
  );
  assert.deepEqual(changed.map(item => item.type), ['successRoute', 'successText']);

  const unchanged = detectNavigationSignals(
    'https://jobs.example.com/application/success',
    'https://jobs.example.com/application/success',
    'Apply',
    '2026-09-03T10:00:00.000Z',
  );
  assert.deepEqual(unchanged, []);
});

test('captures the filled application email and traverses accessible iframes only', () => {
  const emailInput = fakeElement({
    tagName: 'input',
    value: 'candidate@example.com',
  }) as HTMLInputElement;
  const frameDocument = {
    title: 'Frame',
    querySelectorAll: (selector: string) => selector === 'iframe' ? [] : [],
  } as unknown as Document;
  const sameOriginFrame = { contentDocument: frameDocument } as HTMLIFrameElement;
  const crossOriginFrame = {} as HTMLIFrameElement;
  Object.defineProperty(crossOriginFrame, 'contentDocument', {
    get() {
      throw new Error('cross origin');
    },
  });
  const rootDocument = {
    title: 'Root',
    querySelectorAll: (selector: string) => {
      if (selector === 'iframe') return [sameOriginFrame, crossOriginFrame];
      if (selector.startsWith('input[type="email"]')) return [emailInput];
      return [];
    },
  } as unknown as Document;

  assert.equal(findApplicationEmail(rootDocument), 'candidate@example.com');
  assert.deepEqual(collectAccessibleDocuments(rootDocument), [rootDocument, frameDocument]);
});
