import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  VisualRegionFillMappingResult,
  VisualRegionFillPayload,
  VisualRegionFillResult,
  UserProfile,
} from '../../shared/types.ts';
import { buildLLMProfileContext, buildResumeParsingPrompt, buildSectionFillPrompt, buildVisualRegionFillPrompt } from './prompts.ts';
import {
  parseVisualRegionFillResponse,
  validateVisualRegionMappings,
} from './visualRegionFill.ts';

function createPayload(): VisualRegionFillPayload {
  return {
    requestId: 'req-1',
    domain: 'jobs.bytedance.com',
    image: {
      base64: 'ZmFrZQ==',
      mimeType: 'image/png',
      width: 800,
      height: 400,
    },
    controls: [{
      controlId: 'ctrl-degree',
      tagName: 'select',
      label: '学历',
      name: 'degree',
      placeholder: '',
      options: ['本科', '硕士'],
      rect: { left: 10, top: 10, width: 120, height: 36 },
      contextText: '教育经历 学历',
    }],
    region: {
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    },
  };
}

function createProfile(): UserProfile {
  return {
    personal: { name: '张三', gender: '', birthDate: '', phone: '', email: '' },
    education: [{
      id: 'edu-1',
      school: 'A',
      major: 'B',
      degree: '硕士',
      startDate: '2022-09',
      endDate: '2025-06',
    }],
    experience: [],
    projects: [],
    awards: [{ id: 'award-1', name: '优秀毕业生', role: '负责人', date: '2026-06', description: '详细描述' }],
    customInformation: [],
    skills: [],
    certifications: [],
  };
}

test('视觉补填 prompt 包含图片 block 与只允许输出已有 controlId 的规则', () => {
  const prompt = buildVisualRegionFillPrompt(createPayload(), createProfile());

  assert.match(prompt.system, /只能输出已有 controlId/);
  assert.equal(prompt.userParts.length, 2);
  assert.deepEqual(prompt.userParts[1], {
    type: 'image',
    mimeType: 'image/png',
    data: 'ZmFrZQ==',
  });
});

test('整页 AI 填充按确定语义和重复行号约束组合字段', () => {
  const prompt = buildSectionFillPrompt({
    requestId: 'request-1',
    section: 'personal',
    domain: 'jobs.example.com',
    fields: [{
      index: 0,
      rowIndex: 0,
      name: 'phoneCode',
      label: '手机号 国家区号',
      semanticType: 'phoneCountryCode',
      type: 'combobox',
      options: [],
      context: '基本信息 手机号',
    }],
  }, createProfile());

  assert.match(prompt.system, /semanticType/);
  assert.match(prompt.system, /phoneCountryCode 只能填写国家区号/);
  assert.match(prompt.system, /school、countryRegion、schoolLocation、college、major、degree、educationType/);
  assert.match(prompt.system, /"mappings"/);
  assert.match(prompt.system, /紧急联系人/);
  assert.match(prompt.user, /"semanticType": "phoneCountryCode"/);
});

test('视觉补填 prompt 不允许无图输入', () => {
  const payloadWithoutImage = {
    ...createPayload(),
    image: undefined,
  } as unknown as VisualRegionFillPayload;

  assert.throws(
    () => buildVisualRegionFillPrompt(payloadWithoutImage, createProfile()),
    /缺少视觉截图输入/,
  );
});

test('过滤不存在 controlId、空值和不在 options 中的结果', () => {
  const payload = createPayload();

  const mappings = validateVisualRegionMappings([
    {
      controlId: 'ctrl-degree',
      fieldMeaning: '学历',
      matchedProfilePath: 'education.0.degree',
      value: '硕士',
    },
    {
      controlId: 'ghost',
      fieldMeaning: '学历',
      matchedProfilePath: 'education.0.degree',
      value: '硕士',
    },
    {
      controlId: 'ctrl-degree',
      fieldMeaning: '学历',
      matchedProfilePath: 'education.0.degree',
      value: '',
    },
    {
      controlId: 'ctrl-degree',
      fieldMeaning: '学历',
      matchedProfilePath: 'education.0.degree',
      value: '博士',
    },
  ], payload, createProfile());

  assert.deepEqual(mappings, [{
    controlId: 'ctrl-degree',
    fieldMeaning: '学历',
    matchedProfilePath: 'education.0.degree',
    value: '硕士',
  }]);
});

test('视觉补填把资料同义值解析为控件的真实下拉选项', () => {
  const payload = createPayload();
  payload.controls[0].semanticType = 'educationType';
  payload.controls[0].options = ['非全日制', '全日制'];
  const profile = createProfile();
  profile.education[0].educationType = '统招全日制';

  const mappings = validateVisualRegionMappings([{
    controlId: 'ctrl-degree',
    fieldMeaning: '培养方式',
    matchedProfilePath: 'education.0.educationType',
    value: '统招全日制',
  }], payload, profile);

  assert.deepEqual(mappings, [{
    controlId: 'ctrl-degree',
    fieldMeaning: '培养方式',
    matchedProfilePath: 'education.0.educationType',
    value: '全日制',
  }]);
});

test('视觉补填不把主修专业复用到第二专业', () => {
  const payload = createPayload();
  payload.controls[0].label = '第二专业';
  payload.controls[0].semanticType = 'major';
  payload.controls[0].options = [];

  const mappings = validateVisualRegionMappings([{
    controlId: 'ctrl-degree',
    fieldMeaning: '第二专业',
    matchedProfilePath: 'education.0.major',
    value: 'B',
  }], payload, createProfile());

  assert.deepEqual(mappings, []);
});

test('解析模型 JSON 后返回校验前的 mappings', () => {
  const result: VisualRegionFillMappingResult = parseVisualRegionFillResponse(`{
    "mappings": [
      {
        "controlId": "ctrl-degree",
        "fieldMeaning": "学历",
        "matchedProfilePath": "education.0.degree",
        "value": "硕士"
      }
    ]
  }`);

  assert.deepEqual(result, {
    mappings: [{
      controlId: 'ctrl-degree',
      fieldMeaning: '学历',
      matchedProfilePath: 'education.0.degree',
      value: '硕士',
    }],
  });
});

test('旧的聚焦字段结果协议仍要求 value', () => {
  const legacyResult: VisualRegionFillResult = {
    value: '硕士',
    confidence: 0.9,
    model: 'test-model',
  };

  assert.equal(legacyResult.value, '硕士');
});


test('AI prompt 输出 awards schema 且不含废弃字段', () => {
  const prompt = buildResumeParsingPrompt('简历原文');

  assert.match(prompt.system, /awards/);
  assert.match(prompt.system, /名称/);
  assert.match(prompt.system, /角色/);
  assert.match(prompt.system, /时间/);
  assert.match(prompt.system, /描述/);
  assert.doesNotMatch(prompt.system, /achievements|technologies/);
});

test('表单 AI 资料投影不包含简历附件或未请求的敏感联系方式', () => {
  const profile = createProfile();
  profile.personal.idCard = 'secret-id';
  profile.personal.phone = '13800000000';
  profile.personal.email = 'candidate@example.com';
  profile.resume = {
    fileName: 'resume.pdf',
    fileData: 'data:application/pdf;base64,SECRET',
    fileType: 'pdf',
    parsedText: '完整简历正文',
    uploadDate: '2026-09-03T00:00:00.000Z',
  };

  const serialized = JSON.stringify(buildLLMProfileContext(profile, '学校和专业'));
  assert.doesNotMatch(serialized, /SECRET|完整简历正文|secret-id|13800000000|candidate@example\.com/);
  assert.doesNotMatch(serialized, /resume\.pdf/);
});

test('当前字段明确需要时才向 AI 提供对应敏感联系方式', () => {
  const profile = createProfile();
  profile.personal.idCard = 'secret-id';
  profile.personal.phone = '13800000000';
  profile.personal.email = 'candidate@example.com';

  const context = buildLLMProfileContext(profile, '身份证号码、手机和 Email');
  assert.equal(context.personal.idCard, 'secret-id');
  assert.equal(context.personal.phone, '13800000000');
  assert.equal(context.personal.email, 'candidate@example.com');
});
