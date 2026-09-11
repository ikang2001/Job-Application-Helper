export type WritableFormControl =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLSelectElement;

export const FORM_CONTROL_SELECTOR = [
  'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
  'textarea',
  'select',
].join(', ');

export const FIELD_CONTAINER_SELECTOR = [
  '[data-form-field-id]',
  '[data-form-field-name]',
  '[data-form-field-i18n-name]',
  '.md-form-item',
  '.el-form-item',
  '.ant-form-item',
  '.arco-form-item',
  '.form-group',
  '[data-field]',
  '[class*=field-wrapper]',
  '[class*=formItem]',
  '[class*=applyFormItem]',
  '[class*=resume_person_info-]',
  '[class*=school_resume_person_info-]',
  '[class*=recruit_resume_person_info-]',
].join(', ');

export const CUSTOM_SELECT_ROOT_SELECTOR = [
  '.ud__select',
  '.md-select',
  '.md-cascader',
  '.md-tree-select',
  '.ihr_base_picker',
  '.ihr_base_selector',
  '.ihr_dict_picker',
  '.ihr_area_picker',
  '.ihr_tree_picker',
  '.ihr_input_selector',
  '.ihr_base_cascader',
  '.ihr_cascader',
  '.ant-select',
  '.arco-select',
  '.el-select',
  '.ng-select',
  '.MuiAutocomplete-root',
  '.MuiSelect-root',
  '.ant-cascader',
  '.el-cascader',
  '.arco-cascader',
  '[class*=cascader]',
  '[class*=Cascader]',
  '[class*=cascade]',
  '[class*=tree-select]',
  '[class*=treeSelect]',
  '[class*=area-picker]',
  '[class*=region-picker]',
  '[role="combobox"]',
].join(', ');

const DATE_PICKER_ROOT_SELECTOR = [
  '.md-date-editor',
  '.ant-picker',
  '.arco-picker',
  '.el-date-editor',
].join(', ');

const CUSTOM_SELECT_ARIA_SELECTOR = [
  '[role="combobox"]',
  '[aria-haspopup="listbox"]',
  '[aria-haspopup="tree"]',
  '[aria-haspopup="menu"]',
  '[aria-controls]',
  '[aria-owns]',
].join(', ');

const CUSTOM_SELECT_INDICATOR_SELECTOR = [
  '[class*=arrow]',
  '[class*=Arrow]',
  '[class*=caret]',
  '[class*=Caret]',
  '[class*=select-icon]',
  '[class*=picker-icon]',
  '[class*=icon_expand]',
  '[class*=icon_trigger]',
  '[data-icon*=down]',
  '[aria-label*=展开]',
  '[aria-label*=下拉]',
].join(', ');

const GENERIC_SELECT_INDICATOR_SELECTOR = '[class*=suffix], [class*=Suffix], svg';

const SEARCHABLE_SELECT_SELECTOR = [
  '[aria-autocomplete="list"]',
  '[aria-autocomplete="both"]',
  '.ant-select-show-search',
  '.el-select--filterable',
  '[class*=autocomplete]',
  '[class*=Autocomplete]',
  '[class*=searchable]',
  '[class*=filterable]',
].join(', ');

const EXPLICIT_SEARCHABLE_SELECT_SELECTOR = [
  '.ihr_input_selector',
  '.ihr_school_picker',
  '.ant-select-show-search',
  '.el-select--filterable',
  '[class*=autocomplete]',
  '[class*=Autocomplete]',
  '[class*=searchable]',
  '[class*=filterable]',
].join(', ');

export function getCustomSelectRoot(element: WritableFormControl): HTMLElement | null {
  if (!(element instanceof HTMLInputElement) || isDatePickerControl(element)) return null;

  const knownRoot = element.closest<HTMLElement>(CUSTOM_SELECT_ROOT_SELECTOR);
  if (knownRoot) return knownRoot;

  const ariaRoot = element.closest<HTMLElement>(CUSTOM_SELECT_ARIA_SELECTOR);
  if (ariaRoot) return ariaRoot;

  const hasSelectPrompt = isSelectPrompt(element.placeholder);
  let current = element.parentElement;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (hasSelectIndicator(current, hasSelectPrompt)) return current;
    if (current.matches(FIELD_CONTAINER_SELECTOR)) break;
    current = current.parentElement;
  }

  if (!hasSelectPrompt) return null;

  // “请选择”本身就是明确的枚举选择语义。即使网站没有组件类名或 ARIA，
  // 也必须走真实选项点击链路，不能把它当普通文本框直接写值。
  return element;
}

export function isCustomSelectControl(element: WritableFormControl): boolean {
  return getCustomSelectRoot(element) !== null;
}

export function isSearchableCustomSelectControl(element: WritableFormControl): boolean {
  if (!(element instanceof HTMLInputElement)) return false;
  const root = getCustomSelectRoot(element);
  if (!root) return false;

  // iHR 会给字典、地区和树形下拉统一加上 `--searchable`，但这只代表
  // 组件内部可检索，不代表可以把资料原文写进去。学习方式等字段必须先
  // 读取网站真实候选，否则“统招全日制”会把“全日制”过滤掉。
  if (root.matches('.ihr_dict_picker, .ihr_area_picker, .ihr_tree_picker')) return false;

  // 输入检索型组件即使占位符也是“请选择”，仍应先输入完整名称，再点击
  // 服务端返回的真实候选。普通固定下拉只声明 aria-autocomplete 时不放行。
  if (element.matches(EXPLICIT_SEARCHABLE_SELECT_SELECTOR)
    || root.matches(EXPLICIT_SEARCHABLE_SELECT_SELECTOR)
    || Boolean(root.querySelector(EXPLICIT_SEARCHABLE_SELECT_SELECTOR))) return true;
  if (isFixedSelectPrompt(element.placeholder)) return false;

  if (/请输入|搜索|检索|查找|input|search/i.test(element.placeholder)) return true;
  return element.matches(SEARCHABLE_SELECT_SELECTOR)
    || root.matches(SEARCHABLE_SELECT_SELECTOR)
    || Boolean(root.querySelector(SEARCHABLE_SELECT_SELECTOR));
}

export function isDatePickerControl(element: WritableFormControl): boolean {
  return element instanceof HTMLInputElement
    && Boolean(element.closest(DATE_PICKER_ROOT_SELECTOR));
}

export function isWritableFormControl(
  element: Element,
): element is WritableFormControl {
  if (
    !(element instanceof HTMLInputElement)
    && !(element instanceof HTMLTextAreaElement)
    && !(element instanceof HTMLSelectElement)
  ) {
    return false;
  }
  if (element.disabled) return false;

  const interactiveRoot = getCustomSelectRoot(element)
    || element.closest<HTMLElement>(DATE_PICKER_ROOT_SELECTOR);
  if (interactiveRoot && /--disabled|is-disabled/.test(interactiveRoot.className)) {
    return false;
  }

  if (element instanceof HTMLInputElement) {
    const unsupportedTypes = new Set([
      'hidden', 'file', 'button', 'submit', 'reset', 'image',
    ]);
    if (unsupportedTypes.has(element.type.toLowerCase())) return false;
    if (element.readOnly && !isCustomSelectControl(element) && !isDatePickerControl(element)) {
      return false;
    }
  }

  return !(element instanceof HTMLTextAreaElement && element.readOnly);
}

export function isVisibleFormControl(element: WritableFormControl): boolean {
  const root = getCustomSelectRoot(element)
    || element.closest<HTMLElement>(DATE_PICKER_ROOT_SELECTOR)
    || element;
  const style = window.getComputedStyle(root);
  const rect = root.getBoundingClientRect();

  // offsetParent 对 fixed、transform/zoom 容器和部分组件库内部 input 并不可靠。
  // 只要控件实际生成了可见盒子，就应进入检测；display:none 等隐藏节点的
  // 客户区尺寸会为零，仍会在这里被排除。
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && !root.hidden
    && rect.width > 0
    && rect.height > 0;
}

export function isPrimaryCustomSelectControl(element: WritableFormControl): boolean {
  if (!isCustomSelectControl(element)) return true;
  const root = getCustomSelectRoot(element);
  if (!root) return true;
  if (root === element) return true;
  const controls = Array.from(root.querySelectorAll<WritableFormControl>(FORM_CONTROL_SELECTOR))
    .filter(isWritableFormControl);
  const primary = controls.find(isVisibleFormControl) || controls[0];
  return primary === element;
}

export function getFieldContainer(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>(FIELD_CONTAINER_SELECTOR);
}

export function getControlValue(element: WritableFormControl): string {
  if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
    return element.checked ? element.value.trim() : '';
  }
  if (isCustomSelectControl(element)) {
    const selectedText = getCustomSelectSelectedText(element);
    return selectedText || element.value.trim();
  }

  if (typeof HTMLSelectElement !== 'undefined' && element instanceof HTMLSelectElement) {
    const selectedText = element.options[element.selectedIndex]?.text || '';
    return element.value.trim() || selectedText.trim();
  }

  return element.value.trim();
}

export function getCustomSelectSelectedText(element: WritableFormControl): string {
  const root = getCustomSelectRoot(element);
  return root?.querySelector<HTMLElement>([
    '.ud__select__selector__selectItem',
    '.ihr_base_picker-single_selected',
    '.ihr_base_selector-single_selected',
    '.ihr_dict_picker-single_selected',
    '.ihr_area_picker-single_selected',
    '.ihr_tree_picker-single_selected',
    '.ihr_input_selector-single_selected',
    '.ant-select-selection-item',
    '.arco-select-view-value',
    '.el-select__selected-item',
    '.ant-cascader-picker-label',
    '.el-cascader__search-input',
    '[class*=cascader][class*=selected]',
    '[class*=cascade][class*=selected]',
  ].join(', '))?.textContent?.trim() || '';
}

export function getControlKind(element: WritableFormControl): string {
  if (isCustomSelectControl(element)) return 'combobox';
  if (isDatePickerControl(element)) return 'date';
  return element.tagName.toLowerCase();
}

function isSelectPrompt(placeholder: string): boolean {
  return /^(?:请)?选择/i.test(
    placeholder.replace(/[\s:：*]/g, ''),
  );
}

function isFixedSelectPrompt(placeholder: string): boolean {
  return /^(?:请)?选择$/i.test(placeholder.replace(/[\s:：*]/g, ''));
}

function hasSelectIndicator(element: HTMLElement, allowGenericIndicator: boolean): boolean {
  const className = typeof element.className === 'string' ? element.className : '';
  return /select|picker|dropdown|combobox|cascader/i.test(className)
    || Boolean(element.querySelector(CUSTOM_SELECT_INDICATOR_SELECTOR))
    || (allowGenericIndicator && Boolean(element.querySelector(GENERIC_SELECT_INDICATOR_SELECTOR)));
}
