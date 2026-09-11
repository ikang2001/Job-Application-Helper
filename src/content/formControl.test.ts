import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import {
  getCustomSelectRoot,
  isCustomSelectControl,
  isSearchableCustomSelectControl,
  isVisibleFormControl,
} from './formControl.ts';
import { FormFiller } from './formFiller.ts';
import { isResumeUploadSemanticContext } from './formDetector.ts';
import { FieldType } from '../shared/types.ts';
import { createEmptyUserProfile } from '../shared/resumeProfiles.ts';

class FakeInputElement {
  parentElement: FakeInputElement | null = null;
  readonly children: FakeInputElement[] = [];
  placeholder = '';
  className = '';
  tagName = 'INPUT';
  textContent = '';
  id = '';
  type = 'text';
  checked = false;
  isConnected = true;
  readOnly = false;
  value = '';
  clickCount = 0;
  private readonly attributes = new Map<string, string>();
  private hasIndicator = false;
  private width = 100;
  private height = 30;
  private readonly onClick?: () => void;

  constructor(options: {
    placeholder?: string;
    attributes?: Record<string, string>;
    hasIndicator?: boolean;
    className?: string;
    tagName?: string;
    textContent?: string;
    id?: string;
    type?: string;
    onClick?: () => void;
    width?: number;
    height?: number;
  } = {}) {
    this.placeholder = options.placeholder || '';
    this.className = options.className || '';
    this.tagName = options.tagName || 'INPUT';
    this.textContent = options.textContent || '';
    this.id = options.id || '';
    this.type = options.type || 'text';
    this.onClick = options.onClick;
    Object.entries(options.attributes || {}).forEach(([name, value]) => {
      this.attributes.set(name, value);
    });
    this.hasIndicator = options.hasIndicator || false;
    this.width = options.width ?? 100;
    this.height = options.height ?? 30;
  }

  setParent(parent: FakeInputElement): this {
    this.parentElement = parent;
    if (!parent.children.includes(this)) parent.children.push(this);
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  matches(selector: string): boolean {
    if (this.className.split(/\s+/).some(name => name && selector.includes(`.${name}`))) {
      return true;
    }
    const tagPattern = new RegExp(
      `(^|[,\\s>+~])${this.tagName}(?=[.#[:\\s>,+~]|$)`,
      'i',
    );
    if (tagPattern.test(selector)) return true;
    if (this.tagName === 'INPUT' && selector.includes(`input[type="${this.type}"]`)) return true;
    if (selector.includes('[class*=item]') && /item/i.test(this.className)) return true;
    if (selector.includes('[role="combobox"]') && this.getAttribute('role') === 'combobox') {
      return true;
    }
    if (selector.includes('[aria-autocomplete="list"]')
      && this.getAttribute('aria-autocomplete') === 'list') {
      return true;
    }
    return false;
  }

  closest<T>(selector: string): T | null {
    if (this.matches(selector)) return this as T;
    return this.parentElement?.closest<T>(selector) || null;
  }

  querySelector<T>(selector: string): T | null {
    const descendant = this.querySelectorAll<T>(selector)[0];
    if (descendant) return descendant;
    return this.hasIndicator
      && /arrow|caret|icon_expand|icon_trigger|data-icon|aria-label|suffix|svg/i.test(selector)
      ? {} as T
      : null;
  }

  querySelectorAll<T>(selector: string): T[] {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child as unknown as T] : []),
      ...child.querySelectorAll<T>(selector),
    ]);
  }

  contains(target: FakeInputElement): boolean {
    let current: FakeInputElement | null = target;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  scrollIntoView(): void {}

  focus(): void {}

  click(): void {
    this.clickCount += 1;
    this.onClick?.();
  }

  getBoundingClientRect(): DOMRect {
    return {
      width: this.width,
      height: this.height,
    } as DOMRect;
  }
}

const originalInputElement = globalThis.HTMLInputElement;
const originalWindow = globalThis.window;
Object.defineProperty(globalThis, 'HTMLInputElement', {
  configurable: true,
  value: FakeInputElement,
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  },
});

after(() => {
  if (originalInputElement) {
    Object.defineProperty(globalThis, 'HTMLInputElement', {
      configurable: true,
      value: originalInputElement,
    });
  } else {
    delete (globalThis as { HTMLInputElement?: typeof HTMLInputElement }).HTMLInputElement;
  }
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  } else {
    delete (globalThis as { window?: Window }).window;
  }
});

test('真实有尺寸的控件即使 offsetParent 为 null 也视为可见', () => {
  const input = new FakeInputElement();
  const zeroSized = new FakeInputElement({ width: 0, height: 0 });

  assert.equal(isVisibleFormControl(input as unknown as HTMLInputElement), true);
  assert.equal(isVisibleFormControl(zeroSized as unknown as HTMLInputElement), false);
});

test('只把真正的简历上传控件交给自动上传，排除照片和作品附件', () => {
  assert.equal(isResumeUploadSemanticContext(
    'file .doc,.docx,.pdf',
    '可通过上传个人简历来解析内容创建个人资料 简伟康的简历.pdf',
    'ihr_recruit_resume_analysis-container',
  ), true);
  assert.equal(isResumeUploadSemanticContext(
    'file image/png',
    '个人照片 取消 确定',
    'ihr_recruit_resume_person_info-avatar',
  ), false);
  assert.equal(isResumeUploadSemanticContext(
    'file .pdf,.docx',
    '相关作品/附件 上传文件',
    'ihr_recruit_resume_attachment-uploader',
  ), false);
});

test('未知组件类名的“请选择”输入也必须识别成下拉框', () => {
  const parent = new FakeInputElement({ hasIndicator: true });
  const input = new FakeInputElement({ placeholder: '请选择' }).setParent(parent);

  assert.equal(getCustomSelectRoot(input as unknown as HTMLInputElement), parent);
  assert.equal(isCustomSelectControl(input as unknown as HTMLInputElement), true);
  assert.equal(isSearchableCustomSelectControl(input as unknown as HTMLInputElement), false);
});

test('固定下拉即使声明 aria-autocomplete 也不能写入搜索文字', () => {
  const input = new FakeInputElement({
    placeholder: '请选择',
    attributes: { role: 'combobox', 'aria-autocomplete': 'list' },
  });

  assert.equal(isCustomSelectControl(input as unknown as HTMLInputElement), true);
  assert.equal(isSearchableCustomSelectControl(input as unknown as HTMLInputElement), false);
});

test('iHR 字典下拉带 searchable 类也不能写入资料原文过滤候选', () => {
  const root = new FakeInputElement({
    className: 'ihr_base_picker ihr_base_picker--searchable ihr_dict_picker',
  });
  const input = new FakeInputElement({ placeholder: '请选择' }).setParent(root);

  assert.equal(isCustomSelectControl(input as unknown as HTMLInputElement), true);
  assert.equal(isSearchableCustomSelectControl(input as unknown as HTMLInputElement), false);
});

test('明确要求输入搜索的下拉框仍支持远程学校等搜索选择', () => {
  const input = new FakeInputElement({
    placeholder: '请输入学校名称搜索',
    attributes: { role: 'combobox', 'aria-autocomplete': 'list' },
  });

  assert.equal(isCustomSelectControl(input as unknown as HTMLInputElement), true);
  assert.equal(isSearchableCustomSelectControl(input as unknown as HTMLInputElement), true);
});

test('占位符为请选择的输入检索组件仍支持远程学校搜索', () => {
  const root = new FakeInputElement({ className: 'ihr_input_selector' });
  const input = new FakeInputElement({ placeholder: '请选择' }).setParent(root);

  assert.equal(isCustomSelectControl(input as unknown as HTMLInputElement), true);
  assert.equal(isSearchableCustomSelectControl(input as unknown as HTMLInputElement), true);
});

test('无 placeholder 的 MDesign 和树形地区组件仍识别为下拉框', () => {
  const mdSelect = new FakeInputElement({ className: 'md-select' });
  const treePicker = new FakeInputElement({ className: 'ihr_tree_picker' });
  const selectInput = new FakeInputElement().setParent(mdSelect);
  const countryInput = new FakeInputElement().setParent(treePicker);

  assert.equal(getCustomSelectRoot(selectInput as unknown as HTMLInputElement), mdSelect);
  assert.equal(getCustomSelectRoot(countryInput as unknown as HTMLInputElement), treePicker);
  assert.equal(isSearchableCustomSelectControl(selectInput as unknown as HTMLInputElement), false);
});

test('无 placeholder 但带明确下拉箭头的未知组件不再当作文本框', () => {
  const parent = new FakeInputElement({ hasIndicator: true });
  const input = new FakeInputElement().setParent(parent);

  assert.equal(getCustomSelectRoot(input as unknown as HTMLInputElement), parent);
  assert.equal(isCustomSelectControl(input as unknown as HTMLInputElement), true);
});

type TestableFormFiller = {
  fillCustomSelectField: (element: HTMLInputElement, value: string) => Promise<boolean>;
  hasVisibleCustomDropdown: () => boolean;
  waitForCustomOption: (
    value: string,
    timeoutMs: number,
    excluded?: HTMLElement,
    trigger?: HTMLInputElement,
  ) => Promise<HTMLElement | null>;
  setSearchValue: (element: HTMLInputElement, value: string) => void;
  closeCustomDropdown: () => void;
  waitForCustomSelection: (
    element: HTMLInputElement,
    value: string,
    timeoutMs: number,
  ) => Promise<boolean>;
  findVisibleCustomOption: (
    value: string,
    excluded?: HTMLElement,
    trigger?: HTMLInputElement,
  ) => HTMLElement | null;
  getVisibleCustomDropdowns: () => HTMLElement[];
  isVisibleElement: () => boolean;
  getClickableOptionTarget: (target: HTMLElement) => HTMLElement;
  acceptCustomSelection: (
    element: HTMLInputElement,
    value: string,
    allowClosedInputValue?: boolean,
  ) => boolean;
  wait: () => Promise<void>;
};

function createUnmatchedFiller(writtenValues: string[]): TestableFormFiller {
  const filler = new FormFiller() as unknown as TestableFormFiller;
  filler.hasVisibleCustomDropdown = () => true;
  filler.waitForCustomOption = async () => null;
  filler.setSearchValue = (element, value) => {
    writtenValues.push(value);
    (element as unknown as FakeInputElement).value = value;
  };
  filler.closeCustomDropdown = () => {};
  filler.wait = async () => {};
  return filler;
}

test('iHR 学习方式从真实全日制候选中选择，不输入统招全日制过滤选项', async () => {
  const root = new FakeInputElement({
    className: 'ihr_base_picker ihr_base_picker--searchable ihr_dict_picker',
  });
  const input = new FakeInputElement({ placeholder: '请选择' }).setParent(root);
  const option = new FakeInputElement({
    className: 'ihr_dict_picker-menu-item',
    textContent: '全日制',
  });
  const writtenValues: string[] = [];
  const requestedValues: string[] = [];
  const filler = createUnmatchedFiller(writtenValues);
  filler.waitForCustomOption = async (value) => {
    requestedValues.push(value);
    return option as unknown as HTMLElement;
  };
  filler.waitForCustomSelection = async () => option.clickCount === 1;

  const accepted = await filler.fillCustomSelectField(
    input as unknown as HTMLInputElement,
    '统招全日制',
  );

  assert.equal(accepted, true);
  assert.deepEqual(requestedValues, ['统招全日制']);
  assert.deepEqual(writtenValues, []);
  assert.equal(option.clickCount, 1);
});

test('固定下拉未命中时不会把简历原值硬写进控件', async () => {
  const input = new FakeInputElement({ placeholder: '请选择' });
  const writtenValues: string[] = [];
  const filler = createUnmatchedFiller(writtenValues);

  const accepted = await filler.fillCustomSelectField(
    input as unknown as HTMLInputElement,
    '统招全日制',
  );

  assert.equal(accepted, false);
  assert.deepEqual(writtenValues, []);
  assert.equal(input.value, '');
});

test('搜索下拉未命中时恢复原值而不是留下搜索文字', async () => {
  const input = new FakeInputElement({
    placeholder: '请输入学校名称搜索',
    attributes: { role: 'combobox', 'aria-autocomplete': 'list' },
  });
  const writtenValues: string[] = [];
  const filler = createUnmatchedFiller(writtenValues);

  const accepted = await filler.fillCustomSelectField(
    input as unknown as HTMLInputElement,
    '示例大学',
  );

  assert.equal(accepted, false);
  assert.deepEqual(writtenValues, ['示例大学', '']);
  assert.equal(input.value, '');
});

test('远程学校搜索给服务端防抖和网络请求保留足够时间', async () => {
  const input = new FakeInputElement({
    placeholder: '请输入学校名称搜索',
    attributes: { role: 'combobox', 'aria-autocomplete': 'list' },
  });
  const timeouts: number[] = [];
  const filler = createUnmatchedFiller([]);
  filler.waitForCustomOption = async (_value, timeoutMs) => {
    timeouts.push(timeoutMs);
    return null;
  };

  await filler.fillCustomSelectField(input as unknown as HTMLInputElement, '西北工业大学');

  assert.deepEqual(timeouts, [80, 2500]);
});

test('远程学校只在输入完整校名并点击真实候选后才算成功', async () => {
  const root = new FakeInputElement({ className: 'ihr_input_selector' });
  const input = new FakeInputElement({ placeholder: '请选择' }).setParent(root);
  const option = new FakeInputElement({
    className: 'ihr_input_selector-menu-item',
    textContent: '西北工业大学',
  });
  const writtenValues: string[] = [];
  const timeouts: number[] = [];
  const filler = createUnmatchedFiller(writtenValues);
  let lookupCount = 0;
  filler.waitForCustomOption = async (_value, timeoutMs) => {
    timeouts.push(timeoutMs);
    lookupCount += 1;
    return lookupCount === 1 ? null : option as unknown as HTMLElement;
  };
  filler.waitForCustomSelection = async () => option.clickCount === 1;

  const accepted = await filler.fillCustomSelectField(
    input as unknown as HTMLInputElement,
    '西北工业大学',
  );

  assert.equal(accepted, true);
  assert.deepEqual(writtenValues, ['西北工业大学']);
  assert.deepEqual(timeouts, [80, 2500]);
  assert.equal(option.clickCount, 1);
});

test('学校搜索词本身不算已选，候选提交后的关闭态才可确认', () => {
  const root = new FakeInputElement({ className: 'ihr_input_selector' });
  const input = new FakeInputElement({ placeholder: '请选择' }).setParent(root);
  input.value = '西北工业大学';
  const filler = new FormFiller() as unknown as TestableFormFiller;
  filler.hasVisibleCustomDropdown = () => false;
  filler.closeCustomDropdown = () => {};

  assert.equal(filler.acceptCustomSelection(
    input as unknown as HTMLInputElement,
    '西北工业大学',
    false,
  ), false);
  assert.equal(filler.acceptCustomSelection(
    input as unknown as HTMLInputElement,
    '西北工业大学',
    true,
  ), true);
});

test('嵌套候选的子节点不会在回退路径中被重复点击', () => {
  const dropdown = new FakeInputElement({ tagName: 'DIV' });
  const option = new FakeInputElement({
    tagName: 'DIV',
    className: 'ihr_tree-item',
    textContent: '中国大陆',
  }).setParent(dropdown);
  new FakeInputElement({
    tagName: 'BUTTON',
    className: 'ihr_tree-item_info',
    textContent: '中国大陆',
  }).setParent(option);
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });

  try {
    const filler = new FormFiller() as unknown as TestableFormFiller;
    filler.getVisibleCustomDropdowns = () => [dropdown as unknown as HTMLElement];
    filler.isVisibleElement = () => true;

    assert.equal(filler.findVisibleCustomOption(
      '中国大陆',
      option as unknown as HTMLElement,
    ), null);
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    } else {
      delete (globalThis as { document?: Document }).document;
    }
  }
});

test('树形地区候选点击真正绑定事件的内部按钮', () => {
  const option = new FakeInputElement({
    tagName: 'DIV',
    className: 'ihr_tree-item',
    textContent: '中国大陆',
  });
  const infoButton = new FakeInputElement({
    tagName: 'BUTTON',
    className: 'ihr_tree-item_info',
    textContent: '中国大陆',
  }).setParent(option);
  const filler = new FormFiller() as unknown as TestableFormFiller;

  assert.equal(
    filler.getClickableOptionTarget(option as unknown as HTMLElement),
    infoButton,
  );
});

test('iHR 字典候选优先点击内部标签，避免同一选项被重复切换', () => {
  const option = new FakeInputElement({
    tagName: 'DIV',
    className: 'ihr_dict_picker-menu-item',
    textContent: '全日制',
  });
  const label = new FakeInputElement({
    tagName: 'DIV',
    className: 'ihr_picker_menu-item_label',
    textContent: '全日制',
  }).setParent(option);
  const filler = new FormFiller() as unknown as TestableFormFiller;

  assert.equal(filler.getClickableOptionTarget(option as unknown as HTMLElement), label);
});

test('iHR 真实字典菜单项直接点击外层以提交选中值', () => {
  const option = new FakeInputElement({
    tagName: 'DIV',
    className: 'ihr_picker_menu-item',
    textContent: '全日制',
  });
  new FakeInputElement({
    tagName: 'DIV',
    className: 'ihr_picker_menu-item_label',
    textContent: '全日制',
  }).setParent(option);
  const filler = new FormFiller() as unknown as TestableFormFiller;

  assert.equal(filler.getClickableOptionTarget(option as unknown as HTMLElement), option);
});

test('同一单选组只处理一次并按 label 文本选择性别', async () => {
  const group = new FakeInputElement({ tagName: 'DIV', className: 'md-radio-group' });
  const maleLabel = new FakeInputElement({ tagName: 'LABEL', textContent: '男' }).setParent(group);
  const femaleLabel = new FakeInputElement({ tagName: 'LABEL', textContent: '女' }).setParent(group);
  const male = new FakeInputElement({ tagName: 'INPUT', type: 'radio' }).setParent(maleLabel);
  const female = new FakeInputElement({ tagName: 'INPUT', type: 'radio' }).setParent(femaleLabel);
  Object.defineProperty(maleLabel, 'onClick', {
    configurable: true,
    value: () => {
      male.checked = true;
      female.checked = false;
    },
  });
  Object.defineProperty(femaleLabel, 'onClick', {
    configurable: true,
    value: () => {
      male.checked = false;
      female.checked = true;
    },
  });
  const profile = createEmptyUserProfile();
  profile.personal.gender = '男';
  const filler = new FormFiller();

  const filledCount = await filler.fillForm([
    { element: female as unknown as HTMLInputElement, fieldType: FieldType.GENDER, confidence: 1 },
    { element: male as unknown as HTMLInputElement, fieldType: FieldType.GENDER, confidence: 1 },
  ], profile);

  assert.equal(filledCount, 1);
  assert.equal(male.checked, true);
  assert.equal(female.checked, false);
  assert.equal(maleLabel.clickCount, 1);
  assert.equal(femaleLabel.clickCount, 0);
  assert.deepEqual(filler.getLastFillDiagnostics().rejectedFields, []);
});

test('re-detection selection verification is read-only', () => {
  const root = new FakeInputElement({
    className: 'ihr_base_picker ihr_dict_picker',
  });
  const input = new FakeInputElement({ placeholder: '请选择' }).setParent(root);
  const selected = new FakeInputElement({
    className: 'ihr_base_picker-single_selected',
    textContent: '身份证',
  }).setParent(root);
  let closeCount = 0;
  const filler = new FormFiller() as unknown as {
    isCustomSelectionAccepted: (
      element: HTMLInputElement,
      value: string,
      allowClosedInputValue?: boolean,
    ) => boolean;
    closeCustomDropdown: () => void;
    hasVisibleCustomDropdown: () => boolean;
  };
  filler.hasVisibleCustomDropdown = () => true;
  filler.closeCustomDropdown = () => { closeCount += 1; };

  assert.equal(filler.isCustomSelectionAccepted(
    input as unknown as HTMLInputElement,
    '身份证',
  ), true);
  assert.equal(closeCount, 0);
  assert.equal(selected.textContent, '身份证');
});
