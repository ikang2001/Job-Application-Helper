import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import {
  FormFiller,
  isRegionStructuralNodeLabel,
  parseRegionPath,
} from './formFiller.ts';
import { FieldMatcher } from '../utils/fieldMatcher.ts';
import {
  matchIdentityCompoundControl,
  shouldAnalyzeFormControl,
} from './formDetector.ts';
import { isCustomSelectControl } from './formControl.ts';
import { findBestMatchingOptionIndex } from '../utils/optionMatcher.ts';
import { FieldType } from '../shared/types.ts';
import { createEmptyUserProfile } from '../shared/resumeProfiles.ts';

type MockNode = {
  className: string;
  tagName: string;
  id: string;
  value: string;
  placeholder: string;
  type: string;
  disabled: boolean;
  readOnly: boolean;
  textContent: string;
  isConnected: boolean;
  parentElement: MockNode | null;
  getAttribute(name: string): string | null;
  closest<T>(selector: string): T | null;
  querySelector<T>(selector: string): T | null;
  querySelectorAll<T>(selector: string): T[];
};

function node(options: Partial<MockNode> = {}): MockNode {
  const attributes = new Map<string, string>();
  const result: MockNode = {
    className: '',
    tagName: 'DIV',
    id: '',
    value: '',
    placeholder: '',
    type: 'text',
    disabled: false,
    readOnly: false,
    textContent: '',
    isConnected: true,
    parentElement: null,
    getAttribute(name) {
      if (name === 'class') return result.className;
      if (name === 'id') return result.id;
      if (name === 'value') return result.value;
      if (name === 'placeholder') return result.placeholder;
      return attributes.get(name) ?? null;
    },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    ...options,
  };
  return result;
}

class PickerInput {
  readonly tagName = 'INPUT';
  readonly type = 'text';
  readonly className = 'ihr_base_picker-search_input';
  readonly placeholder = '请选择';
  readonly isConnected = true;
  readonly disabled = false;
  readonly readOnly = true;
  value = '';
  parentElement: PickerRoot | null = null;

  getAttribute(name: string): string | null {
    if (name === 'class') return this.className;
    if (name === 'placeholder') return this.placeholder;
    if (name === 'type') return this.type;
    return null;
  }

  matches(selector: string): boolean {
    return selector.includes('.ihr_base_picker-search_input');
  }

  closest<T>(selector: string): T | null {
    if (selector.includes('.ihr_area_picker') || selector.includes('.ihr_base_picker')) {
      return this.parentElement as T | null;
    }
    return null;
  }

  focus(): void {}

  click(): void {}
}

class PickerRoot {
  readonly className = 'ihr_area_picker ihr_tree_picker ihr_base_picker';
  readonly hidden = false;
  readonly isConnected = true;
  readonly input = new PickerInput();
  clickCount = 0;

  constructor() {
    this.input.parentElement = this;
  }

  getAttribute(name: string): string | null {
    return name === 'class' ? this.className : null;
  }

  matches(selector: string): boolean {
    return selector.includes('.ihr_area_picker') || selector.includes('.ihr_base_picker');
  }

  closest<T>(): T | null { return null; }

  querySelector<T>(): T | null { return null; }

  querySelectorAll<T>(): T[] { return []; }

  scrollIntoView(): void {}

  click(): void { this.clickCount += 1; }

  getBoundingClientRect(): DOMRect {
    return { width: 320, height: 40 } as DOMRect;
  }
}

const originalInputElement = globalThis.HTMLInputElement;
const originalTextAreaElement = globalThis.HTMLTextAreaElement;
const originalDocument = globalThis.document;

after(() => {
  if (originalInputElement) {
    Object.defineProperty(globalThis, 'HTMLInputElement', {
      configurable: true,
      value: originalInputElement,
    });
  } else {
    delete (globalThis as { HTMLInputElement?: typeof HTMLInputElement }).HTMLInputElement;
  }
  if (originalTextAreaElement) {
    Object.defineProperty(globalThis, 'HTMLTextAreaElement', {
      configurable: true,
      value: originalTextAreaElement,
    });
  } else {
    delete (globalThis as { HTMLTextAreaElement?: typeof HTMLTextAreaElement }).HTMLTextAreaElement;
  }
  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: originalDocument,
    });
  } else {
    delete (globalThis as { document?: Document }).document;
  }
});

test('iHR 脱敏夹具保留籍贯、身份证组合项和两条教育行的真实类名', { concurrency: false }, () => {
  const fixture = readFileSync(
    new URL('../../tests/fixtures/midea-resume-regression.html', import.meta.url),
    'utf8',
  );

  assert.match(fixture, /ihr_area_picker/);
  assert.match(fixture, /ihr_base_picker--searchable ihr_dict_picker/);
  assert.match(fixture, /ihr_recruit_resume_person_info-idNumber/);
  assert.match(fixture, /phone_code_group-input/);
  assert.match(fixture, /multiple_form-edu-0/);
  assert.match(fixture, /multiple_form-edu-1/);
  assert.equal((fixture.match(/name="learningType"/g) || []).length, 2);
});

test('籍贯按完整省市区路径逐级匹配候选，而不是把路径当作普通文本覆盖', { concurrency: false }, () => {
  const hometown = '陕西省-西安市-雁塔区';
  assert.deepEqual(parseRegionPath(hometown), ['陕西省', '西安市', '雁塔区']);
  assert.deepEqual(parseRegionPath('湖北省武汉市'), ['湖北省', '武汉市']);
  assert.deepEqual(parseRegionPath('湖北省天门市'), ['湖北省', '天门市']);
  assert.deepEqual(parseRegionPath('北京市海淀区'), ['北京市', '海淀区']);
  assert.deepEqual(parseRegionPath('中国/湖北省/武汉市'), ['湖北省', '武汉市']);
  assert.deepEqual(parseRegionPath('中国湖北省武汉市'), ['湖北省', '武汉市']);
  assert.deepEqual(
    parseRegionPath('广西壮族自治区南宁市青秀区'),
    ['广西壮族自治区', '南宁市', '青秀区'],
  );
  assert.equal(findBestMatchingOptionIndex(hometown, ['陕西省', '山西省']), 0);
  assert.equal(findBestMatchingOptionIndex(hometown, ['咸阳市', '西安市']), 1);
  assert.equal(findBestMatchingOptionIndex(hometown, ['未央区', '雁塔区']), 1);
  assert.equal(
    FieldMatcher.matchFieldType('nativePlace', '', '', '籍贯', 'text', '').fieldType,
    FieldType.HOMETOWN,
  );
  assert.equal(isRegionStructuralNodeLabel('湖北省直辖县级行政区划'), true);
  assert.equal(isRegionStructuralNodeLabel('市辖区'), true);
  assert.equal(isRegionStructuralNodeLabel('武汉市'), false);

  const profile = createEmptyUserProfile();
  profile.education = [{
    id: 'edu-location',
    school: '示例大学',
    schoolLocation: '湖北省天门市',
    major: '',
    degree: '',
    startDate: '',
    endDate: '',
  }];
  assert.equal(
    new FormFiller().resolveFieldValue(FieldType.SCHOOL_LOCATION, profile),
    '湖北省天门市',
  );
});

test('籍贯级联会依次点击省、市、区候选并在末级确认', { concurrency: false }, async () => {
  class TestInput extends PickerInput {}
  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: TestInput,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });

  type Option = {
    className: string;
    textContent: string;
    clickCount: number;
    click: () => void;
    matches: (selector: string) => boolean;
    querySelector: <T>(selector: string) => T | null;
  };
  const options: Option[] = ['陕西省', '西安市', '雁塔区'].map(textContent => {
    const option: Option = {
      className: 'ihr_tree-item',
      textContent,
      clickCount: 0,
      click() { option.clickCount += 1; },
      matches(selector) { return selector.includes('.ihr_tree-item'); },
      querySelector() { return null; },
    };
    return option;
  });
  const root = new PickerRoot();
  const input = new TestInput();
  input.parentElement = root;
  const optionTimeouts: number[] = [];
  const parentTargets: Array<HTMLElement | undefined> = [];
  const filler = new FormFiller() as unknown as {
    fillCustomSelectField: (element: HTMLInputElement, value: string) => Promise<boolean>;
    hasVisibleCustomDropdown: () => boolean;
    waitForCascadingRegionOption: (
      value: string,
      timeoutMs: number,
      parentTarget: HTMLElement | undefined,
      trigger?: HTMLInputElement,
    ) => Promise<HTMLElement | null>;
    waitForCustomSelection: (
      element: HTMLInputElement,
      value: string,
      timeoutMs: number,
    ) => Promise<boolean>;
    waitForCascadingRegionSelection: (
      element: HTMLInputElement,
      path: string[],
      timeoutMs: number,
    ) => Promise<boolean>;
    wait: () => Promise<void>;
  };
  filler.hasVisibleCustomDropdown = () => true;
  filler.wait = async () => {};
  const requestedValues: string[] = [];
  filler.waitForCascadingRegionOption = async (requestedValue, timeoutMs, parentTarget) => {
    requestedValues.push(requestedValue);
    optionTimeouts.push(timeoutMs);
    parentTargets.push(parentTarget);
    const next = options.find(option => (
      option.textContent === requestedValue
      && option.clickCount === 0
    ));
    return (next as unknown as HTMLElement | undefined) || null;
  };
  filler.waitForCascadingRegionSelection = async () => options[2].clickCount === 1;

  const accepted = await filler.fillCustomSelectField(
    input as unknown as HTMLInputElement,
    '陕西省-西安市-雁塔区',
  );

  assert.equal(accepted, true);
  assert.deepEqual(options.map(option => option.clickCount), [1, 1, 1]);
  assert.deepEqual(requestedValues, ['陕西省', '西安市', '雁塔区']);
  assert.deepEqual(parentTargets, [undefined, options[0], options[1]]);
  assert.ok(optionTimeouts[0] >= 600);
  assert.ok(optionTimeouts.slice(1).every(timeoutMs => timeoutMs >= 800));
});

test('籍贯上次已展开省级且城市已出现时不会再次点击父节点折叠', { concurrency: false }, async () => {
  class TestInput extends PickerInput {}
  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: TestInput,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });

  const root = new PickerRoot();
  const input = new TestInput();
  input.parentElement = root;
  const province = { textContent: '湖北省', clickCount: 0, click() { this.clickCount += 1; }, matches: () => true, querySelector: () => null };
  const city = { textContent: '武汉市', clickCount: 0, click() { this.clickCount += 1; }, matches: () => true, querySelector: () => null };
  const requestedValues: string[] = [];
  const filler = new FormFiller() as unknown as {
    fillCustomSelectField: (element: HTMLInputElement, value: string) => Promise<boolean>;
    hasVisibleCustomDropdown: () => boolean;
    findVisibleCustomOption: (value: string) => HTMLElement | null;
    waitForCascadingRegionOption: (value: string) => Promise<HTMLElement | null>;
    waitForCascadingRegionSelection: () => Promise<boolean>;
    wait: () => Promise<void>;
  };
  filler.hasVisibleCustomDropdown = () => true;
  filler.findVisibleCustomOption = value => (
    value === '武汉市' ? city as unknown as HTMLElement : null
  );
  filler.waitForCascadingRegionOption = async value => {
    requestedValues.push(value);
    return value === '湖北省'
      ? province as unknown as HTMLElement
      : city as unknown as HTMLElement;
  };
  filler.waitForCascadingRegionSelection = async () => true;
  filler.wait = async () => {};

  const accepted = await filler.fillCustomSelectField(
    input as unknown as HTMLInputElement,
    '湖北省武汉市',
  );

  assert.equal(accepted, true);
  assert.deepEqual(requestedValues, ['武汉市']);
  assert.equal(province.clickCount, 0);
  assert.equal(city.clickCount, 1);
});

test('省直管市会先展开网站结构节点，再选择真实城市叶子', { concurrency: false }, async () => {
  let bridgeExpanded = false;
  const bridge = {
    click() { bridgeExpanded = true; },
  } as unknown as HTMLElement;
  const target = {} as HTMLElement;
  const filler = new FormFiller() as unknown as {
    waitForCascadingRegionOption: (
      value: string,
      timeoutMs: number,
      parentTarget: HTMLElement,
      trigger: HTMLInputElement,
    ) => Promise<HTMLElement | null>;
    findVisibleRegionOption: () => HTMLElement | null;
    findRegionStructuralBridge: () => HTMLElement | null;
    getClickableOptionTarget: (candidate: HTMLElement) => HTMLElement;
    wait: () => Promise<void>;
  };

  filler.findVisibleRegionOption = () => bridgeExpanded ? target : null;
  filler.findRegionStructuralBridge = () => bridgeExpanded ? null : bridge;
  filler.getClickableOptionTarget = candidate => candidate;
  filler.wait = async () => {};

  const result = await filler.waitForCascadingRegionOption(
    '天门市',
    500,
    {} as HTMLElement,
    {} as HTMLInputElement,
  );

  assert.equal(bridgeExpanded, true);
  assert.equal(result, target);
});

test('美的身份证组合项把前置字典下拉和号码输入分成两个字段', { concurrency: false }, () => {
  const label = node({ tagName: 'LABEL', textContent: '证件号码' });
  // iHR 的最近表单项实际带 `...person_info-phone`，外层列再带 `...idNumber`；
  // 组合识别必须以最近表单项中的两个控件为准。
  const fieldContainer = node({ className: 'ihr_recruit_resume_person_info-phone is-required' });
  const pickerRoot = node({ className: 'ihr_dict_picker ihr_base_picker' });
  const picker = node({ tagName: 'INPUT', placeholder: '请选择' });
  const number = node({ tagName: 'INPUT', id: '', value: '' });

  const controls = [picker, number];
  fieldContainer.querySelector = <T>() => label as unknown as T;
  fieldContainer.querySelectorAll = <T>() => controls as unknown as T[];

  const configure = (element: MockNode, isPicker: boolean) => {
    element.closest = <T>(selector: string): T | null => {
      if (selector.includes('.md-form-item')) return fieldContainer as unknown as T;
      if (selector.includes('.ihr_recruit_resume_person_info-idNumber')) {
        return fieldContainer as unknown as T;
      }
      if (isPicker && selector.includes('.ihr_base_picker')) return pickerRoot as unknown as T;
      if (selector === 'label') return null;
      return null;
    };
  };
  configure(picker, true);
  configure(number, false);

  const matched = controls.map(control => {
    const identifiers = FieldMatcher.extractIdentifiers(
      control as unknown as HTMLInputElement,
    );
    return FieldMatcher.matchFieldType(
      identifiers.name,
      identifiers.id,
      identifiers.placeholder,
      identifiers.labelText,
      identifiers.type,
      identifiers.autocomplete,
    ).fieldType;
  });

  assert.deepEqual(matched, [FieldType.ID_TYPE, FieldType.ID_CARD]);

  const numberIdentifiers = FieldMatcher.extractIdentifiers(number as unknown as HTMLInputElement);
  assert.equal(FieldMatcher.matchFieldType(
    numberIdentifiers.name,
    numberIdentifiers.id,
    numberIdentifiers.placeholder,
    numberIdentifiers.labelText,
    numberIdentifiers.type,
    numberIdentifiers.autocomplete,
  ).confidence, 1);
});

test('证件号码框无 name/id 且父容器误用 phone 类名时仍按组合位置识别', { concurrency: false }, () => {
  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: Object,
  });
  Object.defineProperty(globalThis, 'HTMLTextAreaElement', {
    configurable: true,
    value: class MockTextAreaElement {},
  });

  const label = node({ tagName: 'LABEL', textContent: '证件号码' });
  const container = node({ className: 'md-form-item ihr_recruit_resume_person_info-phone' });
  const pickerRoot = node({ className: 'ihr_dict_picker ihr_base_picker' });
  const compoundInputGroup = node({ className: 'md-input md-input-group phone_code_group-input' });
  const picker = node({ tagName: 'INPUT', placeholder: '', value: '', className: 'ihr_base_picker-search_input' });
  const number = node({ tagName: 'INPUT', placeholder: '请输入', value: '', id: '' });
  const controls = [picker, number];

  container.querySelector = <T>() => label as unknown as T;
  container.querySelectorAll = <T>() => controls as unknown as T[];
  compoundInputGroup.parentElement = container;
  compoundInputGroup.querySelector = <T>() => pickerRoot as unknown as T;
  number.parentElement = compoundInputGroup;
  picker.closest = <T>(selector: string): T | null => {
    if (selector.includes('.md-form-item')) return container as unknown as T;
    if (selector.includes('.ihr_base_picker')) return pickerRoot as unknown as T;
    return null;
  };
  number.closest = <T>(selector: string): T | null => (
    selector.includes('.md-form-item') ? container as unknown as T : null
  );

  // 真实页面的共同父容器内含前置下拉箭头，通用启发式会把号码框
  // 误看成自定义下拉；证件组合语义必须优先放行它。
  assert.equal(isCustomSelectControl(number as unknown as HTMLInputElement), true);
  assert.equal(
    matchIdentityCompoundControl(picker as unknown as HTMLInputElement),
    FieldType.ID_TYPE,
  );
  assert.equal(
    matchIdentityCompoundControl(number as unknown as HTMLInputElement),
    FieldType.ID_CARD,
  );
  assert.equal(
    shouldAnalyzeFormControl(number as unknown as HTMLInputElement),
    true,
  );
});

test('选择证件类型后页面重绘出的证件号码控件仍会被写入', { concurrency: false }, async () => {
  class TestInput extends PickerInput {
    override closest<T>(selector: string): T | null {
      if (selector.includes('.ihr_base_picker')) return this.parentElement as T | null;
      return null;
    }
  }

  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: TestInput,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });

  const root = new PickerRoot();
  const idType = new TestInput();
  idType.parentElement = root;
  const idCard = node({ tagName: 'INPUT', value: '', isConnected: true });
  const initialFields = [{
    element: idType as unknown as HTMLInputElement,
    fieldType: FieldType.ID_TYPE,
    confidence: 1,
  }];
  let liveFields = initialFields;
  const calls: Array<[FieldType, string]> = [];
  const profile = createEmptyUserProfile();
  profile.personal.idCard = '110101199001010000';

  const filler = new FormFiller() as unknown as {
    fillField: (element: HTMLInputElement, value: string) => Promise<boolean>;
    acceptCustomSelection: () => boolean;
  };
  filler.acceptCustomSelection = () => true;
  filler.fillField = async (element, value) => {
    const fieldType = element === idType
      ? FieldType.ID_TYPE
      : FieldType.ID_CARD;
    calls.push([fieldType, value]);
    if (fieldType === FieldType.ID_TYPE) {
      liveFields = [
        ...initialFields,
        { element: idCard as unknown as HTMLInputElement, fieldType: FieldType.ID_CARD, confidence: 1 },
      ];
    } else {
      idCard.value = value;
    }
    return true;
  };

  await (filler as unknown as FormFiller).fillForm(
    initialFields,
    profile,
    () => liveFields,
  );

  assert.deepEqual(calls, [
    [FieldType.ID_TYPE, '身份证'],
    [FieldType.ID_CARD, '110101199001010000'],
  ]);
});

test('旧证件号码节点先存在并在 180ms 后替换时只写入新节点', { concurrency: false }, async () => {
  class TestInput extends PickerInput {
    override closest<T>(selector: string): T | null {
      if (selector.includes('.ihr_base_picker')) return this.parentElement as T | null;
      return null;
    }
  }

  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: TestInput,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });

  const root = new PickerRoot();
  const idType = new TestInput();
  idType.parentElement = root;
  const oldIdCard = node({ tagName: 'INPUT', id: 'id-card-old', isConnected: true });
  const newIdCard = node({ tagName: 'INPUT', id: 'id-card-new', isConnected: true });
  const initialFields = [
    { element: idType as unknown as HTMLInputElement, fieldType: FieldType.ID_TYPE, confidence: 1 },
    { element: oldIdCard as unknown as HTMLInputElement, fieldType: FieldType.ID_CARD, confidence: 1 },
  ];
  const profile = createEmptyUserProfile();
  profile.personal.idCard = '110101199001010000';
  const calls: string[] = [];
  let virtualTime = 0;

  const filler = new FormFiller() as unknown as {
    fillField: (element: HTMLInputElement, value: string) => Promise<boolean>;
    acceptCustomSelection: () => boolean;
    wait: (ms: number) => Promise<void>;
  };
  filler.acceptCustomSelection = () => true;
  filler.wait = async (ms) => { virtualTime += ms; };
  filler.fillField = async (element, value) => {
    calls.push(`${(element as unknown as MockNode).id || 'id-type'}:${value}`);
    return true;
  };

  const redetectFields = () => {
    if (virtualTime < 180) return initialFields;
    oldIdCard.isConnected = false;
    return [
      initialFields[0],
      { element: newIdCard as unknown as HTMLInputElement, fieldType: FieldType.ID_CARD, confidence: 1 },
    ];
  };

  await (filler as unknown as FormFiller).fillForm(initialFields, profile, redetectFields);

  assert.ok(virtualTime >= 180);
  assert.ok(calls.includes('id-card-new:110101199001010000'));
  assert.ok(!calls.includes('id-card-old:110101199001010000'));
});

test('后续个人信息下拉清空同一证件号节点时最终复核会重新写回', { concurrency: false }, async () => {
  class TestInput extends PickerInput {}
  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: TestInput,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });

  const idCard = node({ tagName: 'INPUT', id: 'id-card', value: '', isConnected: true });
  const nationality = new TestInput();
  nationality.parentElement = new PickerRoot();
  const fields = [
    { element: idCard as unknown as HTMLInputElement, fieldType: FieldType.ID_CARD, confidence: 1 },
    { element: nationality as unknown as HTMLInputElement, fieldType: FieldType.NATIONALITY, confidence: 1 },
  ];
  const profile = createEmptyUserProfile();
  profile.personal.idCard = '110101199001010000';
  const calls: string[] = [];
  const filler = new FormFiller() as unknown as {
    fillField: (element: HTMLInputElement, value: string) => Promise<boolean>;
    acceptCustomSelection: () => boolean;
    wait: () => Promise<void>;
  };
  filler.acceptCustomSelection = () => true;
  filler.wait = async () => {};
  filler.fillField = async (element, value) => {
    if (element === idCard as unknown as HTMLInputElement) {
      calls.push(`id-card:${value}`);
      idCard.value = value;
    } else {
      calls.push(`nationality:${value}`);
      idCard.value = '';
    }
    return true;
  };

  await (filler as unknown as FormFiller).fillForm(fields, profile, () => fields);

  assert.deepEqual(calls, [
    'id-card:110101199001010000',
    'nationality:中国',
    'id-card:110101199001010000',
  ]);
  assert.equal(idCard.value, '110101199001010000');
});

test('证件号码使用浏览器文本编辑写入，组件首次回滚时只重试证件号码', { concurrency: false }, async () => {
  class IdentityInput {
    readonly tagName = 'INPUT';
    readonly type = 'text';
    readonly placeholder = '请输入';
    readonly disabled = false;
    readonly readOnly = false;
    readonly isConnected = true;
    value = '';
    blurCount = 0;
    selectCount = 0;
    eventTypes: string[] = [];

    getAttribute(name: string): string | null {
      if (name === 'type') return this.type;
      if (name === 'placeholder') return this.placeholder;
      return null;
    }

    closest<T>(): T | null { return null; }

    focus(): void {}

    select(): void { this.selectCount += 1; }

    dispatchEvent(event: Event): boolean {
      this.eventTypes.push(event.type);
      return true;
    }

    blur(): void { this.blurCount += 1; }
  }

  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: IdentityInput,
  });
  const idCard = new IdentityInput();
  let browserInsertCount = 0;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelectorAll: () => [],
      execCommand(command: string, _showUi: boolean, value: string) {
        assert.equal(command, 'insertText');
        browserInsertCount += 1;
        idCard.value = value;
        return true;
      },
    },
  });
  const field = {
    element: idCard as unknown as HTMLInputElement,
    fieldType: FieldType.ID_CARD,
    confidence: 1,
  };
  const profile = createEmptyUserProfile();
  profile.personal.idCard = '110101199001010000';
  const calls: string[] = [];
  let rolledBack = false;
  const filler = new FormFiller() as unknown as {
    fillField: (element: HTMLInputElement, value: string) => Promise<boolean>;
    wait: () => Promise<void>;
  };
  filler.fillField = async (_element, value) => {
    calls.push(value);
    idCard.value = value;
    return true;
  };
  filler.wait = async () => {
    if (idCard.blurCount === 1 && !rolledBack) {
      rolledBack = true;
      idCard.value = '';
    }
  };

  await (filler as unknown as FormFiller).fillForm([field], profile, () => [field]);

  assert.deepEqual(calls, []);
  assert.equal(browserInsertCount, 2);
  assert.equal(idCard.selectCount, 2);
  assert.equal(idCard.blurCount, 2);
  assert.equal(idCard.eventTypes.filter(type => type === 'input').length, 2);
  assert.equal(idCard.value, '110101199001010000');
});

test('证件号码首次处理就走受控输入链路且规范化空格和小写 x', { concurrency: false }, async () => {
  const falseSelectRoot = {
    className: 'md-input md-input-group phone_code_group-input',
    parentElement: null,
    getAttribute: (name: string) => (
      name === 'class' ? 'md-input md-input-group phone_code_group-input' : null
    ),
    matches: () => false,
    querySelector: (selector: string) => (
      selector.includes('selected') ? { textContent: '身份证' } : {}
    ),
  };
  class IdentityInput {
    readonly tagName = 'INPUT';
    readonly type = 'text';
    readonly placeholder = '请输入';
    readonly disabled = false;
    readonly readOnly = false;
    readonly isConnected = true;
    readonly parentElement = falseSelectRoot;
    value = '';

    getAttribute(name: string): string | null {
      if (name === 'type') return this.type;
      if (name === 'placeholder') return this.placeholder;
      return null;
    }

    closest<T>(): T | null { return null; }

    focus(): void {}

    select(): void {}

    dispatchEvent(): boolean { return true; }

    blur(): void {}
  }

  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: IdentityInput,
  });
  const idCard = new IdentityInput();
  assert.equal(
    isCustomSelectControl(idCard as unknown as HTMLInputElement),
    true,
    '共同父容器的下拉箭头会让通用启发式误判号码框',
  );
  const insertedValues: string[] = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelectorAll: () => [],
      execCommand(_command: string, _showUi: boolean, value: string) {
        insertedValues.push(value);
        idCard.value = value;
        return true;
      },
    },
  });
  const field = {
    element: idCard as unknown as HTMLInputElement,
    fieldType: FieldType.ID_CARD,
    confidence: 1,
  };
  const profile = createEmptyUserProfile();
  profile.personal.idType = '身份证';
  profile.personal.idCard = ' 11010119900101000x ';
  const genericWrites: string[] = [];
  const filler = new FormFiller() as unknown as {
    fillField: (_element: HTMLInputElement, value: string) => Promise<boolean>;
    wait: () => Promise<void>;
  };
  filler.fillField = async (_element, value) => {
    genericWrites.push(value);
    return true;
  };
  filler.wait = async () => {};

  await (filler as unknown as FormFiller).fillForm([field], profile, () => [field]);

  assert.deepEqual(genericWrites, []);
  assert.deepEqual(insertedValues, ['11010119900101000X']);
  assert.equal(idCard.value, '11010119900101000X');
});

test('国籍首次失败时会先重试，并在籍贯字段出现后继续补填', { concurrency: false }, async () => {
  const nationality = node({ id: 'nationality', value: '', isConnected: true });
  const hometown = node({ id: 'hometown', value: '', isConnected: true });
  const nationalityField = {
    element: nationality as unknown as HTMLInputElement,
    fieldType: FieldType.NATIONALITY,
    confidence: 1,
  };
  const hometownField = {
    element: hometown as unknown as HTMLInputElement,
    fieldType: FieldType.HOMETOWN,
    confidence: 1,
  };
  const profile = createEmptyUserProfile();
  profile.personal.nationality = '中国';
  profile.personal.hometown = '湖北省天门市';
  const calls: string[] = [];
  let nationalityAttempts = 0;
  let hometownVisible = false;
  const filler = new FormFiller() as unknown as {
    fillField: (element: HTMLInputElement, value: string) => Promise<boolean>;
    wait: () => Promise<void>;
  };
  filler.wait = async () => {};
  filler.fillField = async (element, value) => {
    calls.push(`${(element as unknown as MockNode).id}:${value}`);
    if (element === nationality as unknown as HTMLInputElement) {
      nationalityAttempts += 1;
      if (nationalityAttempts === 1) return false;
      nationality.value = value;
      hometownVisible = true;
      return true;
    }
    hometown.value = value;
    return true;
  };

  await (filler as unknown as FormFiller).fillForm(
    [nationalityField],
    profile,
    () => hometownVisible ? [nationalityField, hometownField] : [nationalityField],
  );

  assert.deepEqual(calls, [
    'nationality:中国',
    'nationality:中国',
    'hometown:湖北省天门市',
  ]);
});

test('美的两条教育行按 multiple_form-edu 行号分别写入学习方式', { concurrency: false }, async () => {
  const row = (index: number) => ({
    getAttribute(name: string): string | null {
      return name === 'class'
        ? `ihr_recruit_resume-block-multiple_form-edu-${index}`
        : null;
    },
  });
  const field = (index: number) => ({
    getAttribute: () => null,
    closest: () => row(index),
    isConnected: true,
    id: `learning-${index}`,
  });
  const first = field(0) as unknown as HTMLInputElement;
  const second = field(1) as unknown as HTMLInputElement;

  assert.equal(FieldMatcher.extractRowIndex(first), 0);
  assert.equal(FieldMatcher.extractRowIndex(second), 1);

  const profile = createEmptyUserProfile();
  profile.education = [
    {
      id: 'edu-0', school: '西北工业大学', major: '机器人', degree: '硕士',
      startDate: '', endDate: '', educationType: '统招全日制',
    },
    {
      id: 'edu-1', school: '武汉轻工大学', major: '自动化', degree: '本科',
      startDate: '', endDate: '', educationType: '全日制',
    },
  ];
  const calls: Array<[string, string]> = [];
  const filler = new FormFiller() as unknown as {
    fillField: (element: HTMLInputElement, value: string) => Promise<boolean>;
  };
  filler.fillField = async (element, value) => {
    calls.push([element.id, value]);
    return true;
  };

  await (filler as unknown as FormFiller).fillForm([
    { element: second, fieldType: FieldType.EDUCATION_TYPE, confidence: 1, rowIndex: 1 },
    { element: first, fieldType: FieldType.EDUCATION_TYPE, confidence: 1, rowIndex: 0 },
  ], profile);

  assert.deepEqual(calls, [
    ['learning-1', '全日制'],
    ['learning-0', '统招全日制'],
  ]);
});

test('学校下拉重绘后新增的第一条学习方式不会被第二条教育经历吞掉', { concurrency: false }, async () => {
  class SchoolInput extends PickerInput {
    readonly id: string;

    constructor(id: string) {
      super();
      this.id = id;
    }
  }

  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: SchoolInput,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });

  const school0 = new SchoolInput('school-0');
  const school1 = new SchoolInput('school-1');
  school0.parentElement = new PickerRoot();
  school1.parentElement = new PickerRoot();
  const learning0 = node({ id: 'learning-0', isConnected: true });
  const learning1 = node({ id: 'learning-1', isConnected: true });
  const initialFields = [
    { element: school0 as unknown as HTMLInputElement, fieldType: FieldType.SCHOOL, confidence: 1, rowIndex: 0 },
    { element: school1 as unknown as HTMLInputElement, fieldType: FieldType.SCHOOL, confidence: 1, rowIndex: 1 },
    { element: learning1 as unknown as HTMLInputElement, fieldType: FieldType.EDUCATION_TYPE, confidence: 1, rowIndex: 1 },
  ];
  let liveFields = initialFields;
  const calls: Array<[string, string]> = [];
  const profile = createEmptyUserProfile();
  profile.education = [
    {
      id: 'edu-0', school: '西北工业大学', major: '机器人', degree: '硕士',
      startDate: '', endDate: '', educationType: '统招全日制',
    },
    {
      id: 'edu-1', school: '武汉轻工大学', major: '自动化', degree: '本科',
      startDate: '', endDate: '', educationType: '全日制',
    },
  ];

  const filler = new FormFiller() as unknown as {
    fillField: (element: HTMLInputElement, value: string) => Promise<boolean>;
    acceptCustomSelection: () => boolean;
  };
  filler.acceptCustomSelection = () => true;
  filler.fillField = async (element, value) => {
    const id = (element as HTMLInputElement & { id?: string }).id || '';
    calls.push([id, value]);
    if (id === 'school-0') {
      liveFields = [...initialFields, {
        element: learning0 as unknown as HTMLInputElement,
        fieldType: FieldType.EDUCATION_TYPE,
        confidence: 1,
        rowIndex: 0,
      }];
    }
    return true;
  };

  await (filler as unknown as FormFiller).fillForm(
    initialFields,
    profile,
    () => liveFields,
  );

  assert.ok(calls.some(([id, value]) => id === 'learning-0' && value === '统招全日制'));
  assert.ok(calls.some(([id, value]) => id === 'learning-1' && value === '全日制'));
});

test('学校下拉异步重绘到 180ms 时仍会等到首条学习方式出现', { concurrency: false }, async () => {
  class SchoolInput extends PickerInput {
    readonly id: string;

    constructor(id: string) {
      super();
      this.id = id;
    }
  }

  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: SchoolInput,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });

  const school0 = new SchoolInput('school-0');
  const school1 = new SchoolInput('school-1');
  school0.parentElement = new PickerRoot();
  school1.parentElement = new PickerRoot();
  const learning0 = node({ id: 'learning-0', isConnected: true });
  const learning1 = node({ id: 'learning-1', isConnected: true });
  const initialFields = [
    { element: school0 as unknown as HTMLInputElement, fieldType: FieldType.SCHOOL, confidence: 1, rowIndex: 0 },
    { element: school1 as unknown as HTMLInputElement, fieldType: FieldType.SCHOOL, confidence: 1, rowIndex: 1 },
    { element: learning1 as unknown as HTMLInputElement, fieldType: FieldType.EDUCATION_TYPE, confidence: 1, rowIndex: 1 },
  ];
  const delayedLearning = {
    element: learning0 as unknown as HTMLInputElement,
    fieldType: FieldType.EDUCATION_TYPE,
    confidence: 1,
    rowIndex: 0,
  };
  let refreshCount = 0;
  const calls: string[] = [];
  const profile = createEmptyUserProfile();
  profile.education = [
    {
      id: 'edu-0', school: '西北工业大学', major: '机器人', degree: '硕士',
      startDate: '', endDate: '', educationType: '统招全日制',
    },
    {
      id: 'edu-1', school: '武汉轻工大学', major: '自动化', degree: '本科',
      startDate: '', endDate: '', educationType: '全日制',
    },
  ];

  const filler = new FormFiller() as unknown as {
    fillField: (element: HTMLInputElement, value: string) => Promise<boolean>;
    acceptCustomSelection: () => boolean;
    wait: (ms: number) => Promise<void>;
  };
  filler.acceptCustomSelection = () => true;
  let virtualTime = 0;
  filler.wait = async (ms) => { virtualTime += ms; };
  filler.fillField = async (element, value) => {
    calls.push(`${(element as HTMLInputElement & { id?: string }).id || ''}:${value}`);
    return true;
  };

  const redetectFields = () => {
    refreshCount += 1;
    return virtualTime >= 180 ? [...initialFields, delayedLearning] : initialFields;
  };

  await (filler as unknown as FormFiller).fillForm(initialFields, profile, redetectFields);

  assert.ok(calls.some(call => call === 'learning-0:统招全日制'));
  assert.ok(virtualTime >= 180);
});

test('首条学习方式旧节点在 180ms 后被替换时会重新绑定新下拉', { concurrency: false }, async () => {
  class SchoolInput extends PickerInput {
    readonly id: string;

    constructor(id: string) {
      super();
      this.id = id;
    }
  }

  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: SchoolInput,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });

  const school0 = new SchoolInput('school-0');
  school0.parentElement = new PickerRoot();
  const oldLearning0 = node({ id: 'learning-0-old', isConnected: true });
  const newLearning0 = node({ id: 'learning-0-new', isConnected: true });
  const initialFields = [
    { element: school0 as unknown as HTMLInputElement, fieldType: FieldType.SCHOOL, confidence: 1, rowIndex: 0 },
    { element: oldLearning0 as unknown as HTMLInputElement, fieldType: FieldType.EDUCATION_TYPE, confidence: 1, rowIndex: 0 },
  ];
  const profile = createEmptyUserProfile();
  profile.education = [{
    id: 'edu-0', school: '西北工业大学', major: '机器人', degree: '硕士',
    startDate: '', endDate: '', educationType: '统招全日制',
  }];
  const calls: string[] = [];
  let virtualTime = 0;
  const filler = new FormFiller() as unknown as {
    fillField: (element: HTMLInputElement, value: string) => Promise<boolean>;
    acceptCustomSelection: () => boolean;
    wait: (ms: number) => Promise<void>;
  };
  filler.acceptCustomSelection = () => true;
  filler.wait = async (ms) => { virtualTime += ms; };
  filler.fillField = async (element, value) => {
    calls.push(`${(element as HTMLInputElement & { id?: string }).id || ''}:${value}`);
    return true;
  };

  const redetectFields = () => {
    if (virtualTime < 180) return initialFields;
    oldLearning0.isConnected = false;
    return [
      initialFields[0],
      {
        element: newLearning0 as unknown as HTMLInputElement,
        fieldType: FieldType.EDUCATION_TYPE,
        confidence: 1,
        rowIndex: 0,
      },
    ];
  };

  await (filler as unknown as FormFiller).fillForm(initialFields, profile, redetectFields);

  assert.ok(virtualTime >= 180);
  assert.ok(calls.includes('learning-0-new:统招全日制'));
  assert.ok(!calls.includes('learning-0-old:统招全日制'));
});

test('已处理过的依赖字段被替换时，新节点会追加到队列再次填充', { concurrency: false }, async () => {
  class SchoolInput extends PickerInput {
    readonly id = 'school-0';
  }

  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: SchoolInput,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelectorAll: () => [] },
  });

  const school = new SchoolInput();
  school.parentElement = new PickerRoot();
  const oldLearning = node({ id: 'learning-old', isConnected: true });
  const newLearning = node({ id: 'learning-new', isConnected: true });
  const initialFields = [
    { element: oldLearning as unknown as HTMLInputElement, fieldType: FieldType.EDUCATION_TYPE, confidence: 1, rowIndex: 0 },
    { element: school as unknown as HTMLInputElement, fieldType: FieldType.SCHOOL, confidence: 1, rowIndex: 0 },
  ];
  const profile = createEmptyUserProfile();
  profile.education = [{
    id: 'edu-0', school: '西北工业大学', major: '机器人', degree: '硕士',
    startDate: '', endDate: '', educationType: '统招全日制',
  }];
  const calls: string[] = [];
  let virtualTime = 0;
  const filler = new FormFiller() as unknown as {
    fillField: (element: HTMLInputElement, value: string) => Promise<boolean>;
    acceptCustomSelection: () => boolean;
    wait: (ms: number) => Promise<void>;
  };
  filler.acceptCustomSelection = () => true;
  filler.wait = async (ms) => { virtualTime += ms; };
  filler.fillField = async (element, value) => {
    calls.push(`${(element as HTMLInputElement & { id?: string }).id || ''}:${value}`);
    return true;
  };

  const redetectFields = () => {
    if (virtualTime < 180) return initialFields;
    oldLearning.isConnected = false;
    return [
      {
        element: newLearning as unknown as HTMLInputElement,
        fieldType: FieldType.EDUCATION_TYPE,
        confidence: 1,
        rowIndex: 0,
      },
      initialFields[1],
    ];
  };

  await (filler as unknown as FormFiller).fillForm(initialFields, profile, redetectFields);

  assert.ok(calls.includes('learning-old:统招全日制'));
  assert.ok(calls.includes('learning-new:统招全日制'), JSON.stringify(calls));
});
