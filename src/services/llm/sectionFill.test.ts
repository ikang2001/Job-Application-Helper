import assert from 'node:assert/strict';
import test from 'node:test';
import type { UserProfile } from '../../shared/types.ts';
import type { AIFillSectionPayload } from './prompts.ts';
import {
  parseSectionFillResponse,
  validateSectionFillMappings,
} from './sectionFill.ts';

function createProfile(): UserProfile {
  return {
    personal: {
      name: '张三',
      gender: '男',
      birthDate: '2002-05',
      phoneCountryCode: '+86',
      phone: '13800000000',
      email: 'candidate@example.com',
      nationality: '中国',
    },
    education: [{
      id: 'edu-1',
      school: '示例大学',
      educationType: '统招全日制',
      college: '计算机学院',
      major: '软件工程',
      degree: '硕士研究生',
      startDate: '2023-09',
      endDate: '2026-06',
    }],
    languages: [],
    experience: [],
    projects: [],
    awards: [],
    skills: [],
    certifications: [],
    customInformation: [],
  };
}

function createPayload(semanticType = 'unknown'): AIFillSectionPayload {
  return {
    requestId: 'request-1',
    section: 'education',
    domain: 'jobs.example.com',
    fields: [{
      index: 7,
      rowIndex: 0,
      name: 'collegeName',
      label: '院系名称',
      semanticType,
      type: 'input',
      options: [],
      context: '教育经历 院系名称',
    }],
  };
}

test('parses structured mappings even when a provider wraps JSON in prose', () => {
  const mappings = parseSectionFillResponse(
    '结果如下：\n```json\n{"mappings":[{"index":7,"semanticType":"college","value":"计算机学院"}]}\n```',
    createPayload(),
  );

  assert.deepEqual(mappings, [{
    index: 7,
    semanticType: 'college',
    value: '计算机学院',
  }]);
});

test('unknown local semantics require the model to declare a verifiable profile field', () => {
  const payload = createPayload();
  const result = validateSectionFillMappings([{
    index: 7,
    semanticType: 'college',
    value: '计算机学院',
  }], payload, createProfile());

  assert.deepEqual(result, { 7: '计算机学院' });
  assert.deepEqual(validateSectionFillMappings([{
    index: 7,
    semanticType: 'college',
    value: '模型编造的学院',
  }], payload, createProfile()), {});
});

test('authoritative local semantics cannot be changed by the model', () => {
  const payload = createPayload('school');
  const result = validateSectionFillMappings([{
    index: 7,
    semanticType: 'college',
    value: '计算机学院',
  }], payload, createProfile());

  assert.deepEqual(result, {});
});

test('AI cannot reuse primary profile values for unsupported pinyin or second-major fields', () => {
  const secondMajorPayload = createPayload();
  secondMajorPayload.fields[0].label = '第二专业';
  secondMajorPayload.fields[0].context = '教育经历 第二专业';
  assert.deepEqual(validateSectionFillMappings([{
    index: 7,
    semanticType: 'major',
    value: '软件工程',
  }], secondMajorPayload, createProfile()), {});

  const pinyinPayload = createPayload();
  pinyinPayload.fields[0].label = '姓拼音';
  pinyinPayload.fields[0].context = '基本信息 姓拼音';
  assert.deepEqual(validateSectionFillMappings([{
    index: 7,
    semanticType: 'name',
    value: '张三',
  }], pinyinPayload, createProfile()), {});
});

test('option values may adapt an equivalent profile degree but must exist in options', () => {
  const payload = createPayload('degree');
  payload.fields[0].options = ['本科', '硕士', '博士'];

  assert.deepEqual(validateSectionFillMappings([{
    index: 7,
    semanticType: 'degree',
    value: '硕士',
  }], payload, createProfile()), { 7: '硕士' });
  assert.deepEqual(validateSectionFillMappings([{
    index: 7,
    semanticType: 'degree',
    value: '硕士研究生',
  }], payload, createProfile()), { 7: '硕士' });
});

test('学习形式可把资料中的统招全日制安全映射为网站真实的全日制选项', () => {
  const payload = createPayload('educationType');
  payload.fields[0].options = ['请选择', '非全日制', '全日制'];

  assert.deepEqual(validateSectionFillMappings([{
    index: 7,
    semanticType: 'educationType',
    value: '统招全日制',
  }], payload, createProfile()), { 7: '全日制' });
  assert.deepEqual(validateSectionFillMappings([{
    index: 7,
    semanticType: 'educationType',
    value: '非全日制',
  }], payload, createProfile()), {});
});

test('AI 外语成绩也只能返回覆盖真实成绩的网页区间选项', () => {
  const profile = createProfile();
  profile.languages = [{
    id: 'language-1',
    language: '英语',
    certificate: 'CET-6',
    level: '463',
  }];
  const payload = createPayload('languageLevel');
  payload.section = 'languages';
  payload.fields[0].options = ['0~424', '425~499', '500~579', '580~649', '650~710'];

  assert.deepEqual(validateSectionFillMappings([{
    index: 7,
    semanticType: 'languageLevel',
    value: '463',
  }], payload, profile), { 7: '425~499' });
  assert.deepEqual(validateSectionFillMappings([{
    index: 7,
    semanticType: 'languageLevel',
    value: '500~579',
  }], payload, profile), {});
});

test('教育所在国家按教育行号映射且不与个人国籍串位', () => {
  const payload = createPayload('educationCountry');
  payload.fields[0].options = ['中国', '新加坡', '其他'];

  assert.deepEqual(validateSectionFillMappings([{
    index: 7,
    semanticType: 'educationCountry',
    value: '中国',
  }], payload, createProfile()), { 7: '中国' });
});

test('legacy string map remains usable for known fields but not unknown fields', () => {
  const knownPayload = createPayload('college');
  const legacy = parseSectionFillResponse('{"7":"计算机学院"}', knownPayload);
  assert.deepEqual(validateSectionFillMappings(legacy, knownPayload, createProfile()), {
    7: '计算机学院',
  });

  const unknownPayload = createPayload();
  const unsafeLegacy = parseSectionFillResponse('{"7":"计算机学院"}', unknownPayload);
  assert.deepEqual(validateSectionFillMappings(unsafeLegacy, unknownPayload, createProfile()), {});
});
