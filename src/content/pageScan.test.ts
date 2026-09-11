import assert from 'node:assert/strict';
import test from 'node:test';
import { groupPageScanFields, type PageScanField } from './pageScan.ts';
import { FieldMatcher } from '../utils/fieldMatcher.ts';
import { FieldType } from '../shared/types.ts';

test('groups page scan fields by section while preserving field order and metadata', () => {
  const fields: PageScanField[] = [
    {
      index: 0,
      rowIndex: 0,
      section: 'personal',
      name: 'phone',
      label: '手机号码',
      type: 'input',
      options: [],
      context: '基本信息 手机号码',
    },
    {
      index: 1,
      rowIndex: 0,
      section: 'education',
      name: 'school',
      label: '学校名称',
      type: 'input',
      options: [],
      context: '教育经历 学校名称',
    },
    {
      index: 2,
      rowIndex: 0,
      section: 'personal',
      name: 'email',
      label: '邮箱',
      type: 'input',
      options: [],
      context: '基本信息 邮箱',
    },
  ];

  const grouped = groupPageScanFields(fields);

  assert.deepEqual(grouped.map(group => group.section), ['personal', 'education']);
  assert.deepEqual(grouped[0].fields.map(field => field.index), [0, 2]);
  assert.equal(grouped[0].fields[1].label, '邮箱');
  assert.deepEqual(grouped[1].fields.map(field => field.index), [1]);
});

test('matches award field semantics without reviving removed legacy fields', () => {
  const match = (labelText: string) => FieldMatcher.matchFieldType('', '', '', labelText, 'text', '');

  assert.equal(match('奖项名称').fieldType, FieldType.AWARD_NAME);
  assert.equal(match('获奖角色').fieldType, FieldType.AWARD_ROLE);
  assert.equal(match('获奖时间').fieldType, FieldType.AWARD_DATE);
  assert.equal(match('奖项描述').fieldType, FieldType.AWARD_DESCRIPTION);
  assert.equal(match('项目技术栈').fieldType, FieldType.UNKNOWN);
  assert.equal(match('实习成果').fieldType, FieldType.UNKNOWN);
  assert.equal(match('项目描述').fieldType, FieldType.PROJECT_DESCRIPTION);
});

test('distinguishes common compound controls before generic phone, identity and language matches', () => {
  const match = (name: string, label: string) => FieldMatcher.matchFieldType(
    name, '', '', label, 'text', '',
  ).fieldType;

  assert.equal(match('phoneCode', '手机号码 国家区号'), FieldType.PHONE_COUNTRY_CODE);
  assert.equal(match('phone', '手机号码'), FieldType.PHONE);
  assert.equal(match('idType', '证件号码 证件类型'), FieldType.ID_TYPE);
  assert.equal(match('idNumber', '证件号码'), FieldType.ID_CARD);
  assert.equal(match('languageName', '外语类型 外语语种'), FieldType.LANGUAGE);
  assert.equal(match('languageCertificate', '外语类型 考试类型'), FieldType.LANGUAGE_CERTIFICATE);
  assert.equal(match('languageLevel', '外语等级'), FieldType.LANGUAGE_LEVEL);
});

test('uses control position for generic phone and identity compound fields', () => {
  const matchCompound = (labelText: string) => {
    const label = { textContent: labelText };
    const fieldContainer = {
      getAttribute: () => '',
      querySelector: () => label,
      querySelectorAll: () => controls,
    };
    const createControl = (picker: boolean) => ({
      id: '',
      tagName: 'INPUT',
      previousElementSibling: null,
      getAttribute: () => '',
      closest: (selector: string) => {
        if (selector.includes('.md-form-item')) return fieldContainer;
        if (picker && selector.includes('.ihr_base_picker')) return { className: 'generic-picker' };
        return null;
      },
    }) as unknown as HTMLInputElement;
    const controls = [createControl(true), createControl(false)];

    return controls.map(control => {
      const identifiers = FieldMatcher.extractIdentifiers(control);
      return FieldMatcher.matchFieldType(
        identifiers.name,
        identifiers.id,
        identifiers.placeholder,
        identifiers.labelText,
        identifiers.type,
        identifiers.autocomplete,
      ).fieldType;
    });
  };

  assert.deepEqual(matchCompound('证件号码'), [FieldType.ID_TYPE, FieldType.ID_CARD]);
  assert.deepEqual(matchCompound('手机号码'), [FieldType.PHONE_COUNTRY_CODE, FieldType.PHONE]);
});

test('MDesign 外语组合下拉按位置区分语种和证书', () => {
  const label = { textContent: '外语类型' };
  const fieldContainer = {
    getAttribute: () => '',
    querySelector: () => label,
    querySelectorAll: () => controls,
  };
  const languageGroup = { querySelectorAll: () => controls };
  const mdSelect = { className: 'md-select' };
  const createControl = () => ({
    id: '',
    tagName: 'INPUT',
    previousElementSibling: null,
    getAttribute: () => '',
    closest: (selector: string) => {
      if (selector.includes('.md-form-item')) return fieldContainer;
      if (selector.includes('.code_group-select')) return languageGroup;
      if (selector.includes('.md-select')) return mdSelect;
      return null;
    },
  }) as unknown as HTMLInputElement;
  const controls = [createControl(), createControl()];

  const matchedTypes = controls.map(control => {
    const identifiers = FieldMatcher.extractIdentifiers(control);
    return FieldMatcher.matchFieldType(
      identifiers.name,
      identifiers.id,
      identifiers.placeholder,
      identifiers.labelText,
      identifiers.type,
      identifiers.autocomplete,
    ).fieldType;
  });

  assert.deepEqual(matchedTypes, [FieldType.LANGUAGE, FieldType.LANGUAGE_CERTIFICATE]);
});

test('keeps native and other component-library field names compatible', () => {
  const match = (name: string, label: string, type = 'text') => FieldMatcher.matchFieldType(
    name, '', '', label, type, '',
  ).fieldType;

  assert.equal(match('candidate_email', '联系邮箱', 'email'), FieldType.EMAIL);
  assert.equal(match('learningType', '学习方式'), FieldType.EDUCATION_TYPE);
  assert.equal(match('schoolName', '学校名称'), FieldType.SCHOOL);
  assert.equal(match('majorName', '专业'), FieldType.MAJOR);
  assert.equal(match('education', '学历'), FieldType.DEGREE);
  assert.equal(match('country', '所属国家/地区 education-context'), FieldType.EDUCATION_COUNTRY);
  assert.equal(match('schoolLocation', '学校所在地 education-context'), FieldType.SCHOOL_LOCATION);
  assert.equal(match('nationalityName', '国籍/地区'), FieldType.NATIONALITY);
  assert.equal(match('nativePlace', '籍贯'), FieldType.HOMETOWN);
  assert.equal(match('areaCitizenship', ''), FieldType.NATIONALITY);
  assert.equal(match('englishLevel', ''), FieldType.LANGUAGE_CERTIFICATE);
  assert.equal(match('englishScore', ''), FieldType.LANGUAGE_LEVEL);
  assert.equal(match('faculty', '教育经历 education-context'), FieldType.COLLEGE);
});

test('prefers specific business identifiers over generic name suffixes', () => {
  const match = (name: string, label = '') => FieldMatcher.matchFieldType(
    name, '', '', label, 'text', '',
  ).fieldType;

  assert.equal(match('collegeName'), FieldType.COLLEGE);
  assert.equal(match('departmentName'), FieldType.COLLEGE);
  assert.equal(match('nationalityName'), FieldType.NATIONALITY);
  assert.equal(match('certificateName'), FieldType.UNKNOWN);
});

test('does not fill unsupported proxy-person fields with the candidate profile', () => {
  const match = (name: string, label: string) => FieldMatcher.matchFieldType(
    name, '', '', label, 'text', '',
  ).fieldType;

  assert.equal(match('namePinyin', '姓名拼音'), FieldType.UNKNOWN);
  assert.equal(match('surnamePinyin', '姓拼音'), FieldType.UNKNOWN);
  assert.equal(match('secondMajor', '第二专业'), FieldType.UNKNOWN);
  assert.equal(match('mentor', '导师 education-context 教育经历'), FieldType.UNKNOWN);
  assert.equal(match('emergencyPhone', '紧急联系人手机号'), FieldType.UNKNOWN);
  assert.equal(match('fatherCompany', '父亲工作单位'), FieldType.UNKNOWN);
});

test('只有教育模块上下文时不会把任意输入框误判成学校', () => {
  const match = (label: string) => FieldMatcher.matchFieldType(
    '', '', '', `${label} education-context 教育经历`, 'text', '',
  ).fieldType;

  assert.equal(match('专业'), FieldType.MAJOR);
  assert.equal(match('院系'), FieldType.COLLEGE);
  assert.equal(match('未知可选字段'), FieldType.UNKNOWN);
});

test('extracts repeated row index from generic data attributes and iHR-style classes', () => {
  const genericElement = {
    closest: () => ({
      getAttribute: (name: string) => name === 'data-repeat-index' ? '3' : null,
    }),
  } as unknown as HTMLInputElement;
  assert.equal(FieldMatcher.extractRowIndex(genericElement), 3);

  const classElement = {
    closest: () => ({
      getAttribute: (name: string) => name === 'class'
        ? 'form base ihr_recruit_resume-block-multiple_form-edu-2'
        : null,
    }),
  } as unknown as HTMLInputElement;
  assert.equal(FieldMatcher.extractRowIndex(classElement), 2);

  const arrayPathElement = {
    closest: () => null,
    getAttribute: (name: string) => name === 'name' ? 'education[4].school' : '',
  } as unknown as HTMLInputElement;
  assert.equal(FieldMatcher.extractRowIndex(arrayPathElement), 4);
});

test('generic award labels require award module context', () => {
  const match = (labelText: string) => FieldMatcher.matchFieldType('', '', '', labelText, 'text', '').fieldType;

  assert.notEqual(match('担任角色'), FieldType.AWARD_ROLE);
  assert.notEqual(match('获取时间'), FieldType.AWARD_DATE);
  assert.notEqual(match('详细描述'), FieldType.AWARD_DESCRIPTION);

  const fieldContainer = {
    getAttribute: () => '',
    querySelector: () => ({ textContent: '详细描述' }),
  };
  const awardModule = {
    textContent: '奖项 / 荣誉 详细描述',
    ownerDocument: null,
    getAttribute: (name: string) => name === 'data-form-module' ? 'awards' : null,
    querySelector: () => null,
  };
  const element = {
    id: '',
    getAttribute: () => '',
    closest: (selector: string) => selector.includes('applyFormModuleWrapper') ? awardModule : fieldContainer,
    previousElementSibling: null,
  } as unknown as HTMLInputElement;

  const identifiers = FieldMatcher.extractIdentifiers(element);
  assert.equal(FieldMatcher.matchFieldType(
    identifiers.name,
    identifiers.id,
    identifiers.placeholder,
    identifiers.labelText,
    identifiers.type,
    identifiers.autocomplete,
  ).fieldType, FieldType.AWARD_DESCRIPTION);
});

test('project module user content mentioning awards does not create award context', () => {
  const heading = { textContent: '项目经历' };
  const fieldContainer = {
    getAttribute: () => '',
    querySelector: () => ({ textContent: '详细描述' }),
  };
  const projectModule = {
    textContent: '项目经历 曾获奖并获得荣誉',
    getAttribute: () => '',
    querySelector: (selector: string) => selector.includes('heading') || selector.includes('h1') ? heading : null,
  };
  const element = {
    id: '',
    value: '曾获奖并获得荣誉',
    getAttribute: () => '',
    closest: (selector: string) => selector.includes('applyFormModuleWrapper') ? projectModule : fieldContainer,
    previousElementSibling: null,
  } as unknown as HTMLTextAreaElement;

  const identifiers = FieldMatcher.extractIdentifiers(element);
  assert.equal(FieldMatcher.matchFieldType(
    identifiers.name, identifiers.id, identifiers.placeholder, identifiers.labelText,
    identifiers.type, identifiers.autocomplete,
  ).fieldType, FieldType.PROJECT_DESCRIPTION);
});
