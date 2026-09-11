import type { DetectedField } from '../shared/types';
import { FieldType } from '../shared/types';
import { DETECTED_FIELD_CONFIDENCE, FieldMatcher } from '../utils/fieldMatcher';
import {
  FIELD_CONTAINER_SELECTOR,
  FORM_CONTROL_SELECTOR,
  getControlValue,
  getFieldContainer,
  isCustomSelectControl,
  isVisibleFormControl,
  isPrimaryCustomSelectControl,
  isWritableFormControl,
  type WritableFormControl,
} from './formControl.ts';

const RESUME_UPLOAD_CONTEXT_SELECTOR = [
  '[data-resume-upload]',
  '[data-testid*=resume-upload]',
  '[class*=resume-upload]',
  '[class*=resume_upload]',
  '[class*=resumeUpload]',
  '[class*=upload-resume]',
  '[class*=upload_resume]',
  '[class*=uploadResume]',
  '[class*=resume-analysis]',
  '[class*=resume_analysis]',
  '[class*=resumeAnalysis]',
  '[class*=cv-upload]',
  '[class*=cv_upload]',
  '[class*=cvUpload]',
].join(', ');

const FORM_FIELD_LABEL_SELECTOR = [
  '.ud-formily-item-label label',
  '.ud-formily-item-label',
  '.md-form-item__label',
  '.el-form-item__label',
  '.ant-form-item-label',
  '.arco-form-item-label',
  'label',
  '[class*=label]',
].join(', ');

/**
 * 证件组合项经常不给号码框 name/id，甚至错误复用 phone 类名。
 * 此时只使用用户可见标签和同一表单项内的控件位置，不依赖站点类名。
 */
export function matchIdentityCompoundControl(
  element: WritableFormControl,
): FieldType | null {
  const container = getFieldContainer(element);
  if (!container) return null;

  const labelText = container.querySelector<HTMLElement>(FORM_FIELD_LABEL_SELECTOR)
    ?.textContent?.replace(/\s+/g, ' ').trim() || '';
  if (!/(?:证件|身份证|护照)(?:类型|类别|号|号码|信息)?/i.test(labelText)) return null;

  const controls = Array.from(
    container.querySelectorAll<WritableFormControl>(FORM_CONTROL_SELECTOR),
  ).filter(isWritableFormControl);
  if (controls.length < 2) return null;

  const index = controls.indexOf(element);
  if (index < 0) return null;
  const isSelect = element.tagName === 'SELECT' || isCustomSelectControl(element);
  if (index === 0 && isSelect) return FieldType.ID_TYPE;
  // 组合输入组可能把前置下拉箭头包在共同父容器内，导致后续普通 input
  // 被通用下拉启发式误判。证件标签已经锁定语义后，第二个及后续非
  // select 控件应按位置识别为证件号码。
  if (index > 0 && element.tagName !== 'SELECT') return FieldType.ID_CARD;
  return null;
}

export function shouldAnalyzeFormControl(element: WritableFormControl): boolean {
  return matchIdentityCompoundControl(element) !== null
    || isPrimaryCustomSelectControl(element);
}

export function isResumeUploadSemanticContext(
  directText: string,
  contextText: string,
  contextClass: string,
): boolean {
  const combined = `${directText} ${contextText}`.replace(/\s+/g, ' ').trim();
  const excluded = /个人照片|证件照|头像|相关作品|作品附件|portfolio|客服|意见反馈|问题反馈/i;
  if (excluded.test(combined)) return false;

  return /简历|个人履历|curriculum\s+vitae|(?:^|\W)(?:resume|cv)(?:\W|$)/i.test(combined)
    || /(?:resume|cv)[_-]?(?:upload|analysis)|(?:upload|analysis)[_-]?(?:resume|cv)/i.test(contextClass);
}

export interface UnmatchedField {
  element: WritableFormControl;
  identifiers: ReturnType<typeof FieldMatcher.extractIdentifiers>;
}

export class FormDetector {
  private observer: MutationObserver | null = null;
  private redetectTimer: ReturnType<typeof setTimeout> | null = null;
  private detectedFields: DetectedField[] = [];
  private unmatchedFields: UnmatchedField[] = [];

  // 检测页面中的所有表单字段
  detectFields(): DetectedField[] {
    this.detectedFields = [];
    this.unmatchedFields = [];

    // 使用统一选择器保持真实 DOM 顺序；自定义下拉通常仍包含一个只读 input。
    const controls = document.querySelectorAll(FORM_CONTROL_SELECTOR);
    controls.forEach((element) => {
      if (isWritableFormControl(element) && shouldAnalyzeFormControl(element)) this.analyzeElement(element);
    });
    this.ensureIdentityCompoundFields(controls);

    console.log(`Detected ${this.detectedFields.length} form fields, ${this.unmatchedFields.length} unmatched`);
    return this.detectedFields;
  }

  // 分析单个元素
  private analyzeElement(
    element: WritableFormControl
  ): void {
    // 跳过不可见或禁用的元素
    if (!isVisibleFormControl(element) || !isWritableFormControl(element)) {
      return;
    }

    // 提取元素标识符
    const identifiers = FieldMatcher.extractIdentifiers(element);

    // 匹配字段类型
    const compoundFieldType = matchIdentityCompoundControl(element);
    const { fieldType, confidence } = compoundFieldType
      ? { fieldType: compoundFieldType, confidence: 1 }
      : FieldMatcher.matchFieldType(
        identifiers.name,
        identifiers.id,
        identifiers.placeholder,
        identifiers.labelText,
        identifiers.type,
        identifiers.autocomplete,
      );

    if (confidence >= DETECTED_FIELD_CONFIDENCE && fieldType !== FieldType.UNKNOWN) {
      this.detectedFields.push({
        element,
        fieldType,
        confidence,
        value: getControlValue(element),
        rowIndex: FieldMatcher.extractRowIndex(element),
      });
    } else {
      this.unmatchedFields.push({ element, identifiers });
    }
  }

  private ensureIdentityCompoundFields(controls: NodeListOf<Element>): void {
    controls.forEach(element => {
      if (!isWritableFormControl(element)
        || !isVisibleFormControl(element)) return;

      const fieldType = matchIdentityCompoundControl(element);
      if (!fieldType) return;

      const detected = this.detectedFields.find(field => field.element === element);
      if (detected) {
        detected.fieldType = fieldType;
        detected.confidence = 1;
        return;
      }

      this.unmatchedFields = this.unmatchedFields.filter(field => field.element !== element);
      this.detectedFields.push({
        element,
        fieldType,
        confidence: 1,
        value: getControlValue(element),
        rowIndex: FieldMatcher.extractRowIndex(element),
      });
    });
  }

  // 开始监听DOM变化
  startObserving(callback: (fields: DetectedField[]) => void): void {
    if (this.observer) {
      return;
    }

    this.observer = new MutationObserver((mutations) => {
      let shouldRedetect = false;

      for (const mutation of mutations) {
        // 检查是否添加了新的表单元素
        if (mutation.addedNodes.length > 0) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const element = node as Element;
              if (
                element.tagName === 'INPUT' ||
                element.tagName === 'TEXTAREA' ||
                element.tagName === 'SELECT' ||
                element.querySelector(FORM_CONTROL_SELECTOR)
              ) {
                shouldRedetect = true;
                break;
              }
            }
          }
        }

        if (shouldRedetect) break;
      }

      if (shouldRedetect) {
        if (this.redetectTimer !== null) clearTimeout(this.redetectTimer);
        this.redetectTimer = setTimeout(() => {
          this.redetectTimer = null;
          callback(this.detectFields());
        }, 80);
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    console.log('Started observing DOM changes');
  }

  // 停止监听
  stopObserving(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
      if (this.redetectTimer !== null) {
        clearTimeout(this.redetectTimer);
        this.redetectTimer = null;
      }
      console.log('Stopped observing DOM changes');
    }
  }

  // 获取已检测的字段
  getDetectedFields(): DetectedField[] {
    return this.detectedFields;
  }

  // 获取未匹配的字段（供 LLM 语义匹配使用）
  getUnmatchedFields(): UnmatchedField[] {
    return this.unmatchedFields;
  }

  // 根据字段类型查找元素
  findFieldsByType(fieldType: FieldType): DetectedField[] {
    return this.detectedFields.filter((field) => field.fieldType === fieldType);
  }

  // 查找文件上传控件
  findFileInputs(): HTMLInputElement[] {
    const matches = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
      .map(input => {
        const context = this.getResumeUploadContext(input);
        const directText = [
          input.name,
          input.id,
          input.getAttribute('aria-label') || '',
          input.getAttribute('title') || '',
          input.getAttribute('placeholder') || '',
        ].join(' ');
        const contextText = (context?.textContent || '').slice(0, 800);
        const contextClass = context?.getAttribute('class') || '';
        return {
          input,
          context,
          accepted: isResumeUploadSemanticContext(directText, contextText, contextClass),
        };
      })
      .filter(match => match.accepted);

    // 同一个上传组件可能同时渲染组件库 input 和隐藏的原生 input。
    // 每个语义容器只保留一个，避免一次快速填充重复触发网站简历解析。
    const seen = new Set<Element>();
    return matches.filter(({ context }) => {
      const identity = context || document.body;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    }).map(({ input }) => input);
  }

  hasMatchingAttachedResume(input: HTMLInputElement, fileName: string): boolean {
    if (Array.from(input.files || []).some(file => file.name === fileName)) return true;

    const context = this.getResumeUploadContext(input);
    if (!context) return false;
    const displayed = this.normalizeFileName(context.textContent || '');
    const expected = this.normalizeFileName(fileName);
    return Boolean(expected && displayed.includes(expected));
  }

  private getResumeUploadContext(input: HTMLInputElement): HTMLElement | null {
    return input.closest<HTMLElement>(RESUME_UPLOAD_CONTEXT_SELECTOR)
      || input.closest<HTMLElement>(FIELD_CONTAINER_SELECTOR)
      || input.closest<HTMLElement>('label, fieldset, [class*=upload]')
      || input.parentElement;
  }

  private normalizeFileName(value: string): string {
    return value.toLocaleLowerCase().replace(/[\s\u200b-\u200d\ufeff]/g, '');
  }
}
