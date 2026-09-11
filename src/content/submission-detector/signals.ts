import type { SubmissionSignal } from './types.ts';

const SUCCESS_PHRASES: ReadonlyArray<[string, RegExp]> = [
  ['投递成功', /投递成功/i],
  ['申请成功', /申请成功/i],
  ['简历已投递', /简历(?:已经|已)?(?:成功)?投递(?!失败)/i],
  ['application submitted', /application\s+(?:has\s+been\s+)?submitted/i],
  ['application received', /application\s+(?:has\s+been\s+)?received/i],
  ['thank you for applying', /thank\s+you\s+for\s+(?:applying|your\s+application)/i],
  ['successfully applied', /successfully\s+applied/i],
];

const NEGATIVE_PHRASES: ReadonlyArray<[string, RegExp]> = [
  ['提交失败', /(?:投递|申请|提交)(?:未成功|失败)|(?:application|submission)\s+(?:failed|was\s+not\s+submitted)|could\s+not\s+submit/i],
  ['表单校验失败', /请(?:修正|检查|完善|填写).{0,20}(?:字段|信息|内容)|必填项|格式(?:不正确|错误)/i],
  ['validation failed', /please\s+(?:correct|fix|complete).{0,30}(?:fields?|errors?)|validation\s+(?:error|failed)|required\s+field/i],
  ['网络失败', /网络(?:请求)?(?:错误|异常|失败)|连接失败|请稍后重试/i],
  ['network failed', /network\s+(?:error|failure)|request\s+failed|try\s+again\s+later/i],
  ['验证码', /验证码|人机验证|安全验证|captcha|verify\s+you(?:'re|\s+are)\s+human/i],
  ['登录失效', /登录(?:失效|已过期)|会话(?:失效|已过期)|请重新登录/i],
  ['session expired', /session\s+(?:has\s+)?expired|sign\s+in\s+again|log\s+in\s+again/i],
];

const FINAL_SUBMIT_PATTERN = /(?:提交(?:申请|应聘|简历)|确认(?:并)?(?:提交|投递)|投递简历|立即投递|完成投递|正式提交|submit\s+(?:my\s+|your\s+)?application|complete\s+(?:and\s+)?submit|complete\s+application|send\s+(?:my\s+|your\s+)?application|finish\s+(?:and\s+)?submit|confirm\s+(?:and\s+)?submit)/i;
const GENERIC_APPLY_PATTERN = /^(?:apply|apply now|start application|立即申请|马上申请|申请职位|去申请|开始申请)$/i;
const NON_SUBMIT_PATTERN = /^(?:next|continue|save|save draft|preview|review|login|sign in|verify|下一步|继续|保存|存草稿|预览|检查|登录|验证)$/i;
const SIGNAL_CONTAINER_SELECTOR = [
  '[role="alert"]',
  '[role="status"]',
  '[aria-live]',
  '[class*="success" i]',
  '[class*="submitted" i]',
  '[class*="confirmation" i]',
  '[class*="error" i]',
  '[class*="invalid" i]',
  'h1',
  'h2',
  'h3',
].join(', ');

export function findSubmissionControl(
  target: EventTarget | null,
  expectedDocument?: Document,
): Element | null {
  const element = toElement(target);
  if (!element) return null;

  const control = element.closest?.(
    'button, input[type="submit"], input[type="button"], [role="button"]',
  ) ?? (isButtonLike(element) ? element : null);
  if (!control || !isFinalSubmissionControl(control, expectedDocument)) return null;
  return control;
}

export function isFinalSubmissionControl(
  element: Element,
  expectedDocument?: Document,
): boolean {
  if (expectedDocument && element.ownerDocument !== expectedDocument) return false;
  if (!isButtonLike(element) || isDisabled(element)) return false;

  const label = getSubmissionControlLabel(element);
  if (!label || NON_SUBMIT_PATTERN.test(label) || GENERIC_APPLY_PATTERN.test(label)) return false;

  const identifiers = [
    label,
    element.getAttribute('name') ?? '',
    element.getAttribute('id') ?? '',
    element.getAttribute('data-action') ?? '',
    element.getAttribute('data-testid') ?? '',
  ].join(' ');
  if (FINAL_SUBMIT_PATTERN.test(identifiers)) return true;

  const type = (element.getAttribute('type') ?? '').toLowerCase();
  const isSubmitType = type === 'submit' || element.tagName.toLowerCase() === 'input' && type === 'submit';
  return isSubmitType && /^(?:submit|提交)$/i.test(label);
}

export function getSubmissionControlLabel(element: Element): string {
  return normalizeText(
    element.getAttribute('aria-label')
      || element.getAttribute('value')
      || element.textContent
      || '',
  );
}

export function detectSubmissionTextSignals(
  text: string,
  observedAt: string,
  fingerprintBase: string,
): SubmissionSignal[] {
  const normalized = normalizeText(text).slice(0, 4_000);
  if (!normalized) return [];

  const signals: SubmissionSignal[] = [];
  const success = SUCCESS_PHRASES.find(([, pattern]) => pattern.test(normalized));
  if (success) {
    signals.push({
      type: 'successText',
      observedAt,
      fingerprint: `successText:${fingerprintBase}:${success[0]}`,
      detail: success[0],
    });
  }

  const negative = NEGATIVE_PHRASES.find(([, pattern]) => pattern.test(normalized));
  if (negative) {
    signals.push({
      type: 'negativeSignal',
      observedAt,
      fingerprint: `negativeSignal:${fingerprintBase}:${negative[0]}`,
      detail: negative[0],
    });
  }
  return signals;
}

export function detectNavigationSignals(
  previousUrl: string,
  nextUrl: string,
  pageTitle: string,
  observedAt: string,
): SubmissionSignal[] {
  const signals: SubmissionSignal[] = [];
  if (previousUrl !== nextUrl && isSuccessRoute(nextUrl)) {
    signals.push({
      type: 'successRoute',
      observedAt,
      fingerprint: `successRoute:${normalizeUrlForFingerprint(nextUrl)}`,
      detail: nextUrl,
    });
  }
  signals.push(...detectSubmissionTextSignals(pageTitle, observedAt, 'document-title'));
  return signals;
}

export function createButtonClickSignal(
  element: Element,
  observedAt: string,
): SubmissionSignal {
  return {
    type: 'buttonClick',
    observedAt,
    fingerprint: `buttonClick:${elementFingerprint(element)}`,
    detail: getSubmissionControlLabel(element),
  };
}

export function createPageStructureSignal(observedAt: string): SubmissionSignal {
  return {
    type: 'pageStructure',
    observedAt,
    fingerprint: 'pageStructure:submission-form-removed',
    detail: 'submission form removed or hidden after submit',
  };
}

export function isSubmissionFormUnavailable(form: Element | null): boolean {
  if (!form) return false;
  const connected = (form as Element & { isConnected?: boolean }).isConnected;
  const hidden = (form as HTMLElement).hidden;
  const style = form.getAttribute('style') ?? '';
  return connected === false
    || hidden === true
    || form.getAttribute('aria-hidden') === 'true'
    || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

export function findApplicationEmail(doc: Document): string | undefined {
  const candidates = typeof doc.querySelectorAll === 'function'
    ? Array.from(doc.querySelectorAll<HTMLInputElement>(
      'input[type="email"], input[autocomplete="email"], input[name*="mail" i], input[id*="mail" i]',
    ))
    : [];

  return candidates
    .map(input => input.value?.trim())
    .find(value => Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)));
}

export function scanNodeForSubmissionSignals(node: Node, observedAt: string): SubmissionSignal[] {
  const root = node.nodeType === 3 ? node.parentElement : node;
  if (!root) return [];

  const candidates: Element[] = [];
  if (isElement(root)) candidates.push(root);
  if ('querySelectorAll' in root && typeof root.querySelectorAll === 'function') {
    candidates.push(...Array.from(root.querySelectorAll(SIGNAL_CONTAINER_SELECTOR)) as Element[]);
  }

  return uniqueSignals(candidates.flatMap(element => detectSubmissionTextSignals(
    element.textContent ?? '',
    observedAt,
    elementFingerprint(element),
  )));
}

export function scanMutationsForSubmissionSignals(
  mutations: readonly MutationRecord[],
  observedAt: string,
): SubmissionSignal[] {
  const nodes: Node[] = [];
  for (const mutation of mutations) {
    if (mutation.type === 'childList') {
      nodes.push(...Array.from(mutation.addedNodes));
    } else {
      nodes.push(mutation.target);
    }
  }
  return uniqueSignals(nodes.flatMap(node => scanNodeForSubmissionSignals(node, observedAt)));
}

export function collectBaselineSuccessFingerprints(documents: readonly Document[]): string[] {
  const fingerprints = new Set<string>();
  for (const doc of documents) {
    if (typeof doc.querySelectorAll === 'function') {
      for (const element of Array.from(doc.querySelectorAll(SIGNAL_CONTAINER_SELECTOR))) {
        for (const signal of detectSubmissionTextSignals(
          element.textContent ?? '',
          '',
          elementFingerprint(element),
        )) {
          if (signal.type === 'successText') fingerprints.add(signal.fingerprint);
        }
      }
    }
    for (const signal of detectSubmissionTextSignals(doc.title, '', 'document-title')) {
      if (signal.type === 'successText') fingerprints.add(signal.fingerprint);
    }
  }
  return [...fingerprints];
}

export function collectAccessibleDocuments(rootDocument: Document): Document[] {
  const result: Document[] = [];
  const visited = new Set<Document>();

  function visit(doc: Document): void {
    if (visited.has(doc)) return;
    visited.add(doc);
    result.push(doc);
    if (typeof doc.querySelectorAll !== 'function') return;

    for (const iframe of Array.from(doc.querySelectorAll<HTMLIFrameElement>('iframe'))) {
      try {
        if (iframe.contentDocument) visit(iframe.contentDocument);
      } catch {
        // Cross-origin frames are intentionally ignored; their events cannot be inspected safely.
      }
    }
  }

  visit(rootDocument);
  return result;
}

function isSuccessRoute(url: string): boolean {
  try {
    const parsed = new URL(url);
    const route = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return /(?:^|[/#?&=_-])(?:application[-_]?submitted|submitted|success|confirmation|thank[-_]?you)(?:$|[/#?&=_-])/i
      .test(route);
  } catch {
    return false;
  }
}

function normalizeUrlForFingerprint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function elementFingerprint(element: Element): string {
  const id = element.getAttribute('id');
  if (id) return `${element.tagName.toLowerCase()}#${id}`;

  const path: string[] = [];
  let current: Element | null = element;
  while (current && path.length < 6) {
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    path.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
    current = current.parentElement;
  }
  return path.join('>') || element.tagName.toLowerCase();
}

function uniqueSignals(signals: SubmissionSignal[]): SubmissionSignal[] {
  const seen = new Set<string>();
  return signals.filter(signal => {
    const key = `${signal.type}:${signal.fingerprint}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== 'object') return null;
  if (isElement(target)) return target;
  return 'parentElement' in target ? (target.parentElement as Element | null) : null;
}

function isElement(value: object): value is Element {
  return 'tagName' in value && 'getAttribute' in value;
}

function isButtonLike(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  return tagName === 'button'
    || tagName === 'input'
    || element.getAttribute('role') === 'button';
}

function isDisabled(element: Element): boolean {
  return (element as HTMLButtonElement).disabled === true
    || element.getAttribute('disabled') !== null
    || element.getAttribute('aria-disabled') === 'true';
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
