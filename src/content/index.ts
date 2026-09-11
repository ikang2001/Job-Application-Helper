import { FormDetector } from './formDetector';
import { FormFiller, type FillDiagnostics, type FillSection } from './formFiller';
import { OpenQuestionDetector } from './openQuestionDetector';
import { type PageScanField, type PageScanSection } from './pageScan';
import {
  AUTHORITATIVE_FIELD_CONFIDENCE,
  FieldMatcher,
} from '../utils/fieldMatcher.ts';
import { FieldType } from '../shared/types.ts';
import {
  FORM_CONTROL_SELECTOR,
  getControlKind,
  getFieldContainer,
  isWritableFormControl,
  isVisibleFormControl,
  isPrimaryCustomSelectControl,
  type WritableFormControl,
} from './formControl.ts';
import { extractApplicationPageMetadata } from './applicationRecordMetadata.ts';
import { createSubmissionDetectorController } from './submission-detector/controller.ts';
import { removeSubmissionReviewCard, updateSubmissionReviewCard } from './submission-detector/reviewCard.ts';
import type {
  SubmissionContext,
  SubmissionAttemptSnapshot,
} from './submission-detector/types.ts';
import { createVisualRegionFillController } from './visualRegionFill.ts';
import { buildAuthoritativeFillProfile } from '../utils/fillProfile.ts';
import { createPageFillTaskRunner } from './pageFillTask';
import type {
  DetectedField,
  FocusedFieldWriteResult,
  Message,
  MessageResponse,
  UserProfile,
} from '../shared/types';

async function sendRuntimeMessage<T = any>(message: Message): Promise<MessageResponse<T>> {
  try {
    return await chrome.runtime.sendMessage(message) as MessageResponse<T>;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

console.log(`Content script loaded (v${chrome.runtime.getManifest().version})`);

let applicationMetadataCacheTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleApplicationMetadataCache(
  targetDocument: Document,
  url: string,
  delayMs: number = 400,
): void {
  if (applicationMetadataCacheTimer !== null) clearTimeout(applicationMetadataCacheTimer);
  applicationMetadataCacheTimer = setTimeout(() => {
    applicationMetadataCacheTimer = null;
    void extractApplicationPageMetadata(targetDocument, url).then(metadata => (
      sendRuntimeMessage({ type: 'CACHE_APPLICATION_PAGE_METADATA', payload: metadata })
    ));
  }, delayMs);
}

// 初始化
const formDetector = new FormDetector();
const formFiller = new FormFiller();
const startPageFillTask = createPageFillTaskRunner();
const submissionDetectorController = createSubmissionDetectorController({
  rootDocument: document,
  rootWindow: window,
  captureMetadata: (targetDocument, url) => extractApplicationPageMetadata(targetDocument, url),
  onNavigation: (targetDocument, url) => {
    scheduleApplicationMetadataCache(targetDocument, url);
  },
  resolveContext: async (attempt: SubmissionAttemptSnapshot): Promise<SubmissionContext> => {
    const response = await sendRuntimeMessage<SubmissionContext>({
      type: 'SUBMISSION_ATTEMPT_STARTED',
      payload: attempt,
    });
    if (!response.success || !response.data) {
      throw new Error(response.error || '无法创建投递提交上下文');
    }
    return response.data;
  },
  onPendingSubmission: async (pending, context) => {
    const response = await sendRuntimeMessage({
      type: 'UPSERT_PENDING_SUBMISSION',
      payload: { pending, context },
    });
    if (!response.success) {
      throw new Error(response.error || '无法保存投递候选');
    }
  },
  onStateChange: session => updateSubmissionReviewCard(document, session, {
    onConfirm: metadata => { submissionDetectorController.confirm(metadata); },
    onIgnore: () => { submissionDetectorController.ignore(); },
  }),
  onError: error => console.warn('Submission detection failed:', error),
});
const visualRegionFillController = createVisualRegionFillController({
  sendRuntimeMessage,
  fillElementValues: (values, shouldContinue) => formFiller.fillElementValues(
    values as Parameters<FormFiller['fillElementValues']>[0],
    shouldContinue,
  ),
});
let detectedFields: DetectedField[] = [];
let lastFocusedControl:
  | WritableFormControl
  | null = null;

submissionDetectorController.start();
scheduleApplicationMetadataCache(document, window.location.href, 0);
window.addEventListener('pagehide', () => {
  if (applicationMetadataCacheTimer !== null) clearTimeout(applicationMetadataCacheTimer);
  submissionDetectorController.stop();
  removeSubmissionReviewCard(document);
}, { once: true });

document.addEventListener('focusin', (event) => {
  const target = event.target;
  if (isWritableControl(target)) {
    lastFocusedControl = target;
  }
}, true);

function isWritableControl(
  target: EventTarget | null
): target is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return target instanceof Element && isWritableFormControl(target);
}

async function applyValueToFocusedControl(value: string): Promise<FocusedFieldWriteResult> {
  if (!lastFocusedControl) {
    return { written: false, reason: 'NO_FOCUSED_FIELD' };
  }
  if (!lastFocusedControl.isConnected) {
    lastFocusedControl = null;
    return { written: false, reason: 'FIELD_DETACHED' };
  }
  if (!isWritableControl(lastFocusedControl)) {
    return { written: false, reason: 'FIELD_NOT_WRITABLE' };
  }

  const written = await formFiller.fillFocusedControl(lastFocusedControl, value);
  return written
    ? { written: true }
    : { written: false, reason: 'VALUE_REJECTED' };
}

// 页面加载完成后检测表单
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeDetection);
} else {
  initializeDetection();
}

function initializeDetection() {
  // 延迟检测，等待动态内容加载
  setTimeout(() => {
    detectedFields = formDetector.detectFields();
    injectAIButtons();
  }, 1000);

  // 开始监听 DOM 变化
  formDetector.startObserving((fields) => {
    detectedFields = fields;
    if (fields.length > 0) {
      console.log(`Re-detected ${fields.length} fields`);
      injectAIButtons();
    }
  });
}

// 处理填充按钮点击
async function handleFillButtonClick() {
  return fillSection('all');
}

async function handleAIPageFill() {
  const status = showAIRegionStatus('正在扫描整页表单...');
  const requestId = crypto.randomUUID();
  let cancelled = false;

  status.setCancelHandler(async () => {
    if (cancelled) return;
    cancelled = true;
    status.update('正在终止 AI 扫描填充...');
    await sendRuntimeMessage({
      type: 'CANCEL_AI_FILL',
      payload: { requestId },
    });
    status.update('AI 扫描填充已终止', 'warning');
  });

  try {
    const response = await sendRuntimeMessage<UserProfile>({
      type: 'GET_USER_PROFILE',
    });
    if (!response.success || !response.data) {
      throw new Error('请先在插件选项页面中设置个人信息');
    }
    const profile = buildAuthoritativeFillProfile(response.data);

    await uploadResumeBeforeFill(profile);
    await formFiller.prepareDynamicSections(profile, 'all');
    detectedFields = formDetector.detectFields();
    const authoritativeFields = detectedFields.filter(
      field => field.confidence >= AUTHORITATIVE_FIELD_CONFIDENCE,
    );
    status.update(`已识别 ${authoritativeFields.length} 个确定字段，正在按插件资料覆盖...`);
    let filledCount = await formFiller.fillForm(
      authoritativeFields,
      profile,
      redetectCurrentFields,
    );
    detectedFields = formDetector.detectFields();
    // 规则已确定的字段已经由上一步按插件资料覆盖。AI 只处理规则无法确定的
    // 控件，避免模型再次改写教育行，也显著减少请求体和等待时间。
    const scannedFields = collectPageScanFields().filter(
      field => field.semanticType === FieldType.UNKNOWN,
    );
    if (scannedFields.length === 0) {
      status.update(
        filledCount > 0
          ? `AI 扫描填充完成：已填 ${filledCount} 项`
          : '未检测到需要 AI 判断的表单字段',
        filledCount > 0 ? 'success' : 'warning',
      );
      return;
    }

    const batches = createPageScanBatches(scannedFields);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      if (cancelled) return;
      const fields = batches[batchIndex];
      const batchProgress = batches.length > 1
        ? `（第 ${batchIndex + 1}/${batches.length} 批）`
        : '';
      status.update(`AI 正在统一分析 ${fields.length} 个待确认字段${batchProgress}...`);
      filledCount += await fillPageScanBatch(
        fields,
        requestId,
        () => !cancelled,
      );
    }

    if (cancelled) return;

    status.update(`AI 扫描填充完成：已填 ${filledCount} 项`, 'success');
  } catch (error) {
    if (cancelled) return;
    console.error('AI page scan fill failed:', error);
    status.update(
      `AI 扫描填充失败：${error instanceof Error ? error.message : '未知错误'}`,
      'error',
    );
  }
}

async function fillSection(section: FillSection) {
  const status = section === 'all'
    ? showQuickFillStatus('正在按插件资料填写；学校等下拉会等待网站选项并确认...')
    : null;
  try {
    // 获取用户资料
    const response = await sendRuntimeMessage<UserProfile>({
      type: 'GET_USER_PROFILE'
    });

    if (!response.success || !response.data) {
      alert('请先在插件选项页面中设置个人信息！');
      return;
    }
    const profile = buildAuthoritativeFillProfile(response.data);
    console.log(
      `Identity profile value: ${profile.personal.idCard?.trim() ? 'configured' : 'missing'}`,
    );

    // 招聘网站可能在接收附件后自动回填且覆盖表单，所以附件必须先上传，
    // 最后再以插件资料写回所有受支持字段。
    if (section === 'all') await uploadResumeBeforeFill(profile);
    await formFiller.prepareDynamicSections(profile, section);
    detectedFields = formDetector.detectFields();

    const fieldsToFill = filterFieldsBySection(detectedFields, section);

    if (fieldsToFill.length === 0) {
      alert('未检测到可填充的表单字段');
      return;
    }

    // 填充表单
    const filledCount = await formFiller.fillForm(
      fieldsToFill,
      profile,
      redetectCurrentFields,
    );
    const diagnostics = formFiller.getLastFillDiagnostics();

    // 显示成功消息
    showSuccessMessage(filledCount, diagnostics);
    status?.complete(buildFillSummaryText(filledCount, diagnostics), diagnostics.rejectedFields.length > 0);
    return { filledCount, ...diagnostics };

  } catch (error) {
    console.error('Fill form error:', error);
    status?.fail('填充过程中发生错误，请查看页面控制台');
    alert('填充表单时出错，请查看控制台了解详情');
    throw error;
  }
}

function redetectCurrentFields(): DetectedField[] {
  detectedFields = formDetector.detectFields();
  return detectedFields;
}

async function uploadResumeBeforeFill(profile: UserProfile): Promise<void> {
  if (!profile.resume) return;
  const fileInputs = formDetector.findFileInputs();
  const inputsToUpload = fileInputs.filter(input => (
    !formDetector.hasMatchingAttachedResume(input, profile.resume!.fileName)
  ));
  if (inputsToUpload.length === 0) return;

  for (const fileInput of inputsToUpload) {
    try {
      await formFiller.uploadResume(
        fileInput,
        profile.resume.fileData,
        profile.resume.fileName,
      );
    } catch (error) {
      console.error('Failed to upload resume to input:', error);
    }
  }

  // 新上传时必须等网站自己的解析回填结束，再以插件资料覆盖。平时页面已经
  // 显示同名简历时会在上面直接跳过上传，因此不会再为每次填充增加等待。
  await waitForResumeParsingToSettle(inputsToUpload[0]);
}

async function waitForResumeParsingToSettle(fileInput: HTMLInputElement): Promise<void> {
  const startedAt = Date.now();
  let lastMutationAt = startedAt;
  let sawBusyIndicator = false;
  const root = findResumeFormRoot(fileInput);
  const observer = new MutationObserver(() => { lastMutationAt = Date.now(); });
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });

  try {
    while (Date.now() - startedAt < 10_000) {
      const elapsed = Date.now() - startedAt;
      const busy = hasVisibleResumeParsingIndicator(root);
      sawBusyIndicator ||= busy;
      const quietFor = Date.now() - lastMutationAt;
      if (!busy && quietFor >= 500 && (sawBusyIndicator ? elapsed >= 800 : elapsed >= 2_500)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    observer.disconnect();
  }
}

function findResumeFormRoot(fileInput: HTMLInputElement): HTMLElement {
  let current = fileInput.parentElement;
  while (current && current !== document.body) {
    if (current.querySelectorAll(FORM_CONTROL_SELECTOR).length >= 5) return current;
    current = current.parentElement;
  }
  return document.body;
}

function hasVisibleResumeParsingIndicator(root: ParentNode): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>([
    '[aria-busy="true"]',
    '[class*=resume][class*=progress]',
    '[class*=resume][class*=loading]',
    '[class*=resume][class*=parsing]',
    '[class*=upload][class*=progress]',
  ].join(', '))).some(element => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && (rect.width > 0 || rect.height > 0);
  });
}

function filterFieldsBySection(fields: DetectedField[], section: FillSection): DetectedField[] {
  if (section === 'all') return fields;

  return fields.filter(field => getElementSection(field.element) === section);
}

function getElementSection(element: Element): FillSection | null {
  let current: Element | null = element;
  while (current && current !== document.body) {
    const className = current.getAttribute('class') || '';
    if (/(?:resume-block|multiple_form)-(?:edu|education)(?:-|\s|$)/i.test(className)) return 'education';
    if (/(?:resume-block|multiple_form)-(?:internship|experience)(?:-|\s|$)/i.test(className)) return 'experience';
    if (/(?:resume-block|multiple_form)-project(?:-|\s|$)/i.test(className)) return 'projects';
    if (/resume[_-]person[_-]info/i.test(className)) return 'personal';
    if (/resume-block-language|language-skill/i.test(className)) return 'languages';

    const text = (current.textContent || '').replace(/\s+/g, ' ');
    if (text.includes('基本信息')) return 'personal';
    if (text.includes('教育经历')) return 'education';
    if (/语言能力|外语能力/.test(text)) return 'languages';
    if (text.includes('实习经历')) return 'experience';
    if (text.includes('项目经历')) return 'projects';
    if (/奖项|荣誉|获奖/.test(text)) return 'awards';
    current = current.parentElement;
  }

  return null;
}

function startAIRegionSelection() {
  visualRegionFillController.beginVisualRegionFill();
}

type ScannedPageField = PageScanField & {
  element: WritableFormControl;
};

function collectPageScanFields(): ScannedPageField[] {
  const elements = Array.from(
    document.querySelectorAll(FORM_CONTROL_SELECTOR),
  ).filter(element => {
    return isWritableFormControl(element)
      && isPrimaryCustomSelectControl(element)
      && isVisibleFormControl(element);
  }) as WritableFormControl[];
  const rowCounters = new Map<string, number>();

  return elements.map((element, index) => {
    const container = getFieldContainer(element);
    const identifiers = FieldMatcher.extractIdentifiers(element);
    const match = FieldMatcher.matchFieldType(
      identifiers.name,
      identifiers.id,
      identifiers.placeholder,
      identifiers.labelText,
      identifiers.type,
      identifiers.autocomplete,
    );
    const semanticType = match.confidence >= AUTHORITATIVE_FIELD_CONFIDENCE
      ? match.fieldType
      : FieldType.UNKNOWN;
    const name = (
      identifiers.name ||
      (semanticType !== FieldType.UNKNOWN ? semanticType : '') ||
      ''
    ).trim();
    const label = (identifiers.labelText || identifiers.placeholder || name).trim();
    const section = toPageScanSection(getElementSection(element));
    const semanticName = semanticType !== FieldType.UNKNOWN
      ? semanticType
      : normalizeRepeatedFieldKey(name || label);
    const key = `${section}|${semanticName}`;
    const occurrence = rowCounters.get(key) || 0;
    rowCounters.set(key, occurrence + 1);
    const rowIndex = FieldMatcher.extractRowIndex(element) ?? occurrence;
    const isStartDate = semanticType === FieldType.EDUCATION_START_DATE
      || semanticType === FieldType.START_DATE
      || semanticType === FieldType.PROJECT_START_DATE;
    const isEndDate = semanticType === FieldType.GRADUATION_DATE
      || semanticType === FieldType.END_DATE
      || semanticType === FieldType.PROJECT_END_DATE;
    const context = `${getPageSectionName(section)}；${(container?.textContent || element.parentElement?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)}`;

    return {
      element,
      index,
      rowIndex,
      section,
      name,
      label,
      semanticType,
      type: isEndDate ? 'date-end' : isStartDate ? 'date-start' : getControlKind(element),
      options: getKnownOptions(element, label, name, semanticType),
      context,
    };
  });
}

function normalizeRepeatedFieldKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\[\d+\]|(?:^|[._-])\d+(?=[._-]|$)/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function toPageScanSection(section: FillSection | null): PageScanSection {
  return section && section !== 'all' ? section : 'other';
}

function getPageSectionName(section: PageScanSection): string {
  return {
    personal: '基本信息',
    education: '教育经历',
    languages: '语言能力',
    experience: '实习经历',
    projects: '项目经历',
    awards: '奖项 / 荣誉',
    other: '其它表单',
  }[section];
}

async function fillPageScanBatch(
  fields: ScannedPageField[],
  requestId: string,
  shouldContinue: () => boolean,
): Promise<number> {
  const response = await sendRuntimeMessage<Record<string, string>>({
    type: 'AI_FILL_SECTION',
    payload: {
      requestId,
      section: 'all',
      domain: window.location.hostname,
      fields: fields.map(field => ({
        index: field.index,
        rowIndex: field.rowIndex,
        section: field.section,
        name: field.name,
        label: field.label,
        semanticType: field.semanticType,
        type: field.type,
        options: field.options,
        context: field.context,
      })),
    },
  });

  if (!response.success || !response.data) {
    throw new Error(response.error || 'AI 未返回扫描结果');
  }

  const values = Object.entries(response.data)
    .map(([index, value]) => {
      const field = fields.find(item => item.index === Number(index));
      return field ? { element: field.element, value } : null;
    })
    .filter((item): item is {
      element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      value: string;
    } => Boolean(item))
    .sort((a, b) => getDateRangeFillPriority(a.element) - getDateRangeFillPriority(b.element));

  return formFiller.fillElementValues(values, shouldContinue);
}

function createPageScanBatches(fields: ScannedPageField[]): ScannedPageField[][] {
  const batchSize = 80;
  const batches: ScannedPageField[][] = [];
  for (let index = 0; index < fields.length; index += batchSize) {
    batches.push(fields.slice(index, index + batchSize));
  }
  return batches;
}

function showAIRegionStatus(initialText: string) {
  const element = document.createElement('div');
  const textElement = document.createElement('span');
  const cancelButton = document.createElement('button');
  element.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:1000005;max-width:440px;padding:12px 14px;border-radius:8px;background:#24262d;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.28);font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;gap:12px;';
  textElement.textContent = initialText;
  cancelButton.type = 'button';
  cancelButton.textContent = '终止';
  cancelButton.style.cssText = 'flex:none;padding:5px 10px;border:1px solid rgba(255,255,255,.65);border-radius:5px;background:transparent;color:#fff;cursor:pointer;font:500 12px inherit;';
  element.append(textElement, cancelButton);
  document.body.appendChild(element);

  return {
    setCancelHandler(handler: () => void | Promise<void>) {
      cancelButton.onclick = () => {
        cancelButton.disabled = true;
        cancelButton.textContent = '终止中';
        void handler();
      };
    },
    update(text: string, type: 'normal' | 'success' | 'warning' | 'error' = 'normal') {
      textElement.textContent = text;
      element.style.background = type === 'success'
        ? '#15803d'
        : type === 'warning'
          ? '#a16207'
          : type === 'error'
            ? '#b91c1c'
            : '#24262d';
      if (type !== 'normal') {
        cancelButton.remove();
        setTimeout(() => element.remove(), 5000);
      }
    },
  };
}

function getKnownOptions(
  element: WritableFormControl,
  label: string,
  name: string,
  fieldType: FieldType,
): string[] {
  const options = new Set<string>();

  if (element instanceof HTMLSelectElement) {
    for (const option of Array.from(element.options)) {
      const text = option.text.trim();
      if (text && option.value) options.add(text);
    }
  }

  if (element instanceof HTMLInputElement && ['radio', 'checkbox'].includes(element.type)) {
    const optionLabel = element.id
      ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim()
      : element.closest('label')?.textContent?.trim();
    const optionValue = optionLabel || element.value.trim();
    if (optionValue && optionValue !== 'on') options.add(optionValue);
  }

  if (
    options.size === 0
    && (fieldType === FieldType.EDUCATION_COUNTRY || fieldType === FieldType.NATIONALITY)
  ) {
    ['中国', '中国香港', '中国澳门', '中国台湾', '其他']
      .forEach(option => options.add(option));
  }
  if (
    options.size === 0
    && (fieldType === FieldType.EDUCATION_TYPE || label === '学历类型' || name === 'education_type')
  ) {
    ['海外及港澳台', '统招全日制', '统招非全日制', '自考', '其他']
      .forEach(option => options.add(option));
  }
  if (
    options.size === 0
    && (fieldType === FieldType.DEGREE || label === '学历' || name === 'degree')
  ) {
    ['高中', '专科', '本科', '硕士', '博士'].forEach(option => options.add(option));
  }
  return Array.from(options);
}

function getDateRangeFillPriority(element: Element): number {
  const container = getFieldContainer(element);
  if (!container || !/起止时间|学习时间|工作时间/.test(container.textContent || '')) return 2;

  const inputs = Array.from(
    container.querySelectorAll(FORM_CONTROL_SELECTOR)
  ).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  return inputs.indexOf(element) === 1 ? 0 : 1;
}

// 注入 AI 生成按钮到开放性问题旁
function injectAIButtons() {
  const detector = new OpenQuestionDetector();
  const openFields = detector.detect();

  for (const field of openFields) {
    if (field.element.parentElement?.querySelector('.ai-gen-btn')) continue;

    const btn = document.createElement('button');
    btn.className = 'ai-gen-btn';
    btn.textContent = 'AI 生成';
    btn.style.cssText = `
      margin-left: 8px; margin-top: 6px; padding: 4px 12px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white; border: none; border-radius: 4px;
      font-size: 12px; cursor: pointer; display: inline-block;
    `;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.textContent = '生成中...';
      (btn as HTMLButtonElement).disabled = true;

      const response = await sendRuntimeMessage({
        type: 'GENERATE_ANSWER',
        payload: {
          questionText: field.questionText,
          context: field.context,
          fieldMaxLength: parseInt(field.element.getAttribute('maxlength') || '0') || undefined,
          language: /[一-鿿]/.test(field.questionText) ? 'zh' : 'en',
        },
      });

      if (response.success && response.data) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set;

        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(field.element, response.data.answer);
        } else {
          field.element.value = response.data.answer;
        }
        field.element.dispatchEvent(new Event('input', { bubbles: true }));
        field.element.dispatchEvent(new Event('change', { bubbles: true }));
        field.element.style.border = '2px solid #667eea';
        btn.textContent = 'AI 生成 ✓';
      } else {
        btn.textContent = '生成失败';
        console.error('Generation failed:', response.error);
      }

      setTimeout(() => {
        btn.textContent = 'AI 生成';
        (btn as HTMLButtonElement).disabled = false;
      }, 3000);
    });

    field.element.insertAdjacentElement('afterend', btn);
  }
}

const FILL_FIELD_LABELS: Partial<Record<FieldType, string>> = {
  [FieldType.GENDER]: '性别',
  [FieldType.PHONE_COUNTRY_CODE]: '手机区号',
  [FieldType.PHONE]: '手机号码',
  [FieldType.ID_TYPE]: '证件类型',
  [FieldType.ID_CARD]: '证件号码',
  [FieldType.NATIONALITY]: '国籍/地区',
  [FieldType.HOMETOWN]: '籍贯',
  [FieldType.CURRENT_ADDRESS]: '现居地',
  [FieldType.SCHOOL]: '学校名称',
  [FieldType.EDUCATION_COUNTRY]: '学校所属国家/地区',
  [FieldType.SCHOOL_LOCATION]: '学校所在地',
  [FieldType.EDUCATION_TYPE]: '学习方式',
  [FieldType.DEGREE]: '学历/学位',
  [FieldType.LANGUAGE]: '外语语种',
  [FieldType.LANGUAGE_CERTIFICATE]: '外语证书',
  [FieldType.LANGUAGE_LEVEL]: '外语等级/成绩',
};

function formatFillIssues(issues: FillDiagnostics['rejectedFields']): string {
  return issues.map(issue => {
    const label = FILL_FIELD_LABELS[issue.fieldType] || issue.fieldType;
    const field = issue.rowIndex === undefined ? label : `${label}（第 ${issue.rowIndex + 1} 条）`;
    const reasons = {
      'dropdown-not-open': '下拉未展开',
      'option-not-found': '未找到匹配候选',
      'selection-not-confirmed': '已点击但未确认',
      'region-leaf-required': '网站要求继续选择到区/县，请在插件资料中补全末级行政区',
      'identity-number-not-committed': '证件号码未被网页接受',
    };
    return issue.reason ? `${field}：${reasons[issue.reason]}` : field;
  }).join('、');
}

function buildFillSummaryText(filledCount: number, diagnostics: FillDiagnostics): string {
  const parts = [`已确认填入 ${filledCount} 项`];
  if (diagnostics.missingRequiredFields.length > 0) {
    parts.push(`插件资料为空：${formatFillIssues(diagnostics.missingRequiredFields)}`);
  }
  if (diagnostics.rejectedFields.length > 0) {
    parts.push(`网页未接受：${formatFillIssues(diagnostics.rejectedFields)}`);
  }
  return parts.join('；');
}

function showQuickFillStatus(initialText: string) {
  const element = document.createElement('div');
  element.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:1000005;max-width:520px;padding:12px 14px;border-radius:8px;background:#24262d;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.28);font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  element.textContent = initialText;
  document.body.appendChild(element);

  const finish = (text: string, background: string) => {
    element.textContent = text;
    element.style.background = background;
    setTimeout(() => element.remove(), 6000);
  };
  return {
    complete(text: string, hasRejectedFields: boolean) {
      finish(text, hasRejectedFields ? '#a16207' : '#15803d');
    },
    fail(text: string) {
      finish(text, '#b91c1c');
    },
  };
}

// 显示成功消息
function showSuccessMessage(filledCount: number, diagnostics: FillDiagnostics) {
  const message = document.createElement('div');
  const hasIssues = diagnostics.missingRequiredFields.length > 0
    || diagnostics.rejectedFields.length > 0;
  message.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 1000000;
    background: ${hasIssues ? '#a16207' : '#10b981'};
    color: white;
    padding: 16px 24px;
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 10px;
    animation: slideIn 0.3s ease;
  `;

  message.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
    <span>${buildFillSummaryText(filledCount, diagnostics)}</span>
  `;

  document.body.appendChild(message);

  setTimeout(() => {
    message.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => {
      document.body.removeChild(message);
    }, 300);
  }, 3000);
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_APPLICATION_PAGE_METADATA') {
    extractApplicationPageMetadata(document, window.location.href).then((metadata) => {
      sendResponse({
        success: true,
        data: metadata,
      });
    }).catch((error) => {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : '岗位信息提取失败',
      });
    });
    return true;
  }

  if (message.type === 'DETECT_FIELDS') {
    detectedFields = formDetector.detectFields();
    sendResponse({
      success: true,
      data: {
        count: detectedFields.length,
        fields: detectedFields.map((f) => ({
          fieldType: f.fieldType,
          confidence: f.confidence
        }))
      }
    });
    return true;
  }

  if (message.type === 'FILL_FORM') {
    handleFillButtonClick().then((result) => {
      sendResponse({ success: true, data: result });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.type === 'START_QUICK_FILL' || message.type === 'START_AI_PAGE_FILL') {
    sendResponse(startPageFillTask(
      message.type === 'START_QUICK_FILL' ? handleFillButtonClick : handleAIPageFill,
    ));
    return false;
  }

  if (message.type === 'START_AI_REGION_FILL') {
    startAIRegionSelection();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'APPLY_FOCUSED_FIELD') {
    applyValueToFocusedControl(message.payload.value).then((result) => {
      sendResponse({ success: true, data: result });
    }).catch((error) => {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : '写入目标字段失败',
      });
    });
    return true;
  }
});

// 添加 CSS 动画
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);
