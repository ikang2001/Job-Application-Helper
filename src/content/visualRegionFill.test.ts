import assert from 'node:assert/strict';
import test from 'node:test';
import type { VisualRegionFillMapping } from '../shared/types.ts';
import {
  applyVisualRegionMappings,
  serializeVisualControls,
} from './visualRegionFill.ts';
import { FormFiller } from './formFiller.ts';
import { FieldType } from '../shared/types.ts';
import { createEmptyUserProfile } from '../shared/resumeProfiles.ts';

test('序列化选区内全部可写控件并保留 controlId 与 options', () => {
  const controls = serializeVisualControls([
    {
      controlId: 'ctrl-phone',
      value: '',
      rect: { left: 10, top: 10, width: 120, height: 36 },
      label: '手机号',
      name: 'phone',
      tagName: 'input',
      options: [],
    },
    {
      controlId: 'ctrl-degree',
      value: '',
      rect: { left: 10, top: 80, width: 120, height: 36 },
      label: '学历',
      name: 'degree',
      tagName: 'select',
      options: ['本科', '硕士'],
    },
    {
      controlId: 'ctrl-filled',
      value: '已有值',
      rect: { left: 10, top: 120, width: 120, height: 20 },
      label: '邮箱',
      name: 'email',
      tagName: 'input',
      options: [],
    },
  ], { left: 0, top: 0, right: 200, bottom: 140 });

  assert.deepEqual(controls.map(item => item.controlId), [
    'ctrl-phone', 'ctrl-degree', 'ctrl-filled',
  ]);
  assert.deepEqual(controls[1]?.options, ['本科', '硕士']);
});

test('只把存在于 controlsById 的映射交给写回层', async () => {
  const mappings: VisualRegionFillMapping[] = [
    {
      controlId: 'ctrl-phone',
      fieldMeaning: '手机号',
      matchedProfilePath: 'personal.phone',
      value: '13800000000',
    },
    {
      controlId: 'missing',
      fieldMeaning: '邮箱',
      matchedProfilePath: 'personal.email',
      value: 'test@example.com',
    },
  ];

  const fillCalls: Array<{
    values: Array<{ element: { id: string }; value: string }>;
    keepGoing: boolean;
  }> = [];
  const controlsById = new Map([
    ['ctrl-phone', { controlId: 'ctrl-phone', element: { id: 'phone-input' } }],
  ]);

  const written = await applyVisualRegionMappings(
    mappings,
    controlsById,
    () => true,
    async (values, shouldContinue) => {
      fillCalls.push({
        values: values as Array<{ element: { id: string }; value: string }>,
        keepGoing: shouldContinue(),
      });
      return values.length;
    },
  );

  assert.equal(written, 1);
  assert.equal(fillCalls.length, 1);
  assert.deepEqual(fillCalls[0], {
    values: [{ element: { id: 'phone-input' }, value: '13800000000' }],
    keepGoing: true,
  });
});

test('resolves each award field by its repeated-field index', () => {
  const profile = createEmptyUserProfile();
  profile.awards = [
    { id: 'award-1', name: '一等奖', role: '负责人', date: '2025-06', description: '第一项描述' },
    { id: 'award-2', name: '二等奖', role: '核心成员', date: '2026-07', description: '第二项描述' },
  ];
  const filler = new FormFiller();

  assert.equal(filler.resolveFieldValue(FieldType.AWARD_NAME, profile, 0), '一等奖');
  assert.equal(filler.resolveFieldValue(FieldType.AWARD_ROLE, profile, 1), '核心成员');
  assert.equal(filler.resolveFieldValue(FieldType.AWARD_DATE, profile, 1), '2026-07');
  assert.equal(filler.resolveFieldValue(FieldType.AWARD_DESCRIPTION, profile, 0), '第一项描述');
});

test('keeps generic experience description independent from award descriptions', () => {
  const profile = createEmptyUserProfile();
  profile.experience = [{ id: 'experience-1', company: '示例公司', position: '实习生', startDate: '', endDate: '', description: '通用实习描述' }];
  profile.awards = [{ id: 'award-1', name: '一等奖', role: '', date: '', description: '奖项描述' }];
  const filler = new FormFiller();

  assert.equal(filler.resolveFieldValue(FieldType.DESCRIPTION, profile, 0), '通用实习描述');
  assert.equal(filler.resolveFieldValue(FieldType.AWARD_DESCRIPTION, profile, 0), '奖项描述');
});

test('resolves phone country code, identity fields and language fields independently', () => {
  const profile = createEmptyUserProfile();
  profile.personal.phoneCountryCode = '+86';
  profile.personal.phone = '+86 13800138000';
  profile.personal.idType = '身份证';
  profile.personal.idCard = '110101200001010011';
  profile.languages = [{
    id: 'language-1',
    language: '英语',
    certificate: '大学英语六级',
    level: '通过',
  }];
  const filler = new FormFiller();

  assert.equal(filler.resolveFieldValue(FieldType.PHONE_COUNTRY_CODE, profile), '+86');
  assert.equal(filler.resolveFieldValue(FieldType.PHONE, profile), '13800138000');
  assert.equal(filler.resolveFieldValue(FieldType.ID_TYPE, profile), '身份证');
  assert.equal(filler.resolveFieldValue(FieldType.ID_CARD, profile), '110101200001010011');
  assert.equal(filler.resolveFieldValue(FieldType.LANGUAGE, profile), '英语');
  assert.equal(filler.resolveFieldValue(FieldType.LANGUAGE_CERTIFICATE, profile), '大学英语六级');
  assert.equal(filler.resolveFieldValue(FieldType.LANGUAGE_LEVEL, profile), '通过');
});

test('中国居民身份证可为缺失的国籍提供安全回退', () => {
  const profile = createEmptyUserProfile();
  profile.personal.idType = '身份证';
  profile.personal.idCard = '110101200001010011';
  const filler = new FormFiller();

  assert.equal(filler.resolveFieldValue(FieldType.NATIONALITY, profile), '中国');
  profile.personal.idType = '护照';
  profile.personal.idCard = '';
  assert.equal(filler.resolveFieldValue(FieldType.NATIONALITY, profile), null);
});

test('中国籍资料未显式保存证件类型时仍使用设置页展示的身份证默认值', () => {
  const profile = createEmptyUserProfile();
  profile.personal.nationality = '中国大陆';
  const filler = new FormFiller();

  assert.equal(filler.resolveFieldValue(FieldType.ID_TYPE, profile), '身份证');
});

test('组合下拉重绘 DOM 后按字段语义与行号重新绑定当前控件', () => {
  const stale = { isConnected: false } as HTMLInputElement;
  const replacement = { isConnected: true } as HTMLInputElement;
  const originalField = {
    element: stale,
    fieldType: FieldType.ID_CARD,
    confidence: 1,
  };
  const freshField = {
    element: replacement,
    fieldType: FieldType.ID_CARD,
    confidence: 1,
  };
  const filler = new FormFiller() as unknown as {
    findEquivalentLiveField: (
      field: typeof originalField,
      fields: typeof freshField[],
      occurrence: number,
    ) => typeof freshField | undefined;
  };

  assert.equal(filler.findEquivalentLiveField(originalField, [freshField], 0), freshField);
});

test('依赖下拉重绘后合并新字段并替换脱离节点', () => {
  const detachedEducationType = { isConnected: false } as HTMLInputElement;
  const currentEducationType = { isConnected: true } as HTMLInputElement;
  const replacementEducationType = { isConnected: true } as HTMLInputElement;
  const hometown = { isConnected: true } as HTMLInputElement;
  const pending = [
    { element: detachedEducationType, fieldType: FieldType.EDUCATION_TYPE, confidence: 1, rowIndex: 0 },
    { element: currentEducationType, fieldType: FieldType.EDUCATION_TYPE, confidence: 1, rowIndex: 1 },
  ];
  const queued = new Set<Element>([detachedEducationType, currentEducationType]);
  const filler = new FormFiller() as unknown as {
    mergeRedetectedFields: (
      pendingFields: typeof pending,
      queuedElements: Set<Element>,
      liveFields: typeof pending,
      fillSections: Set<never>,
      handledElements: Set<Element>,
    ) => void;
  };

  filler.mergeRedetectedFields(
    pending,
    queued,
    [
      { element: replacementEducationType, fieldType: FieldType.EDUCATION_TYPE, confidence: 1, rowIndex: 0 },
      { element: hometown, fieldType: FieldType.HOMETOWN, confidence: 1 },
    ],
    new Set(),
    new Set(),
  );

  assert.equal(pending[0]?.element, replacementEducationType);
  assert.equal(pending.filter(field => field.fieldType === FieldType.EDUCATION_TYPE).length, 2);
  assert.equal(pending.some(field => field.element === hometown), true);
  assert.equal(queued.has(detachedEducationType), false);
  assert.equal(queued.has(replacementEducationType), true);
});

test('教育国家与工作描述使用通用规范值', () => {
  const profile = createEmptyUserProfile();
  profile.education = [{
    id: 'edu-1', school: '示例大学', countryRegion: '', educationType: '统招全日制',
    major: '自动化', degree: '本科', startDate: '', endDate: '',
  }];
  profile.experience = [{
    id: 'exp-1', company: '示例科技', position: '实习生', startDate: '', endDate: '',
    description: '统一\n治理目标检测训练全链路资产。',
  }];
  const filler = new FormFiller();

  assert.equal(filler.resolveFieldValue(FieldType.EDUCATION_COUNTRY, profile), '中国');
  assert.equal(filler.resolveFieldValue(FieldType.DESCRIPTION, profile), '统一治理目标检测训练全链路资产。');
});

test('uses explicit repeated-row indexes so education fields cannot drift out of row', async () => {
  const profile = createEmptyUserProfile();
  profile.education = [
    { id: 'edu-1', school: '学校 A', major: '专业 A', degree: '本科', startDate: '', endDate: '' },
    { id: 'edu-2', school: '学校 B', major: '专业 B', degree: '硕士', startDate: '', endDate: '' },
  ];
  const calls: Array<[string, string]> = [];
  const filler = new FormFiller();
  (filler as unknown as {
    fillField: (element: HTMLInputElement, value: string) => Promise<boolean>;
  }).fillField = async (element, value) => {
    calls.push([element.id, value]);
    return true;
  };
  const element = (id: string) => ({ id }) as HTMLInputElement;

  await filler.fillForm([
    { element: element('row-1-school'), fieldType: FieldType.SCHOOL, confidence: 1, rowIndex: 1 },
    { element: element('row-0-major'), fieldType: FieldType.MAJOR, confidence: 1, rowIndex: 0 },
    { element: element('row-1-degree'), fieldType: FieldType.DEGREE, confidence: 1, rowIndex: 1 },
    { element: element('row-0-school'), fieldType: FieldType.SCHOOL, confidence: 1, rowIndex: 0 },
  ], profile);

  assert.deepEqual(calls, [
    ['row-1-school', '学校 B'],
    ['row-0-major', '专业 A'],
    ['row-1-degree', '硕士'],
    ['row-0-school', '学校 A'],
  ]);
});

type AwardTreeNode = {
  parentElement: AwardTreeNode | null;
  children: AwardTreeNode[];
  id?: string;
  tagName?: string;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): AwardTreeNode | null;
  querySelectorAll(selector: string): AwardTreeNode[];
  contains(node: AwardTreeNode): boolean;
};

function createAwardTreeNode(
  attrs: Record<string, string> = {},
  id?: string,
  tagName?: string,
): AwardTreeNode {
  return {
    parentElement: null, children: [], attrs, id, tagName,
    getAttribute(name) { return this.attrs[name] ?? null; },
    hasAttribute(name) { return name in this.attrs; },
    querySelector() { return null; },
    querySelectorAll() {
      return this.children.flatMap(child => [
        ...(child.tagName && ['INPUT', 'TEXTAREA', 'SELECT'].includes(child.tagName) ? [child] : []),
        ...child.querySelectorAll(''),
      ]);
    },
    contains(target) {
      let current: AwardTreeNode | null = target;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
  };
}

function appendAwardNode(parent: AwardTreeNode, child: AwardTreeNode): AwardTreeNode {
  parent.children.push(child);
  child.parentElement = parent;
  return child;
}

function createAwardControl(
  module: AwardTreeNode,
  row: AwardTreeNode,
  id: string,
  dataIndex: string,
): HTMLInputElement {
  const wrapper = appendAwardNode(row, createAwardTreeNode({ 'data-index': dataIndex }));
  const control = appendAwardNode(wrapper, createAwardTreeNode({}, id, 'INPUT'));
  return Object.assign(control, {
    closest(selector: string) {
      let current: AwardTreeNode | null = control;
      while (current) {
        if (selector.includes('data-form-module') && current.attrs['data-form-module']) return current;
        if (selector.includes('data-repeat-item') && 'data-repeat-item' in current.attrs) return current;
        current = current.parentElement;
      }
      return null;
    },
  }) as unknown as HTMLInputElement;
}

function createPlainAwardControl(
  module: AwardTreeNode,
  row: AwardTreeNode,
  id: string,
): HTMLInputElement {
  const wrapper = appendAwardNode(row, createAwardTreeNode({ class: 'form-group' }));
  const control = appendAwardNode(wrapper, createAwardTreeNode({}, id, 'INPUT'));
  return Object.assign(control, {
    closest(selector: string) {
      let current: AwardTreeNode | null = control;
      while (current) {
        if (selector.includes('data-form-module') && current.attrs['data-form-module']) return current;
        current = current.parentElement;
      }
      return null;
    },
  }) as unknown as HTMLInputElement;
}

async function captureAwardFill(
  fields: Array<{ element: HTMLInputElement; fieldType: FieldType; confidence: number }>,
  awards: ReturnType<typeof createEmptyUserProfile>['awards'],
): Promise<Array<[string, string]>> {
  const profile = createEmptyUserProfile();
  profile.awards = awards;
  const calls: Array<[string, string]> = [];
  const filler = new FormFiller();
  (filler as unknown as { fillField: (element: HTMLInputElement, value: string) => Promise<boolean> }).fillField = async (element, value) => {
    calls.push([element.id, value]);
    return true;
  };
  await filler.fillForm(fields, profile);
  return calls;
}

test('single award row shares one index across four field wrappers', async () => {
  const module = createAwardTreeNode({ 'data-form-module': 'awards' });
  const list = appendAwardNode(module, createAwardTreeNode());
  const row = appendAwardNode(list, createAwardTreeNode());
  const fields = [
    { element: createAwardControl(module, row, 'single-name', '0'), fieldType: FieldType.AWARD_NAME, confidence: 1 },
    { element: createAwardControl(module, row, 'single-role', '1'), fieldType: FieldType.AWARD_ROLE, confidence: 1 },
    { element: createAwardControl(module, row, 'single-date', '2'), fieldType: FieldType.AWARD_DATE, confidence: 1 },
    { element: createAwardControl(module, row, 'single-description', '3'), fieldType: FieldType.AWARD_DESCRIPTION, confidence: 1 },
  ];

  const calls = await captureAwardFill(fields, [
    { id: 'a1', name: '一等奖', role: '负责人', date: '2026-06', description: '详细描述' },
  ]);

  assert.deepEqual(calls, [
    ['single-name', '一等奖'],
    ['single-role', '负责人'],
    ['single-date', '2026-06'],
    ['single-description', '详细描述'],
  ]);
});

test('award rows directly under module keep separate shared indexes', async () => {
  const module = createAwardTreeNode({ 'data-form-module': 'awards' });
  const row1 = appendAwardNode(module, createAwardTreeNode());
  const row2 = appendAwardNode(module, createAwardTreeNode());
  const fields = [
    { element: createAwardControl(module, row1, 'row1-name', '0'), fieldType: FieldType.AWARD_NAME, confidence: 1 },
    { element: createAwardControl(module, row1, 'row1-role', '1'), fieldType: FieldType.AWARD_ROLE, confidence: 1 },
    { element: createAwardControl(module, row2, 'row2-name', '0'), fieldType: FieldType.AWARD_NAME, confidence: 1 },
    { element: createAwardControl(module, row2, 'row2-role', '1'), fieldType: FieldType.AWARD_ROLE, confidence: 1 },
  ];

  const calls = await captureAwardFill(fields, [
    { id: 'a1', name: '一等奖', role: '负责人', date: '', description: '' },
    { id: 'a2', name: '二等奖', role: '核心成员', date: '', description: '' },
  ]);

  assert.deepEqual(calls, [
    ['row1-name', '一等奖'],
    ['row1-role', '负责人'],
    ['row2-name', '二等奖'],
    ['row2-role', '核心成员'],
  ]);
});

test('sparse sibling award rows keep indexes when each has one detected field', async () => {
  const module = createAwardTreeNode({ 'data-form-module': 'awards' });
  const list = appendAwardNode(module, createAwardTreeNode());
  const row1 = appendAwardNode(list, createAwardTreeNode());
  const row2 = appendAwardNode(list, createAwardTreeNode());
  const fields = [
    { element: createAwardControl(module, row1, 'sparse-row1-name', '0'), fieldType: FieldType.AWARD_NAME, confidence: 1 },
    { element: createAwardControl(module, row2, 'sparse-row2-role', '0'), fieldType: FieldType.AWARD_ROLE, confidence: 1 },
  ];

  const calls = await captureAwardFill(fields, [
    { id: 'a1', name: '一等奖', role: '', date: '', description: '' },
    { id: 'a2', name: '二等奖', role: '核心成员', date: '', description: '' },
  ]);

  assert.deepEqual(calls, [
    ['sparse-row1-name', '一等奖'],
    ['sparse-row2-role', '核心成员'],
  ]);
});


test('plain form-group wrappers in one award row share index zero', async () => {
  const module = createAwardTreeNode({ 'data-form-module': 'awards' });
  const row = appendAwardNode(module, createAwardTreeNode({ class: 'award-record' }));
  const fields = [
    { element: createPlainAwardControl(module, row, 'plain-name'), fieldType: FieldType.AWARD_NAME, confidence: 1 },
    { element: createPlainAwardControl(module, row, 'plain-role'), fieldType: FieldType.AWARD_ROLE, confidence: 1 },
    { element: createPlainAwardControl(module, row, 'plain-date'), fieldType: FieldType.AWARD_DATE, confidence: 1 },
    { element: createPlainAwardControl(module, row, 'plain-description'), fieldType: FieldType.AWARD_DESCRIPTION, confidence: 1 },
  ];
  const calls = await captureAwardFill(fields, [
    { id: 'a1', name: '一等奖', role: '负责人', date: '2026-06', description: '详细描述' },
  ]);

  assert.deepEqual(calls, [
    ['plain-name', '一等奖'],
    ['plain-role', '负责人'],
    ['plain-date', '2026-06'],
    ['plain-description', '详细描述'],
  ]);
});

test('two plain form-group award rows use indexes zero and one', async () => {
  const module = createAwardTreeNode({ 'data-form-module': 'awards' });
  const row1 = appendAwardNode(module, createAwardTreeNode({ class: 'award-record' }));
  const row2 = appendAwardNode(module, createAwardTreeNode({ class: 'award-record' }));
  const fields = [
    { element: createPlainAwardControl(module, row1, 'plain-row1-name'), fieldType: FieldType.AWARD_NAME, confidence: 1 },
    { element: createPlainAwardControl(module, row1, 'plain-row1-role'), fieldType: FieldType.AWARD_ROLE, confidence: 1 },
    { element: createPlainAwardControl(module, row2, 'plain-row2-name'), fieldType: FieldType.AWARD_NAME, confidence: 1 },
    { element: createPlainAwardControl(module, row2, 'plain-row2-role'), fieldType: FieldType.AWARD_ROLE, confidence: 1 },
  ];
  const calls = await captureAwardFill(fields, [
    { id: 'a1', name: '一等奖', role: '负责人', date: '', description: '' },
    { id: 'a2', name: '二等奖', role: '核心成员', date: '', description: '' },
  ]);

  assert.deepEqual(calls, [
    ['plain-row1-name', '一等奖'],
    ['plain-row1-role', '负责人'],
    ['plain-row2-name', '二等奖'],
    ['plain-row2-role', '核心成员'],
  ]);
});
