import type { DetectedField, UserProfile } from '../shared/types';
import { FieldType } from '../shared/types';
import { GENDER_OPTIONS, DEGREE_OPTIONS } from '../shared/constants';
import {
  FORM_CONTROL_SELECTOR,
  getControlValue,
  getCustomSelectSelectedText,
  getCustomSelectRoot,
  getFieldContainer,
  isCustomSelectControl,
  isSearchableCustomSelectControl,
  type WritableFormControl,
} from './formControl.ts';
import {
  areEquivalentOptionValues,
  scoreOptionMatch,
} from '../utils/optionMatcher.ts';
import { findTextLengthLimit, truncateToTextLength } from '../utils/textLimit.ts';
import { normalizeDescriptionText } from '../utils/descriptionText.ts';
import { resolveEducationCountryRegion, resolvePersonalNationality } from '../utils/profileSemantics.ts';

export type FillSection = 'all' | 'personal' | 'education' | 'languages' | 'experience' | 'projects' | 'awards';

export interface FillIssue {
  fieldType: FieldType;
  rowIndex?: number;
  reason?: 'dropdown-not-open' | 'option-not-found' | 'selection-not-confirmed' | 'region-leaf-required' | 'identity-number-not-committed';
}

export interface FillDiagnostics {
  missingRequiredFields: FillIssue[];
  rejectedFields: FillIssue[];
}

const EDUCATION_FIELD_TYPES = new Set<FieldType>([
  FieldType.SCHOOL,
  FieldType.EDUCATION_COUNTRY,
  FieldType.SCHOOL_LOCATION,
  FieldType.COLLEGE,
  FieldType.EDUCATION_TYPE,
  FieldType.MAJOR,
  FieldType.DEGREE,
  FieldType.GPA,
  FieldType.EDUCATION_START_DATE,
  FieldType.GRADUATION_DATE,
]);

const AWARD_FIELD_TYPES = new Set<FieldType>([
  FieldType.AWARD_NAME,
  FieldType.AWARD_ROLE,
  FieldType.AWARD_DATE,
  FieldType.AWARD_DESCRIPTION,
]);

const EXPERIENCE_FIELD_TYPES = new Set<FieldType>([
  FieldType.COMPANY,
  FieldType.POSITION,
  FieldType.START_DATE,
  FieldType.END_DATE,
  FieldType.DESCRIPTION,
]);

const PROJECT_FIELD_TYPES = new Set<FieldType>([
  FieldType.PROJECT_NAME,
  FieldType.PROJECT_ROLE,
  FieldType.PROJECT_START_DATE,
  FieldType.PROJECT_END_DATE,
  FieldType.PROJECT_DESCRIPTION,
]);

const LANGUAGE_FIELD_TYPES = new Set<FieldType>([
  FieldType.LANGUAGE,
  FieldType.LANGUAGE_CERTIFICATE,
  FieldType.LANGUAGE_LEVEL,
]);

// 这些字段容易被后续联动下拉清空或在依赖数据加载前首次选择失败。
// 按此顺序最终复核，身份证号放在个人信息下拉之后最后写回。
const FINAL_REPAIR_FIELD_TYPES: FieldType[] = [
  FieldType.NATIONALITY,
  FieldType.HOMETOWN,
  FieldType.CURRENT_ADDRESS,
  FieldType.SCHOOL_LOCATION,
  FieldType.EDUCATION_TYPE,
  // These prefixes control sibling inputs in Vue compound components. They
  // must be repaired before their dependent phone/identity values.
  FieldType.PHONE_COUNTRY_CODE,
  FieldType.PHONE,
  FieldType.ID_TYPE,
  FieldType.ID_CARD,
];

// 地区级联的下一级候选通常需要一次异步接口请求；给组件渲染和网络抖动
// 留出时间，但不改变普通固定下拉的响应速度。
const CASCADE_OPTION_TIMEOUT_MS = 2500;
const ID_CARD_COMMIT_SETTLE_MS = 220;

const REGION_PATH_SEPARATOR = /\s*(?:[-—–/／>＞,，、|｜]+|\s+)\s*/;
const REGION_ADMIN_SUFFIX = /特别行政区|自治区|自治州|地区|盟|省|市|区|县|旗/g;
const REGION_STRUCTURAL_NODE = /^(?:.+直辖县级行政区划|市辖区|县|辖区|城区|郊县|其他(?:区县|地区|城市)?)$/;

export function isRegionStructuralNodeLabel(value: string): boolean {
  return REGION_STRUCTURAL_NODE.test(value.replace(/\s+/g, '').trim());
}

/**
 * 将资料中常见的籍贯文本转成有序行政区路径。不同 ATS 的下拉文案不同，
 * 每一级必须独立匹配，不能拿完整籍贯和每一列候选做包含判断。
 */
export function parseRegionPath(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const separated = trimmed.split(REGION_PATH_SEPARATOR).filter(Boolean);
  if (separated.length > 1) {
    return /^(?:中国|中国大陆|中华人民共和国)$/i.test(separated[0])
      ? separated.slice(1)
      : separated;
  }

  const compact = trimmed
    .replace(/\s+/g, '')
    .replace(/^(?:中华人民共和国|中国大陆|中国)/, '');
  const path: string[] = [];
  let remaining = compact;
  const province = remaining.match(/^(.+?(?:特别行政区|自治区|省|市))/)?.[1];
  if (!province) return [trimmed];

  path.push(province);
  remaining = remaining.slice(province.length);
  while (remaining) {
    const division = remaining.match(/^(.+?(?:自治州|地区|盟|市|区|县|旗))/)?.[1];
    if (!division) {
      path.push(remaining);
      break;
    }
    path.push(division);
    remaining = remaining.slice(division.length);
  }
  return path.filter(Boolean);
}

export class FormFiller {
  private lastSelectionFailure?: FillIssue['reason'];
  private lastFillDiagnostics: FillDiagnostics = {
    missingRequiredFields: [],
    rejectedFields: [],
  };

  // 字节等网申页面常见模式：经历条目需要先点击“添加”才会出现空白行
  async prepareDynamicSections(profile: UserProfile, section: FillSection = 'all'): Promise<void> {
    if (section === 'all' || section === 'education') {
      await this.ensureEducationRows(profile.education.length);
    }
    if (section === 'all' || section === 'languages') {
      await this.ensureLanguageRows(profile.languages?.length || 0);
    }
    if (section === 'all' || section === 'experience') {
      await this.ensureExperienceRows(profile.experience.length);
    }
    if (section === 'all' || section === 'projects') {
      await this.ensureProjectRows(profile.projects.length);
    }
  }

  async fillElementValues(
    values: Array<{
      element: WritableFormControl;
      value: string;
    }>,
    shouldContinue: () => boolean = () => true
  ): Promise<number> {
    let filledCount = 0;

    for (const item of values) {
      if (!shouldContinue()) break;
      if (!item.value) continue;
      if (await this.fillField(item.element, item.value)) filledCount++;
    }

    return filledCount;
  }

  async fillFocusedControl(
    element: WritableFormControl,
    value: string
  ): Promise<boolean> {
    if (!element.isConnected || element.disabled) return false;

    const accepted = await this.fillField(element, value);
    if (!accepted) return false;
    await this.wait(30);

    if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
      return element.checked;
    }

    if (element.tagName === 'SELECT') {
      const select = element as HTMLSelectElement;
      const selectedText = select.options[select.selectedIndex]?.text || '';
      return this.valuesMatch(select.value, value) || this.valuesMatch(selectedText, value);
    }

    if (isCustomSelectControl(element)) {
      const selectedText = getControlValue(element);
      return this.valuesMatch(selectedText, value);
    }

    return element.value === this.constrainTextValue(
      element as HTMLInputElement | HTMLTextAreaElement,
      value,
    );
  }

  // 填充所有检测到的字段
  async fillForm(
    fields: DetectedField[],
    profile: UserProfile,
    redetectFields?: () => DetectedField[],
  ): Promise<number> {
    console.log(`Filling ${fields.length} form fields`);

    this.lastFillDiagnostics = {
      missingRequiredFields: [],
      rejectedFields: [],
    };

    const educationIndexes: Partial<Record<FieldType, number>> = {};
    const experienceIndexes: Partial<Record<FieldType, number>> = {};
    const projectIndexes: Partial<Record<FieldType, number>> = {};
    const languageIndexes: Partial<Record<FieldType, number>> = {};
    const awardRowIndexes = new Map<Element, number>();
    let fallbackAwardIndex = -1;
    const rangeResult = await this.fillDateRangeFields(fields, profile);
    let filledCount = rangeResult.filledCount;
    const orderedFields = fields.filter(field => !rangeResult.handledElements.has(field.element));
    // 选择一个依赖控件后，招聘组件可能在同一轮 Vue 更新中新增或替换其它控件。
    // 保留待处理队列，避免初始快照过早结束导致籍贯、证件号码、学习方式漏填。
    const pendingFields = [...orderedFields];
    const queuedElements = new Set<Element>(pendingFields.map(field => field.element));
    const fillSections = typeof document === 'undefined'
      ? new Set<FillSection | null>()
      : new Set(orderedFields.map(field => this.getSectionForElement(field.element)));
    let occurrences = this.indexFieldOccurrences(pendingFields);
    let liveFields = redetectFields ? redetectFields() : fields;
    const awardElements = orderedFields
      .filter(field => AWARD_FIELD_TYPES.has(field.fieldType as FieldType))
      .map(field => field.element);
    const awardRows = new Map(awardElements.map(element => [
      element,
      this.getAwardRowContainer(element, awardElements),
    ]));
    const handledChoiceGroups = new Set<Element>();

    for (let fieldIndex = 0; fieldIndex < pendingFields.length; fieldIndex += 1) {
      const field = pendingFields[fieldIndex];
      this.lastSelectionFailure = undefined;
      try {
        let occurrence = occurrences.get(field) || 0;
        let liveField = this.findEquivalentLiveField(field, liveFields, occurrence);
        if (!liveField && redetectFields) {
          // 前置下拉完成后，旧依赖 input 可能稍后才被移除。判定失败前先
          // 重检测并绑定新节点，不能把队列中的旧引用直接记为拒绝。
          try {
            for (const delay of [0, 40, 120]) {
              if (delay > 0) await this.wait(delay);
              liveFields = redetectFields();
              this.mergeRedetectedFields(
                pendingFields,
                queuedElements,
                liveFields,
                fillSections,
                rangeResult.handledElements,
                fieldIndex - 1,
              );
              occurrences = this.indexFieldOccurrences(pendingFields);
              occurrence = occurrences.get(field) || 0;
              liveField = this.findEquivalentLiveField(field, liveFields, occurrence);
              if (liveField) break;
            }
          } catch (error) {
            console.warn('Failed to rebind detached form field:', error);
          }
        }
        if (!liveField) {
          this.recordFillIssue('rejectedFields', field);
          console.warn('Skipped detached form field without a live replacement:', field.fieldType, field.rowIndex);
          continue;
        }
        const choiceGroup = this.getChoiceGroup(liveField.element);
        if (choiceGroup && handledChoiceGroups.has(choiceGroup)) continue;
        if (choiceGroup) handledChoiceGroups.add(choiceGroup);
        const fieldType = field.fieldType as FieldType;
        const educationIndex = this.getNextEducationIndex(fieldType, educationIndexes, field.rowIndex);
        const experienceIndex = this.getNextExperienceIndex(fieldType, experienceIndexes, field.rowIndex);
        const projectIndex = this.getNextProjectIndex(fieldType, projectIndexes, field.rowIndex);
        const languageIndex = this.getNextLanguageIndex(fieldType, languageIndexes, field.rowIndex);
        const awardRow = awardRows.get(field.element) || null;
        const awardIndex = AWARD_FIELD_TYPES.has(fieldType)
          ? this.getAwardIndex(awardRow, fieldType, awardRowIndexes, fallbackAwardIndex)
          : undefined;
        if (AWARD_FIELD_TYPES.has(fieldType) && !awardRow && fieldType === FieldType.AWARD_NAME) {
          fallbackAwardIndex += 1;
        }
        const value = this.getValueForField(
          fieldType,
          profile,
          educationIndex,
          experienceIndex,
          awardIndex,
          languageIndex,
          projectIndex,
        );
        if (value === null || value === undefined || value === '') {
          if (this.isRequiredField(liveField.element)) {
            this.recordFillIssue('missingRequiredFields', field);
            console.info('Required profile value is empty:', field.fieldType, field.rowIndex);
          }
          continue;
        }

        const wasCustomSelect = typeof HTMLInputElement !== 'undefined'
          && isCustomSelectControl(liveField.element);
        const dependentElementsBefore = this.snapshotDependentElements(
          liveFields,
          fieldType,
          field.rowIndex,
        );
        const currentFields = redetectFields || (() => liveFields);
        const canUseIdentityInputPath = fieldType === FieldType.ID_CARD
          && typeof HTMLInputElement !== 'undefined'
          && liveField.element instanceof HTMLInputElement;
        let accepted = canUseIdentityInputPath
          ? await this.confirmIdentityNumberCommit(
            liveField,
            value,
            currentFields,
            occurrence,
          )
          : await this.fillField(liveField.element, value);

        if (wasCustomSelect && redetectFields) {
          // 选择证件类型、学校等下拉项后，部分 Vue/React 表单会替换同组
          // 其余 input。后续字段必须重新绑定到当前 DOM，不能继续写旧节点。
          // 依赖控件可能在一次异步请求后才出现，因此只对这些控件做短轮询；
          // 普通固定下拉仍保持单次 20ms 重检测。
          const refreshDelays = this.getDependentFieldTypes(fieldType).length > 0
            ? [20, 60, 140, 300]
            : [20];
          let previousDelay = 0;
          try {
            for (const delay of refreshDelays) {
              await this.wait(delay - previousDelay);
              previousDelay = delay;
              liveFields = redetectFields();
              const refreshed = this.findEquivalentLiveField(field, liveFields, occurrence);
              if (refreshed) accepted = this.isCurrentFieldValueAccepted(refreshed, value);

              this.mergeRedetectedFields(
                pendingFields,
                queuedElements,
                liveFields,
                fillSections,
                rangeResult.handledElements,
                fieldIndex,
              );
              occurrences = this.indexFieldOccurrences(pendingFields);

              if (this.haveDependentElementsRefreshed(
                liveFields,
                fieldType,
                field.rowIndex,
                dependentElementsBefore,
              )) break;
            }
          } catch (error) {
            console.warn('Failed to refresh fields after custom selection:', error);
          }
        }

        if (accepted) {
          filledCount++;
        } else {
          this.recordFillIssue('rejectedFields', field);
          console.warn('Website did not accept field value:', field.fieldType, field.rowIndex, {
            reason: this.lastSelectionFailure || 'value-rejected',
            pageFocused: typeof document !== 'undefined' && typeof document.hasFocus === 'function'
              ? document.hasFocus()
              : undefined,
          });
        }
      } catch (error) {
        this.recordFillIssue('rejectedFields', field);
        console.error(`Failed to fill field ${field.fieldType}:`, error);
      }
    }

    if (redetectFields) {
      filledCount += await this.repairVolatileFields(profile, redetectFields, fillSections);
    }

    console.log(`Form filling completed: ${filledCount} fields accepted`);
    return filledCount;
  }

  getLastFillDiagnostics(): FillDiagnostics {
    return {
      missingRequiredFields: this.lastFillDiagnostics.missingRequiredFields.map(issue => ({ ...issue })),
      rejectedFields: this.lastFillDiagnostics.rejectedFields.map(issue => ({ ...issue })),
    };
  }

  private async repairVolatileFields(
    profile: UserProfile,
    redetectFields: () => DetectedField[],
    fillSections: Set<FillSection | null>,
  ): Promise<number> {
    let repairedRejectedCount = 0;
    await this.wait(80);

    for (const fieldType of FINAL_REPAIR_FIELD_TYPES) {
      const liveFields = redetectFields().filter(candidate => (
        candidate.fieldType === fieldType
        && candidate.element.isConnected !== false
        && this.isElementInFillSections(candidate.element, fillSections)
      ));

      for (let occurrence = 0; occurrence < liveFields.length; occurrence += 1) {
        const field = liveFields[occurrence];
        const educationIndex = EDUCATION_FIELD_TYPES.has(fieldType)
          ? field.rowIndex ?? occurrence
          : undefined;
        const value = this.getValueForField(fieldType, profile, educationIndex);
        if (!value) continue;

        const wasRejected = this.hasFillIssue('rejectedFields', field);
        if (this.isCurrentFieldValueAccepted(field, value)) {
          if (wasRejected) {
            this.clearFillIssue('rejectedFields', field);
            repairedRejectedCount += 1;
          }
          continue;
        }

        this.lastSelectionFailure = undefined;
        // 身份证号不能先走普通输入链路：普通链路会立即触发 blur，
        // 美的等 Vue 表单会在该时机清空尚未提交的证件号。
        const canUseIdentityInputPath = fieldType === FieldType.ID_CARD
          && typeof HTMLInputElement !== 'undefined'
          && field.element instanceof HTMLInputElement;
        const accepted = canUseIdentityInputPath
          ? await this.confirmIdentityNumberCommit(
            field,
            value,
            redetectFields,
            occurrence,
          )
          : await this.fillField(field.element, value);
        if (accepted) {
          this.clearFillIssue('rejectedFields', field);
          if (wasRejected) repairedRejectedCount += 1;
          console.info('Re-applied field after dependent form updates:', field.fieldType, field.rowIndex);
        } else {
          this.recordFillIssue('rejectedFields', field);
        }
        if (isCustomSelectControl(field.element)) await this.wait(80);
      }
    }

    return repairedRejectedCount;
  }

  private async confirmIdentityNumberCommit(
    field: DetectedField,
    value: string,
    redetectFields: () => DetectedField[],
    occurrence: number,
  ): Promise<boolean> {
    let current = redetectFields().filter(candidate => (
      candidate.fieldType === FieldType.ID_CARD
      && candidate.element.isConnected !== false
    ))[occurrence] || (field.element.isConnected !== false ? field : undefined);
    if (!current) return false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const acceptedByDom = this.fillIdentityNumberField(current.element, value);
      console.log(`Identity number input attempt ${attempt + 1}: ${acceptedByDom ? 'dom-value-set' : 'dom-value-rejected'}`);
      await this.wait(ID_CARD_COMMIT_SETTLE_MS);

      current = redetectFields().filter(candidate => (
        candidate.fieldType === FieldType.ID_CARD
        && candidate.element.isConnected !== false
      ))[occurrence] || current;
      if (this.isCurrentFieldValueAccepted(current, value)) {
        console.log('Identity number committed through browser text editing');
        return true;
      }
      if (!acceptedByDom) return false;
    }

    this.lastSelectionFailure = 'identity-number-not-committed';
    console.log('Identity number was not retained after browser text editing');
    return false;
  }

  private fillIdentityNumberField(element: WritableFormControl, value: string): boolean {
    if (!(element instanceof HTMLInputElement)) return false;
    const constrainedValue = truncateToTextLength(
      value,
      findTextLengthLimit(element.maxLength, ''),
    );
    element.focus({ preventScroll: true });
    element.select();

    let inserted = false;
    try {
      if (typeof document.execCommand === 'function') {
        inserted = document.execCommand('insertText', false, constrainedValue);
      }
    } catch (error) {
      console.warn('Browser text insertion failed for identity number:', error);
    }

    if (!inserted || element.value !== constrainedValue) {
      this.fillInputField(element, constrainedValue);
    }

    // execCommand 在部分组件里只改变 DOM value，不一定产生 Vue v-model
    // 监听的 input 事件。无论浏览器是否报告插入成功，都补发文本输入事件，
    // 再失焦触发网站自己的身份证校验。
    const inputEvent = typeof InputEvent === 'function'
      ? new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: constrainedValue,
        inputType: 'insertReplacementText',
      })
      : new Event('input', { bubbles: true, cancelable: true });
    element.dispatchEvent(inputEvent);
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.blur();
    return element.value === constrainedValue;
  }

  private isElementInFillSections(
    element: Element,
    fillSections: Set<FillSection | null>,
  ): boolean {
    const knownSections = Array.from(fillSections).filter(
      (section): section is FillSection => section !== null,
    );
    if (knownSections.length === 0) return true;
    const section = this.getSectionForElement(element);
    return section === null || knownSections.includes(section);
  }

  private isCurrentFieldValueAccepted(field: DetectedField, value: string): boolean {
    // 证件号码可能与前置证件类型下拉共用一个带箭头的输入组，通用下拉
    // 启发式会把号码框也视为下拉，并读到“身份证”等选中文本。这里必须
    // 优先核对号码 input 自身的 value，避免已成功写入却报告网页拒绝。
    if (field.fieldType === FieldType.ID_CARD) {
      return field.element.value.trim() === value.trim();
    }
    if (isCustomSelectControl(field.element)) {
      const input = field.element as HTMLInputElement;
      if (this.isRegionFieldType(field.fieldType as FieldType)) {
        const path = this.getCascadingRegionPath(input, value);
        if (path.length > 1) {
          // Re-detection is a read-only verification step. Do not close the
          // dropdown here: Vue controls can clear sibling values on blur/body
          // click (notably the id type and phone country code pickers).
          return this.acceptCascadingRegionSelection(input, path, true, false);
        }
      }
      return this.acceptCustomSelection(input, value, true, false);
    }
    return this.valuesMatch(getControlValue(field.element), value);
  }

  private hasFillIssue(type: keyof FillDiagnostics, field: DetectedField): boolean {
    return this.lastFillDiagnostics[type].some(issue => (
      issue.fieldType === field.fieldType && issue.rowIndex === field.rowIndex
    ));
  }

  private clearFillIssue(type: keyof FillDiagnostics, field: DetectedField): void {
    this.lastFillDiagnostics[type] = this.lastFillDiagnostics[type].filter(issue => !(
      issue.fieldType === field.fieldType && issue.rowIndex === field.rowIndex
    ));
  }

  private indexFieldOccurrences(fields: DetectedField[]): Map<DetectedField, number> {
    const indexes = new Map<string, number>();
    const result = new Map<DetectedField, number>();
    for (const field of fields) {
      const key = `${field.fieldType}:${field.rowIndex ?? 'none'}`;
      const occurrence = indexes.get(key) || 0;
      result.set(field, occurrence);
      indexes.set(key, occurrence + 1);
    }
    return result;
  }

  /**
   * Merge fields exposed by a dependent control after a custom selection.
   * iHR/Vue often replaces the old input node instead of mutating it in place.
   */
  private mergeRedetectedFields(
    pendingFields: DetectedField[],
    queuedElements: Set<Element>,
    liveFields: DetectedField[],
    fillSections: Set<FillSection | null>,
    handledElements: Set<Element>,
    processedThroughIndex = -1,
  ): void {
    const hasKnownFillSection = Array.from(fillSections).some(section => section !== null);
    for (const candidate of liveFields) {
      if (handledElements.has(candidate.element) || candidate.element.isConnected === false) continue;
      if (queuedElements.has(candidate.element)) continue;

      const section = fillSections.size > 0
        ? this.getSectionForElement(candidate.element)
        : null;
      if (hasKnownFillSection && section !== null && !fillSections.has(section)) continue;

      // A redraw can detach a field that was already in the initial snapshot.
      // Replace that queue entry so occurrence-based row mapping stays stable.
      const replacementIndex = pendingFields.findIndex(existing => (
        existing.element.isConnected === false
        && existing.fieldType === candidate.fieldType
        && existing.rowIndex === candidate.rowIndex
      ));
      if (replacementIndex >= 0) {
        const previous = pendingFields[replacementIndex];
        queuedElements.delete(previous.element);
        if (replacementIndex > processedThroughIndex) {
          pendingFields[replacementIndex] = candidate;
        } else {
          // 已经处理过的队列位置不能原地替换，否则循环不会再访问新节点；
          // 追加到队尾，确保插件资料仍会覆盖重绘后的控件。
          pendingFields.push(candidate);
        }
      } else {
        pendingFields.push(candidate);
      }
      queuedElements.add(candidate.element);
    }
  }

  private findEquivalentLiveField(
    field: DetectedField,
    liveFields: DetectedField[],
    occurrence: number,
  ): DetectedField | undefined {
    const candidates = liveFields.filter(candidate => (
      candidate.fieldType === field.fieldType
      && candidate.rowIndex === field.rowIndex
    ));
    const candidate = candidates[occurrence];
    if (candidate && candidate.element.isConnected !== false) return candidate;
    return field.element.isConnected !== false ? field : undefined;
  }

  private getDependentFieldTypes(fieldType: FieldType): FieldType[] {
    switch (fieldType) {
      case FieldType.SCHOOL:
        return [FieldType.EDUCATION_TYPE];
      case FieldType.ID_TYPE:
        return [FieldType.ID_CARD];
      case FieldType.NATIONALITY:
        return [FieldType.HOMETOWN];
      case FieldType.PHONE_COUNTRY_CODE:
        return [FieldType.PHONE];
      default:
        return [];
    }
  }

  private snapshotDependentElements(
    liveFields: DetectedField[],
    fieldType: FieldType,
    rowIndex?: number,
  ): Map<FieldType, Set<Element>> {
    return new Map(this.getDependentFieldTypes(fieldType).map(dependentType => [
      dependentType,
      new Set(liveFields.filter(candidate => (
        candidate.fieldType === dependentType
        && candidate.rowIndex === rowIndex
        && candidate.element.isConnected !== false
      )).map(candidate => candidate.element)),
    ]));
  }

  private haveDependentElementsRefreshed(
    liveFields: DetectedField[],
    fieldType: FieldType,
    rowIndex?: number,
    before: Map<FieldType, Set<Element>> = new Map(),
  ): boolean {
    const dependentTypes = this.getDependentFieldTypes(fieldType);
    if (dependentTypes.length === 0) return true;

    return dependentTypes.every(dependentType => {
      const previous = before.get(dependentType) || new Set<Element>();
      const current = liveFields.filter(candidate => (
        candidate.fieldType === dependentType
        && candidate.rowIndex === rowIndex
        && candidate.element.isConnected !== false
      )).map(candidate => candidate.element);
      if (previous.size === 0) return current.length > 0;
      return current.some(element => !previous.has(element))
        || Array.from(previous).every(element => element.isConnected === false);
    });
  }

  private isRequiredField(element: WritableFormControl): boolean {
    const container = getFieldContainer(element);
    return element.required
      || element.getAttribute('aria-required') === 'true'
      || Boolean(container?.matches('.is-required, [aria-required="true"], [class*=required]'));
  }

  private recordFillIssue(type: keyof FillDiagnostics, field: DetectedField): void {
    const issue = {
      fieldType: field.fieldType as FieldType,
      ...(field.rowIndex !== undefined ? { rowIndex: field.rowIndex } : {}),
      ...(type === 'rejectedFields' && this.lastSelectionFailure
        ? { reason: this.lastSelectionFailure } : {}),
    };
    const key = `${issue.fieldType}:${issue.rowIndex ?? 'none'}`;
    if (this.lastFillDiagnostics[type].some(existing => (
      `${existing.fieldType}:${existing.rowIndex ?? 'none'}` === key
    ))) return;
    this.lastFillDiagnostics[type].push(issue);
  }

  private async fillDateRangeFields(
    fields: DetectedField[],
    profile: UserProfile,
  ): Promise<{ filledCount: number; handledElements: Set<Element> }> {
    const rangeFields = fields.filter(field => this.isDateRangeField(field.fieldType as FieldType));
    const groups = new Map<HTMLElement, DetectedField[]>();
    const handledElements = new Set<Element>();
    let filledCount = 0;

    for (const field of rangeFields) {
      const container = getFieldContainer(field.element);
      if (!container || !/起止时间|学习时间|工作时间/.test(container.textContent || '')) continue;

      groups.set(container, [...(groups.get(container) || []), field]);
      handledElements.add(field.element);
    }

    const sectionIndexes: Partial<Record<FillSection, number>> = {};
    const orderedGroups = Array.from(groups.entries()).sort(([a], [b]) => {
      const position = a.compareDocumentPosition(b);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    for (const [container, groupFields] of orderedGroups) {
      const section = this.getSectionForElement(container);
      if (section !== 'education' && section !== 'experience' && section !== 'projects') continue;

      const explicitIndex = groupFields.find(field => field.rowIndex !== undefined)?.rowIndex;
      const index = explicitIndex ?? sectionIndexes[section] ?? 0;
      if (explicitIndex === undefined) sectionIndexes[section] = index + 1;

      const source = section === 'education'
        ? profile.education[index]
        : section === 'experience'
          ? profile.experience[index]
          : profile.projects[index];
      if (!source) continue;

      const dates = this.getOrderedDateRange(source.startDate, source.endDate);
      const inputs = groupFields
        .map(field => field.element)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

      const startInput = inputs[0];
      const endInput = inputs[1];

      // 字节日期范围组件会校验“开始时间不能晚于结束时间”。
      // 先写右侧较晚时间，再写左侧较早时间，避免旧值触发校验回滚。
      if (endInput && dates.end) {
        if (await this.fillField(endInput, dates.end)) filledCount++;
      }
      if (startInput && dates.start) {
        if (await this.fillField(startInput, dates.start)) filledCount++;
      }
    }

    return { filledCount, handledElements };
  }

  private isDateRangeField(fieldType: FieldType): boolean {
    return [
      FieldType.EDUCATION_START_DATE,
      FieldType.GRADUATION_DATE,
      FieldType.START_DATE,
      FieldType.END_DATE,
      FieldType.PROJECT_START_DATE,
      FieldType.PROJECT_END_DATE,
    ].includes(fieldType);
  }

  private getSectionForElement(element: Element): FillSection | null {
    let current: Element | null = element;

    while (current && current !== document.body) {
      const className = current.getAttribute('class') || '';
      if (/(?:resume-block|multiple_form)-(?:edu|education)(?:-|\s|$)/i.test(className)) return 'education';
      if (/(?:resume-block|multiple_form)-(?:internship|experience)(?:-|\s|$)/i.test(className)) return 'experience';
      if (/(?:resume-block|multiple_form)-project(?:-|\s|$)/i.test(className)) return 'projects';
      if (/resume[_-]person[_-]info/i.test(className)) return 'personal';
      const text = (current.textContent || '').replace(/\s+/g, ' ');
      if (/教育经历|学历类型|学校名称|学院|导师/.test(text)) return 'education';
      if (/实习经历|没有实习经历|公司名称|职位名称/.test(text)) return 'experience';
      if (/项目经历|项目名称|项目角色/.test(text)) return 'projects';
      if (/基本信息|手机号码|个人证件/.test(text)) return 'personal';
      current = current.parentElement;
    }

    return null;
  }

  private async ensureEducationRows(targetCount: number): Promise<void> {
    if (targetCount <= 1) return;

    await this.ensureRows({
      moduleKeyword: '教育经历',
      rowFieldName: 'school',
      targetCount,
    });
  }

  private async ensureExperienceRows(targetCount: number): Promise<void> {
    if (targetCount === 0) return;

    const internshipModule = this.findModule('实习经历');
    const noExperienceCheckbox = internshipModule
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const moduleText = (internshipModule?.textContent || '').replace(/\s+/g, ' ');

    if (noExperienceCheckbox?.checked || moduleText.includes('没有实习经历')) {
      noExperienceCheckbox?.click();
      await this.wait(120);
    }

    await this.ensureRows({
      moduleKeyword: '实习经历',
      rowFieldName: 'company',
      targetCount,
    });
  }

  private async ensureLanguageRows(targetCount: number): Promise<void> {
    if (targetCount === 0) return;

    await this.ensureRows({
      moduleKeyword: '语言能力',
      rowFieldName: 'language',
      targetCount,
    });
  }

  private async ensureProjectRows(targetCount: number): Promise<void> {
    if (targetCount === 0) return;

    await this.ensureRows({
      moduleKeyword: '项目经历',
      rowFieldName: 'projectName',
      targetCount,
    });
  }

  private async ensureRows(options: {
    moduleKeyword: string;
    rowFieldName: string;
    targetCount: number;
  }): Promise<void> {
    for (let attempts = 0; attempts < options.targetCount + 3; attempts++) {
      const currentCount = this.countFieldsInModule(options.moduleKeyword, options.rowFieldName);
      if (currentCount >= options.targetCount) return;

      const addButton = this.findAddButton(options.moduleKeyword);
      if (!addButton) return;

      addButton.click();
      await this.waitForRowCount(options.moduleKeyword, options.rowFieldName, currentCount + 1);
    }
  }

  private async waitForRowCount(
    moduleKeyword: string,
    fieldName: string,
    expectedCount: number,
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 700) {
      if (this.countFieldsInModule(moduleKeyword, fieldName) >= expectedCount) return;
      await this.wait(35);
    }
  }

  private findModule(keyword: string): HTMLElement | null {
    const modules = Array.from(
      document.querySelectorAll<HTMLElement>([
        '[class*=applyFormModuleWrapper]',
        '.ihr_recruit_resume-block-edu',
        '.ihr_recruit_resume-block-internship',
        '.ihr_recruit_resume-block-project',
        '.ihr_recruit_resume-block-language',
      ].join(', '))
    );

    return modules
      .filter(module => (module.textContent || '').includes(keyword))
      .sort((a, b) => b.querySelectorAll('input, textarea, select, button').length - a.querySelectorAll('input, textarea, select, button').length)[0] || null;
  }

  private countFieldsInModule(moduleKeyword: string, fieldName: string): number {
    const module = this.findModule(moduleKeyword);
    if (!module) return 0;

    const repeatedRows = new Set(Array.from(module.querySelectorAll<HTMLElement>(
      '[class*=multiple_form-edu-], [class*=multiple_form-internship-], ' +
      '[class*=multiple_form-project-], [class*=multiple_form-language-]'
    )));
    if (repeatedRows.size > 0) return repeatedRows.size;

    return Array.from(module.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      FORM_CONTROL_SELECTOR
    )).filter(element => {
      const container = element.closest<HTMLElement>(
        '[data-form-field-id], [data-form-field-name], [data-form-field-i18n-name]'
      );
      return (
        element.getAttribute('data-form-field-name') === fieldName ||
        element.getAttribute('data-form-field-id') === fieldName ||
        container?.getAttribute('data-form-field-name') === fieldName ||
        container?.getAttribute('data-form-field-id') === fieldName
      );
    }).length;
  }

  private findAddButton(moduleKeyword: string): HTMLButtonElement | null {
    const module = this.findModule(moduleKeyword);
    if (!module) return null;

    return Array.from(module.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => (button.textContent || '').trim() === '添加' && !button.disabled) || null;
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getNextEducationIndex(
    fieldType: FieldType,
    educationIndexes: Partial<Record<FieldType, number>>,
    explicitIndex?: number,
  ): number | undefined {
    if (!EDUCATION_FIELD_TYPES.has(fieldType)) return undefined;
    if (explicitIndex !== undefined) return explicitIndex;

    const index = educationIndexes[fieldType] ?? 0;
    educationIndexes[fieldType] = index + 1;
    return index;
  }

  private getNextExperienceIndex(
    fieldType: FieldType,
    experienceIndexes: Partial<Record<FieldType, number>>,
    explicitIndex?: number,
  ): number | undefined {
    if (!EXPERIENCE_FIELD_TYPES.has(fieldType)) return undefined;
    if (explicitIndex !== undefined) return explicitIndex;

    const index = experienceIndexes[fieldType] ?? 0;
    experienceIndexes[fieldType] = index + 1;
    return index;
  }

  private getNextLanguageIndex(
    fieldType: FieldType,
    languageIndexes: Partial<Record<FieldType, number>>,
    explicitIndex?: number,
  ): number | undefined {
    if (!LANGUAGE_FIELD_TYPES.has(fieldType)) return undefined;
    if (explicitIndex !== undefined) return explicitIndex;

    const index = languageIndexes[fieldType] ?? 0;
    languageIndexes[fieldType] = index + 1;
    return index;
  }

  private getNextProjectIndex(
    fieldType: FieldType,
    projectIndexes: Partial<Record<FieldType, number>>,
    explicitIndex?: number,
  ): number | undefined {
    if (!PROJECT_FIELD_TYPES.has(fieldType)) return undefined;
    if (explicitIndex !== undefined) return explicitIndex;

    const index = projectIndexes[fieldType] ?? 0;
    projectIndexes[fieldType] = index + 1;
    return index;
  }

  private getAwardIndex(
    row: Element | null,
    fieldType: FieldType,
    rowIndexes: Map<Element, number>,
    fallbackIndex: number
  ): number {
    if (row) {
      const existing = rowIndexes.get(row);
      if (existing !== undefined) return existing;

      const index = rowIndexes.size;
      rowIndexes.set(row, index);
      return index;
    }

    return fieldType === FieldType.AWARD_NAME ? fallbackIndex + 1 : Math.max(fallbackIndex, 0);
  }

  private getAwardRowContainer(
    element: Element,
    awardElements: Element[]
  ): Element | null {
    const module = element.closest<HTMLElement>(
      '[data-form-module], [data-section], [data-module], [class*=applyFormModuleWrapper]'
    );
    if (!module || !this.isAwardModule(module)) return null;

    const markedRow = element.closest('[data-award-row], [data-repeat-item], [role="listitem"], fieldset');
    if (markedRow && module.contains(markedRow)) return markedRow;

    let current: Element | null = element.parentElement;
    while (current && current !== module) {
      const containedFields = awardElements.filter(candidate => current?.contains(candidate));
      if (containedFields.length >= 2) {
        const fieldBearingChildren = Array.from(current.children)
          .filter(child => containedFields.some(candidate => child.contains(candidate)));
        if (fieldBearingChildren.length >= 2
          && !fieldBearingChildren.every(child => this.isAwardFieldWrapper(child))) {
          return fieldBearingChildren.find(child => child.contains(element)) || null;
        }
        return current;
      }
      current = current.parentElement;
    }

    const moduleRows = Array.from(module.children)
      .filter(child => awardElements.some(candidate => child.contains(candidate)));
    return moduleRows.length >= 2
      ? moduleRows.find(child => child.contains(element)) || null
      : null;
  }

  private isAwardFieldWrapper(element: Element): boolean {
    const hasStableFieldAttribute = [
      'data-index',
      'data-form-field-id',
      'data-form-field-name',
      'data-form-field-i18n-name',
    ].some(attribute => element.hasAttribute(attribute));
    if (hasStableFieldAttribute) return true;

    const className = element.getAttribute('class') || '';
    const hasFieldContainerClass = /(?:^|\s)(?:form[-_]?group|form[-_]?item|field(?:-wrapper)?)(?:\s|$)/i
      .test(className);
    const hasDirectLabel = Boolean(element.querySelector(
      ':scope > label, :scope > [class*=label], :scope > [aria-label]'
    ));
    const controlCount = element.querySelectorAll(
      'input:not([type="hidden"]), textarea, select, [role="combobox"]'
    ).length;

    return controlCount === 1 && (hasFieldContainerClass || hasDirectLabel);
  }

  private isAwardModule(module: HTMLElement): boolean {
    const identifiers = [
      module.getAttribute('data-form-module'),
      module.getAttribute('data-section'),
      module.getAttribute('data-module'),
      module.getAttribute('aria-label'),
      module.querySelector('legend, [role="heading"], h1, h2, h3, h4, h5, h6')?.textContent,
    ].filter(Boolean).join(' ');

    return /奖项|荣誉|获奖|awards?|honou?rs?/i.test(identifiers);
  }

  resolveFieldValue(fieldType: FieldType, profile: UserProfile, awardIndex = 0): string | null {
    return this.getValueForField(fieldType, profile, 0, 0, awardIndex);
  }

  // 根据字段类型获取对应的值
  private getValueForField(
    fieldType: FieldType,
    profile: UserProfile,
    educationIndex = 0,
    experienceIndex = 0,
    awardIndex = 0,
    languageIndex = 0,
    projectIndex = 0,
  ): string | null {
    const education = profile.education[educationIndex];
    const experience = profile.experience[experienceIndex];
    const award = profile.awards[awardIndex];
    const language = profile.languages?.[languageIndex];
    const project = profile.projects[projectIndex];
    const educationDates = this.getOrderedDateRange(education?.startDate, education?.endDate);
    const experienceDates = this.getOrderedDateRange(experience?.startDate, experience?.endDate);

    switch (fieldType) {
      case FieldType.NAME:
        return profile.personal.name || null;

      case FieldType.GENDER:
        return this.normalizeGender(profile.personal.gender);

      case FieldType.BIRTH_DATE:
        return profile.personal.birthDate || null;

      case FieldType.PHONE_COUNTRY_CODE:
        return this.getPhoneCountryCode(profile.personal.phoneCountryCode, profile.personal.phone);

      case FieldType.PHONE:
        return this.getLocalPhoneNumber(profile.personal.phone);

      case FieldType.EMAIL:
        return profile.personal.email || null;

      case FieldType.WECHAT:
        return profile.personal.wechat || null;

      case FieldType.ID_TYPE:
        return profile.personal.idType
          || (profile.personal.idCard || /中国|大陆/.test(resolvePersonalNationality(profile.personal))
            ? '身份证'
            : null);

      case FieldType.ID_CARD:
        return this.normalizeIdentityNumber(
          profile.personal.idCard || '',
          profile.personal.idType || '',
        );

      case FieldType.NATIONALITY:
        return resolvePersonalNationality(profile.personal) || null;

      case FieldType.POLITICAL_STATUS:
        return profile.personal.politicalStatus || null;

      case FieldType.ETHNICITY:
        return profile.personal.ethnicity || null;

      case FieldType.HOMETOWN:
        return profile.personal.hometown || null;

      case FieldType.CURRENT_ADDRESS:
        return profile.personal.currentAddress || null;

      case FieldType.SELF_EVALUATION:
        return profile.personal.selfEvaluation || null;

      case FieldType.SCHOOL:
        return education?.school || null;

      case FieldType.EDUCATION_COUNTRY:
        return resolveEducationCountryRegion(education) || null;

      case FieldType.SCHOOL_LOCATION:
        return education?.schoolLocation || null;

      case FieldType.COLLEGE:
        return education?.college || this.inferCollege(education?.school, education?.major) || null;

      case FieldType.EDUCATION_TYPE:
        return education?.educationType || '统招全日制';

      case FieldType.MAJOR:
        return education?.major || null;

      case FieldType.DEGREE:
        return this.normalizeDegree(education?.degree);

      case FieldType.GPA:
        return education?.gpa || null;

      case FieldType.LANGUAGE:
        return language?.language || null;

      case FieldType.LANGUAGE_CERTIFICATE:
        return language?.certificate || null;

      case FieldType.LANGUAGE_LEVEL:
        return language?.level || null;

      case FieldType.EDUCATION_START_DATE:
        return educationDates.start || null;

      case FieldType.GRADUATION_DATE:
        return educationDates.end || null;

      case FieldType.COMPANY:
        return experience?.company || null;

      case FieldType.POSITION:
        return experience?.position || null;

      case FieldType.START_DATE:
        return experienceDates.start || null;

      case FieldType.END_DATE:
        return experienceDates.end || null;

      case FieldType.DESCRIPTION:
        return experience?.description ? normalizeDescriptionText(experience.description) : null;

      case FieldType.PROJECT_NAME:
        return project?.name || null;

      case FieldType.PROJECT_ROLE:
        return project?.role || null;

      case FieldType.PROJECT_START_DATE:
        return this.getOrderedDateRange(project?.startDate, project?.endDate).start || null;

      case FieldType.PROJECT_END_DATE:
        return this.getOrderedDateRange(project?.startDate, project?.endDate).end || null;

      case FieldType.PROJECT_DESCRIPTION:
        return project?.description ? normalizeDescriptionText(project.description) : null;

      case FieldType.AWARD_NAME:
        return award?.name || null;

      case FieldType.AWARD_ROLE:
        return award?.role || null;

      case FieldType.AWARD_DATE:
        return award?.date || null;

      case FieldType.AWARD_DESCRIPTION:
        return award?.description ? normalizeDescriptionText(award.description) : null;

      case FieldType.SKILLS:
        return profile.skills.join(', ') || null;

      default:
        return null;
    }
  }

  private getOrderedDateRange(
    startDate?: string,
    endDate?: string
  ): { start: string; end: string } {
    if (!startDate || !endDate) {
      return { start: startDate || '', end: endDate || '' };
    }

    const startKey = this.toComparableDate(startDate);
    const endKey = this.toComparableDate(endDate);

    if (startKey && endKey && startKey > endKey) {
      return { start: endDate, end: startDate };
    }

    return { start: startDate, end: endDate };
  }

  private toComparableDate(value: string): string {
    const match = value.match(/(\d{4})\D{0,3}(\d{1,2})?/);
    if (!match) return '';

    const year = match[1];
    const month = (match[2] || '01').padStart(2, '0');
    return `${year}-${month}`;
  }

  private inferCollege(school?: string, major?: string): string {
    if (school === '北京大学' && major === '计算机科学与技术') {
      return '信息科学技术学院';
    }
    if (school === '浙江大学' && major === '软件工程') {
      return '软件学院';
    }
    if (school === '北京市第四中学') {
      return '理科实验班';
    }
    return '';
  }

  private getPhoneCountryCode(countryCode?: string, phone?: string): string | null {
    const explicit = countryCode?.trim();
    if (explicit) return explicit.startsWith('+') ? explicit : `+${explicit}`;
    if (!phone?.trim()) return null;

    const international = phone?.replace(/[\s()-]/g, '').match(/^(?:\+|00)(\d{1,4})(?=1[3-9]\d{9}$)/);
    return international ? `+${international[1]}` : '+86';
  }

  private getLocalPhoneNumber(phone?: string): string | null {
    if (!phone) return null;
    const normalized = phone.replace(/[\s()-]/g, '');
    return normalized.replace(/^(?:\+86|0086)(?=1[3-9]\d{9}$)/, '') || null;
  }

  // 标准化性别值
  private normalizeGender(gender: string): string | null {
    if (!gender) return null;

    const genderLower = gender.toLowerCase();

    // 检查男性
    if (GENDER_OPTIONS.male.some((opt) => opt.toLowerCase() === genderLower)) {
      return '男';
    }

    // 检查女性
    if (GENDER_OPTIONS.female.some((opt) => opt.toLowerCase() === genderLower)) {
      return '女';
    }

    return gender;
  }

  private normalizeIdentityNumber(value: string, idType: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const compact = trimmed.replace(/\s+/g, '');
    const looksLikeChineseIdentityNumber = /^(?:\d{15}|\d{17}[\dXx])$/.test(compact);
    return /身份证/.test(idType) || looksLikeChineseIdentityNumber
      ? compact.toUpperCase()
      : trimmed;
  }

  // 标准化学历值
  private normalizeDegree(degree?: string): string | null {
    if (!degree) return null;

    const degreeLower = degree.toLowerCase();

    for (const values of Object.values(DEGREE_OPTIONS)) {
      if (values.some((v) => v.toLowerCase() === degreeLower)) {
        return values[0]; // 返回标准化的中文值
      }
    }

    return degree;
  }

  // 填充单个字段
  private async fillField(
    element: WritableFormControl,
    value: string
  ): Promise<boolean> {
    if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
      return this.fillChoiceField(element, value);
    }
    if (isCustomSelectControl(element)) {
      return this.fillCustomSelectField(element as HTMLInputElement, value);
    }

    // 根据元素类型进行不同的填充
    if (element.tagName === 'SELECT') {
      const select = element as HTMLSelectElement;
      if (!this.fillSelectField(select, value)) return false;
      const selectedText = select.options[select.selectedIndex]?.text || '';
      return this.valuesMatch(select.value, value) || this.valuesMatch(selectedText, value);
    } else {
      const input = element as HTMLInputElement | HTMLTextAreaElement;
      const constrainedValue = this.constrainTextValue(input, value);
      this.fillInputField(input, constrainedValue);
      return this.valuesMatch(getControlValue(element), constrainedValue);
    }
  }

  private fillChoiceField(element: HTMLInputElement, value: string): boolean {
    const group = this.getChoiceGroup(element);
    const controls = group
      ? Array.from(group.querySelectorAll<HTMLInputElement>(`input[type="${element.type}"]`))
      : [element];
    const target = controls.find(control => this.valuesMatch(
      this.getChoiceLabel(control) || control.value,
      value,
    ));
    if (!target) return false;

    if (!target.checked) {
      const clickTarget = target.closest<HTMLElement>(
        'label, [role="radio"], [role="checkbox"]',
      ) || target;
      clickTarget.click();
    }
    if (!target.checked) {
      const checkedSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'checked',
      )?.set;
      if (checkedSetter) checkedSetter.call(target, true);
      else target.checked = true;
      this.triggerEvents(target);
    }
    return target.checked
      || target.closest<HTMLElement>('[role="radio"], [role="checkbox"]')
        ?.getAttribute('aria-checked') === 'true';
  }

  private getChoiceGroup(element: WritableFormControl): Element | null {
    if (typeof HTMLInputElement === 'undefined'
      || !(element instanceof HTMLInputElement)
      || !['checkbox', 'radio'].includes(element.type)) return null;
    return element.closest(
      '[role="radiogroup"], [role="group"], .md-radio-group, .md-checkbox-group, '
      + '.ant-radio-group, .ant-checkbox-group, .el-radio-group, .el-checkbox-group',
    ) || getFieldContainer(element);
  }

  private getChoiceLabel(element: HTMLInputElement): string {
    if (element.id) {
      const linked = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (linked?.textContent?.trim()) return linked.textContent.trim();
    }
    return element.getAttribute('aria-label')?.trim()
      || element.closest<HTMLElement>('label, [role="radio"], [role="checkbox"]')
        ?.textContent?.trim()
      || '';
  }

  private async fillCustomSelectField(element: HTMLInputElement, value: string): Promise<boolean> {
    const selector = getCustomSelectRoot(element);
    if (!selector) return false;
    const originalValue = element.value;
    const regionPath = this.getCascadingRegionPath(element, value);
    if (regionPath.length > 1) {
      if (this.acceptCascadingRegionSelection(element, regionPath, false)) return true;
    } else if (this.acceptCustomSelection(element, value, false)) {
      return true;
    }

    // 页面可能全局开启平滑滚动；弹层在锚点离开视口时会被关闭。先瞬时
    // 定位，给 IntersectionObserver 一帧更新，再聚焦，避免搜索期间继续滚动。
    selector.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    await this.wait(35);
    element.focus({ preventScroll: true });
    element.click();
    await this.wait(35);
    if (!this.hasVisibleCustomDropdown(element)) {
      selector.click();
      await this.wait(35);
    }

    if (regionPath.length > 1) {
      return this.fillCascadingRegionField(element, value, regionPath, originalValue);
    }

    // 固定下拉先在真实选项中做语义匹配，避免把“统招全日制”写入搜索框后
    // 反而过滤掉网站的“全日制”。远程学校/专业下拉没有现成选项时才搜索。
    const searchable = isSearchableCustomSelectControl(element);
    let target = await this.waitForCustomOption(value, searchable ? 80 : 600, undefined, element);
    if (!target && searchable) {
      this.setSearchValue(element, value);
      // 远程学校/专业检索通常带服务端防抖和网络往返。现场 ATS 实测结果
      // 会在约 1.2 秒后出现，过早结束会把正常结果误判为“不存在”。
      target = await this.waitForCustomOption(value, 2500, undefined, element);
    }

    if (!target) {
      this.lastSelectionFailure = this.hasVisibleCustomDropdown(element)
        ? 'option-not-found' : 'dropdown-not-open';
      if (element.value !== originalValue) this.setSearchValue(element, originalValue);
      this.closeCustomDropdown(element);
      return false;
    }

    let selectedTarget: HTMLElement | null = target;
    for (let depth = 0; selectedTarget && depth < 5; depth += 1) {
      const clickable = this.getClickableOptionTarget(selectedTarget);
      clickable.click();

      if (await this.waitForCustomSelection(element, value, 400)) return true;

      // 籍贯/地区级联控件会在每一级选择后继续保留弹层，逐级点击直到网页确认最终值。
      const nextTarget = await this.waitForCustomOption(
        value,
        CASCADE_OPTION_TIMEOUT_MS,
        selectedTarget,
        element,
      );
      if (!nextTarget || nextTarget.textContent?.trim() === selectedTarget.textContent?.trim()) break;
      selectedTarget = nextTarget;
    }

    const accepted = this.acceptCustomSelection(element, value);
    if (!accepted) this.lastSelectionFailure = 'selection-not-confirmed';
    return accepted;
  }

  private getCascadingRegionPath(element: HTMLInputElement, value: string): string[] {
    const root = getCustomSelectRoot(element);
    const container = getFieldContainer(element);
    const descriptor = [
      root?.className,
      root?.getAttribute('data-component'),
      element.name,
      element.id,
      element.getAttribute('aria-label'),
      container?.textContent,
    ].filter(Boolean).join(' ');
    if (!/cascad|area.?picker|region.?picker|tree.?picker|籍贯|户籍|原籍|省市|现居|居住|学校.*(?:所在地|地址)|院校.*(?:所在地|地址)|校址|school.*(?:location|address)/i.test(descriptor)) {
      return [];
    }
    return parseRegionPath(value);
  }

  private isRegionFieldType(fieldType: FieldType): boolean {
    return [
      FieldType.HOMETOWN,
      FieldType.CURRENT_ADDRESS,
      FieldType.SCHOOL_LOCATION,
    ].includes(fieldType);
  }

  private async fillCascadingRegionField(
    element: HTMLInputElement,
    value: string,
    path: string[],
    originalValue: string,
  ): Promise<boolean> {
    let parentTarget: HTMLElement | undefined;
    for (let index = 0; index < path.length; index += 1) {
      if (index < path.length - 1 && this.findVisibleCustomOption(
        path[index + 1],
        undefined,
        element,
      )) {
        // 上一次尝试可能已展开当前层，只是下一级网络数据来得太晚。
        // 若下一段已经可见，直接继续，避免再次点击父节点把树折叠回去。
        continue;
      }
      const target = await this.waitForCascadingRegionOption(
        path[index],
        index === 0 ? 600 : CASCADE_OPTION_TIMEOUT_MS,
        parentTarget,
        element,
      );
      if (!target) {
        if (index > 0 && this.acceptCascadingRegionSelection(
          element,
          path.slice(0, index),
        )) return true;
        this.lastSelectionFailure = this.hasVisibleCustomDropdown(element)
          ? 'option-not-found' : 'dropdown-not-open';
        if (element.value !== originalValue) this.setSearchValue(element, originalValue);
        this.closeCustomDropdown(element);
        return false;
      }

      this.getClickableOptionTarget(target).click();
      parentTarget = target;
      if (index < path.length - 1) {
        // 下一级候选经常需要异步请求后才会渲染。
        await this.wait(35);
        continue;
      }

      if (await this.waitForCascadingRegionSelection(element, path, 500)) return true;
      if (this.isExpandableRegionOption(target)) {
        this.lastSelectionFailure = 'region-leaf-required';
      }
    }

    const accepted = this.acceptCascadingRegionSelection(element, path);
    if (!accepted && !this.lastSelectionFailure) {
      this.lastSelectionFailure = 'selection-not-confirmed';
    }
    return accepted;
  }

  private async waitForCascadingRegionOption(
    value: string,
    timeoutMs: number,
    parentTarget: HTMLElement | undefined,
    trigger: HTMLInputElement,
  ): Promise<HTMLElement | null> {
    const startedAt = Date.now();
    const expandedBridges = new Set<HTMLElement>();

    while (Date.now() - startedAt < timeoutMs) {
      const target = this.findVisibleRegionOption(value, parentTarget, trigger);
      if (target) return target;

      const bridge = this.findRegionStructuralBridge(parentTarget, trigger, expandedBridges);
      if (bridge) {
        expandedBridges.add(bridge);
        this.getClickableOptionTarget(bridge).click();
        await this.wait(35);
        continue;
      }

      await this.wait(40);
    }
    return null;
  }

  private findVisibleRegionOption(
    value: string,
    parentTarget: HTMLElement | undefined,
    trigger: HTMLInputElement,
  ): HTMLElement | null {
    const branchOptions = parentTarget ? this.getRegionBranchOptions(parentTarget) : [];
    if (branchOptions.length === 0) {
      return this.findVisibleCustomOption(value, undefined, trigger);
    }

    return branchOptions
      .map(candidate => ({
        candidate,
        score: scoreOptionMatch(this.getRegionOptionText(candidate), value),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)[0]?.candidate || null;
  }

  private findRegionStructuralBridge(
    parentTarget: HTMLElement | undefined,
    trigger: HTMLInputElement,
    expandedBridges: Set<HTMLElement>,
  ): HTMLElement | null {
    const branchOptions = parentTarget ? this.getRegionBranchOptions(parentTarget) : [];
    const candidates = branchOptions.length > 0
      ? branchOptions
      : this.getVisibleCustomDropdowns(trigger).flatMap(root => Array.from(
        root.querySelectorAll<HTMLElement>([
          '.ihr_tree-item',
          '.ihr_base_cascader-menu-item',
          '.ihr_cascader-menu-item',
          '.ant-cascader-menu-item',
          '.el-cascader-node',
          '.arco-cascader-list-item',
          '.md-cascader-node',
          '[role="treeitem"]',
        ].join(', ')),
      ));

    return candidates.find(candidate => (
      !expandedBridges.has(candidate)
      && isRegionStructuralNodeLabel(this.getRegionOptionText(candidate))
      && this.isExpandableRegionOption(candidate)
      && !this.isExpandedRegionOption(candidate)
      && this.isVisibleElement(candidate)
    )) || null;
  }

  private getRegionBranchOptions(parentTarget: HTMLElement): HTMLElement[] {
    const parent = parentTarget.matches('.ihr_tree-item')
      ? parentTarget
      : parentTarget.closest<HTMLElement>('.ihr_tree-item');
    if (!parent) return [];

    const parentLevel = Number.parseInt(
      parent.style.getPropertyValue('--ihr-tree-item-level'),
      10,
    );
    if (!Number.isFinite(parentLevel)) return [];

    const descendants: HTMLElement[] = [];
    let current = parent.nextElementSibling;
    while (current instanceof HTMLElement && current.matches('.ihr_tree-item')) {
      const level = Number.parseInt(
        current.style.getPropertyValue('--ihr-tree-item-level'),
        10,
      );
      if (!Number.isFinite(level) || level <= parentLevel) break;
      if (this.isVisibleElement(current)) descendants.push(current);
      current = current.nextElementSibling;
    }
    return descendants;
  }

  private getRegionOptionText(candidate: HTMLElement): string {
    const label = candidate.matches('.ihr_tree-item')
      ? candidate.querySelector<HTMLElement>(':scope > .ihr_tree-item_info')
      : null;
    return (label?.textContent || candidate.textContent || '').replace(/\s+/g, ' ').trim();
  }

  private isExpandableRegionOption(candidate: HTMLElement): boolean {
    const treeItem = candidate.matches('.ihr_tree-item')
      ? candidate
      : candidate.closest<HTMLElement>('.ihr_tree-item');
    if (treeItem) {
      return Boolean(treeItem.querySelector(':scope > .ihr_tree-item_status--visible'));
    }
    return candidate.getAttribute('aria-haspopup') === 'true'
      || candidate.hasAttribute('aria-expanded')
      || Boolean(candidate.querySelector(
        '[class*=expand], [class*=arrow], [class*=suffix], [aria-label*=展开], [aria-label*=expand i]',
      ));
  }

  private isExpandedRegionOption(candidate: HTMLElement): boolean {
    const className = candidate.getAttribute('class') || '';
    return /(?:^|\s)ihr_tree-item--expand(?:\s|$)/.test(className)
      || candidate.getAttribute('aria-expanded') === 'true';
  }

  private async waitForCascadingRegionSelection(
    element: HTMLInputElement,
    path: string[],
    timeoutMs: number,
  ): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.acceptCascadingRegionSelection(element, path)) return true;
      if (!element.isConnected) return false;
      await this.wait(25);
    }
    return false;
  }

  private acceptCascadingRegionSelection(
    element: HTMLInputElement,
    path: string[],
    allowClosedLeaf = true,
    closeDropdown = true,
  ): boolean {
    const accepted = this.isCascadingRegionSelectionAccepted(element, path, allowClosedLeaf);
    if (accepted && closeDropdown && this.hasVisibleCustomDropdown(element)) {
      this.closeCustomDropdown(element);
    }
    return accepted;
  }

  private isCascadingRegionSelectionAccepted(
    element: HTMLInputElement,
    path: string[],
    allowClosedLeaf = true,
  ): boolean {
    if (!element.isConnected || path.length === 0) return false;
    const dropdownVisible = this.hasVisibleCustomDropdown(element);
    const displayed = getControlValue(element);
    const committed = getCustomSelectSelectedText(element);
    const coversPath = this.regionValueCoversPath(displayed, path)
      || this.regionValueCoversPath(committed, path);
    const closedLeafMatches = allowClosedLeaf
      && !dropdownVisible
      && this.regionValueContainsSegment(displayed || committed, path[path.length - 1]);
    return coversPath || closedLeafMatches;
  }

  private regionValueCoversPath(actual: string, path: string[]): boolean {
    const normalize = (value: string) => value
      .replace(/\s+/g, '')
      .replace(/[（）()·,，./／_+\-—–:：>＞|｜]/g, '')
      .replace(REGION_ADMIN_SUFFIX, '');
    const actualValue = normalize(actual);
    const expectedSegments = path.map(segment => normalize(segment)).filter(Boolean);
    if (!actualValue || expectedSegments.length === 0) return false;

    let offset = 0;
    return expectedSegments.every(segment => {
      const position = actualValue.indexOf(segment, offset);
      if (position < 0) return false;
      offset = position + segment.length;
      return true;
    });
  }

  private regionValueContainsSegment(actual: string, expected: string): boolean {
    const normalize = (value: string) => value
      .replace(/\s+/g, '')
      .replace(/[（）()·,，./／_+\-—–:：>＞|｜]/g, '')
      .replace(REGION_ADMIN_SUFFIX, '');
    const actualValue = normalize(actual);
    const expectedValue = normalize(expected);
    return Boolean(actualValue && expectedValue && actualValue.includes(expectedValue));
  }

  private acceptCustomSelection(
    element: HTMLInputElement,
    value: string,
    allowClosedInputValue = true,
    closeDropdown = true,
  ): boolean {
    const accepted = this.isCustomSelectionAccepted(element, value, allowClosedInputValue);
    if (accepted && closeDropdown && this.hasVisibleCustomDropdown(element)) {
      this.closeCustomDropdown(element);
    }
    return accepted;
  }

  private isCustomSelectionAccepted(
    element: HTMLInputElement,
    value: string,
    allowClosedInputValue = true,
  ): boolean {
    if (!element.isConnected) return false;
    const dropdownVisible = this.hasVisibleCustomDropdown(element);
    const displayedValueMatches = this.valuesMatch(getControlValue(element), value);
    const committedValueMatches = this.valuesMatch(
      getCustomSelectSelectedText(element),
      value,
    );
    const accepted = displayedValueMatches
      && (!isSearchableCustomSelectControl(element)
        || committedValueMatches
        || (allowClosedInputValue && !dropdownVisible));
    return accepted;
  }

  private async waitForCustomSelection(
    element: HTMLInputElement,
    value: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.acceptCustomSelection(element, value)) return true;
      if (!element.isConnected) return false;
      await this.wait(25);
    }
    return false;
  }

  private getClickableOptionTarget(target: HTMLElement): HTMLElement {
    // iHR 固定字典的真实选中事件绑定在菜单项本身。线上 DOM 使用
    // `.ihr_picker_menu-item`，点击内部纯文字节点在部分页面不会提交值。
    if (target.matches('.ihr_picker_menu-item')) return target;

    // iHR 字典菜单的状态切换事件绑定在菜单项上，但点击内部标签会冒泡到
    // 菜单项；优先返回标签可以避免“外层一次 + 标签一次”触发两次切换。
    const preferred = target.querySelector<HTMLElement>(
      '.ihr_tree-item_info, .ihr_picker_menu-item_label, ' +
      '[class*=menu-item_label], [class*=option-label], [class*=item-label]'
    );
    if (preferred) return preferred;

    if (target.matches('.ihr_tree-item')) {
      return target.querySelector<HTMLElement>('.ihr_tree-item_info, button') || target;
    }
    return target;
  }

  private closeCustomDropdown(element: HTMLInputElement): void {
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
    document.body.click();
  }

  private setSearchValue(element: HTMLInputElement, value: string): void {
    const oldValue = element.value;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    if (setter) setter.call(element, value);
    else element.value = value;

    (element as HTMLInputElement & {
      _valueTracker?: { setValue: (trackedValue: string) => void };
    })._valueTracker?.setValue(oldValue);
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  }

  private findVisibleCustomOption(
    value: string,
    excluded?: HTMLElement,
    trigger?: HTMLInputElement,
  ): HTMLElement | null {
    const dropdowns = this.getVisibleCustomDropdowns(trigger);
    const localCandidates = dropdowns.flatMap(root => Array.from(
      root.querySelectorAll<HTMLElement>([
        '[role="option"]',
        '[role="treeitem"]',
        '[role="menuitem"]',
        '[aria-selected]',
        '.ud__select__list__item',
        '.ihr_picker_menu-item',
        '.ihr_selector_menu-item',
        '.ihr_dict_picker-menu-item',
        '.ihr_area_picker-menu-item',
        '.ihr_tree_picker-menu-item',
        '.ihr_input_selector-menu-item',
        '.ihr_tree-item',
        '.ihr_base_cascader-menu-item',
        '.ihr_cascader-menu-item',
        '.md-select-dropdown__option-item',
        '.md-select-dropdown__item',
        '.ant-select-item-option',
        '.arco-select-option',
        '.el-select-dropdown__item',
        '.ant-cascader-menu-item',
        '.el-cascader-node',
        '.arco-cascader-list-item',
        '.md-cascader-node',
        '.md-tree-node',
        '[class*=dropdown] li',
        '[class*=popup] li',
        '[class*=popover] li',
        '[class*=select] li',
        '[class*=picker] li',
        'li',
        'button',
        '[class*=option]',
        '[class*=item]',
        '[class*=node]',
        'span',
        'div',
      ].join(', ')),
    ));
    // 最后一层只查询“像选项”的全局节点。很多招聘系统把弹层挂在 body 下，
    // 类名又是构建后随机值，无法从输入框或组件类名反查到弹层。
    const globalCandidates = Array.from(document.querySelectorAll<HTMLElement>([
      '[role="option"]',
      '[role="treeitem"]',
      '[role="menuitem"]',
      '[aria-selected]',
      '[class*=option]',
      '[class*=dropdown] li',
      '[class*=popup] li',
      '[class*=popover] li',
      '[class*=select] li',
      '[class*=picker] li',
      'li',
    ].join(', ')));

    const candidates = Array.from(new Set([...localCandidates, ...globalCandidates])).map(candidate => {
      const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
      const isOptionNode = candidate.matches([
        '[role="option"]',
        '[role="treeitem"]',
        '[role="menuitem"]',
        '[aria-selected]',
        '.ud__select__list__item',
        '.ihr_picker_menu-item',
        '.ihr_selector_menu-item',
        '.ihr_dict_picker-menu-item',
        '.ihr_area_picker-menu-item',
        '.ihr_tree_picker-menu-item',
        '.ihr_input_selector-menu-item',
        '.ihr_tree-item',
        '.ihr_base_cascader-menu-item',
        '.ihr_cascader-menu-item',
        '.md-select-dropdown__option-item',
        '.md-select-dropdown__item',
        '.ant-select-item-option',
        '.arco-select-option',
        '.el-select-dropdown__item',
        '.ant-cascader-menu-item',
        '.el-cascader-node',
        '.arco-cascader-list-item',
        '.md-cascader-node',
        '.md-tree-node',
      ].join(', '));
      return {
        candidate,
        text,
        isOptionNode,
        score: text.length <= 160 ? scoreOptionMatch(text, value) : 0,
        distance: trigger ? this.distanceBetweenElements(candidate, trigger) : 0,
      };
    }).filter(({ candidate, isOptionNode, score }) => {
      if (
        candidate === excluded
        || Boolean(excluded?.contains(candidate))
        || Boolean(excluded && candidate.contains(excluded))
      ) return false;
      const insideControl = trigger && getCustomSelectRoot(trigger)?.contains(candidate);
      if (insideControl && !isOptionNode && !candidate.matches('li, [class*=option]')) return false;
      if (!this.isVisibleElement(candidate)) return false;
      if (score <= 0) return false;
      if (isOptionNode) return true;
      return !Array.from(candidate.children).some(child => (
        scoreOptionMatch((child.textContent || '').replace(/\s+/g, ' ').trim(), value) >= score
      ));
    });

    return candidates.sort((left, right) => (
      right.score - left.score
      || Number(right.isOptionNode) - Number(left.isOptionNode)
      || left.distance - right.distance
      || left.text.length - right.text.length
    ))[0]?.candidate || null;
  }

  private distanceBetweenElements(left: HTMLElement, right: HTMLElement): number {
    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    const horizontal = Math.max(0, rightRect.left - leftRect.right, leftRect.left - rightRect.right);
    const vertical = Math.max(0, rightRect.top - leftRect.bottom, leftRect.top - rightRect.bottom);
    return horizontal + vertical;
  }

  private getVisibleCustomDropdowns(trigger?: HTMLInputElement): HTMLElement[] {
    const controlledDropdowns = trigger
      ? this.getControlledDropdowns(trigger)
      : [];
    const discoveredDropdowns = Array.from(document.querySelectorAll<HTMLElement>([
      '.ud__select__dropdown',
      '.ihr_base_picker-panel',
      '.ihr_base_selector-panel',
      '.ihr_tree_picker-panel',
      '.ihr_input_selector-panel',
      '.ihr_area_picker-panel',
      '.ihr_base_cascader-panel',
      '.ihr_cascader-panel',
      '.md-select-dropdown',
      '.ant-select-dropdown',
      '.arco-select-popup',
      '.el-select-dropdown',
      '.ant-cascader-menus',
      '.el-cascader-panel',
      '.arco-cascader-panel',
      '[class*=cascader-menu]',
      '[class*=cascader-panel]',
      '[class*=cascader-dropdown]',
      '[class*=cascader-popup]',
      '[class*=cascade-menu]',
      '[class*=cascade-panel]',
      '[class*=cascade-dropdown]',
      '[class*=tree-select-dropdown]',
      '[class*=select][class*=dropdown]',
      '[class*=select][class*=popup]',
      '[class*=picker][class*=panel]',
      '[class*=dropdown-menu]',
      '[class*=popup-content]',
      '[class*=popover-content]',
      '[data-popper-placement]',
      '[role="listbox"]',
      '[role="tree"]',
      '[role="menu"]',
    ].join(', ')));

    return Array.from(new Set([...controlledDropdowns, ...discoveredDropdowns]))
      .filter(candidate => this.isVisibleElement(candidate));
  }

  private getControlledDropdowns(trigger: HTMLInputElement): HTMLElement[] {
    const root = getCustomSelectRoot(trigger);
    const ids = [trigger, root]
      .filter((element): element is HTMLElement => Boolean(element))
      .flatMap(element => [
        element.getAttribute('aria-controls') || '',
        element.getAttribute('aria-owns') || '',
      ])
      .flatMap(value => value.split(/\s+/))
      .filter(Boolean);

    return ids.flatMap(id => {
      const controlled = document.getElementById(id);
      return controlled instanceof HTMLElement ? [controlled] : [];
    });
  }

  private isVisibleElement(element: HTMLElement): boolean {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && !element.hidden
      && (rect.width > 0 || rect.height > 0);
  }

  private hasVisibleCustomDropdown(trigger?: HTMLInputElement): boolean {
    return this.getVisibleCustomDropdowns(trigger).length > 0;
  }

  private async waitForCustomOption(
    value: string,
    timeoutMs: number,
    excluded?: HTMLElement,
    trigger?: HTMLInputElement,
  ): Promise<HTMLElement | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const option = this.findVisibleCustomOption(value, excluded, trigger);
      if (option) return option;
      await this.wait(40);
    }
    return null;
  }

  private valuesMatch(actual: string, expected: string): boolean {
    return areEquivalentOptionValues(actual, expected);
  }

  // 填充下拉框
  private fillSelectField(element: HTMLSelectElement, value: string): boolean {
    const options = Array.from(element.options);
    const index = options.reduce((bestIndex, option, currentIndex) => {
      const currentScore = Math.max(
        scoreOptionMatch(option.text, value),
        scoreOptionMatch(option.value, value),
      );
      if (currentScore <= 0) return bestIndex;
      if (bestIndex < 0) return currentIndex;

      const bestOption = options[bestIndex];
      const bestScore = Math.max(
        scoreOptionMatch(bestOption.text, value),
        scoreOptionMatch(bestOption.value, value),
      );
      return currentScore > bestScore ? currentIndex : bestIndex;
    }, -1);
    if (index < 0) return false;

    element.selectedIndex = index;
    this.triggerEvents(element);
    return true;
  }

  // 填充输入框
  private fillInputField(
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string
  ): void {
    const oldValue = element.value;
    element.focus();

    // 使用原生 setter 设置值（兼容 React）
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;

    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;

    if (element.tagName === 'INPUT' && nativeInputValueSetter) {
      nativeInputValueSetter.call(element, value);
    } else if (element.tagName === 'TEXTAREA' && nativeTextAreaValueSetter) {
      nativeTextAreaValueSetter.call(element, value);
    } else {
      element.value = value;
    }

    // React 受控输入会用 _valueTracker 判断值是否变化。
    // 先把 tracker 保持为旧值，再触发事件，React 才会接受新值。
    const trackedElement = element as HTMLInputElement & {
      _valueTracker?: { setValue: (value: string) => void };
      [key: string]: any;
    };
    trackedElement._valueTracker?.setValue(oldValue);

    // 触发所有相关事件
    this.triggerEvents(element);
  }

  private constrainTextValue(
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ): string {
    const hintText = element instanceof HTMLTextAreaElement
      ? getFieldContainer(element)?.textContent || ''
      : '';
    const limit = findTextLengthLimit(element.maxLength, hintText);
    const normalizedValue = element instanceof HTMLTextAreaElement
      && /工作描述|工作内容|实习描述|职责描述|主要职责|项目描述|项目介绍/.test(hintText)
      ? normalizeDescriptionText(value)
      : value;
    return truncateToTextLength(normalizedValue, limit);
  }

  // 触发表单事件（兼容 React/Vue/Angular）
  private triggerEvents(element: HTMLElement): void {
    const inputEvent = new Event('input', { bubbles: true, cancelable: true });
    element.dispatchEvent(inputEvent);
    this.triggerReactChange(element, inputEvent);

    const events = [
      new Event('change', { bubbles: true, cancelable: true }),
      new Event('blur', { bubbles: true, cancelable: true }),
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true }),
      new KeyboardEvent('keyup', { bubbles: true, cancelable: true })
    ];

    events.forEach((event) => {
      element.dispatchEvent(event);
    });
  }

  private triggerReactChange(element: HTMLElement, nativeEvent: Event): void {
    const reactKey = Object.keys(element).find(
      key => key.startsWith('__reactEventHandlers$') || key.startsWith('__reactProps$')
    );
    const handlers = reactKey ? (element as any)[reactKey] : null;

    if (typeof handlers?.onChange !== 'function') return;

    handlers.onChange({
      target: element,
      currentTarget: element,
      type: 'change',
      nativeEvent,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
      persist: () => {},
    });
  }

  // 上传简历文件
  async uploadResume(
    fileInput: HTMLInputElement,
    fileData: string,
    fileName: string
  ): Promise<void> {
    try {
      // 将 base64 转换为 Blob
      const blob = this.base64ToBlob(fileData);

      // 创建 File 对象
      const file = new File([blob], fileName, { type: blob.type });

      // 创建 DataTransfer 对象
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      // 设置文件
      fileInput.files = dataTransfer.files;

      // 触发 change 事件
      this.triggerEvents(fileInput);

      console.log(`Resume uploaded: ${fileName}`);
    } catch (error) {
      console.error('Failed to upload resume:', error);
      throw error;
    }
  }

  // 将 base64 转换为 Blob
  private base64ToBlob(base64Data: string): Blob {
    // 提取 MIME 类型和数据
    const parts = base64Data.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const base64String = parts[1] || parts[0];

    // 解码 base64
    const binaryString = atob(base64String);
    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return new Blob([bytes], { type: mime });
  }
}
