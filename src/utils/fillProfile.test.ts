import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyUserProfile } from '../shared/resumeProfiles.ts';
import { buildAuthoritativeFillProfile } from './fillProfile.ts';

test('旧资料缺失专业时从插件内已解析的简历正文安全补全', () => {
  const profile = createEmptyUserProfile();
  profile.education = [{
    id: 'edu-1', school: '示例大学', college: '示例学院',
    major: '', degree: '本科', startDate: '2019-09', endDate: '2023-07',
  }];
  profile.resume = {
    fileName: 'resume.pdf', fileData: 'data:application/pdf;base64,', fileType: 'pdf',
    uploadDate: '2026-09-04',
    parsedText: '教育背景\n2019-09 ~ 2023-07 示例大学 自动化（本科）',
  };

  const enriched = buildAuthoritativeFillProfile(profile);

  assert.equal(enriched.education[0].major, '自动化');
  assert.equal(enriched.education[0].college, '示例学院');
  assert.equal(profile.education[0].major, '');
});

test('插件资料已有值时不会被附件解析结果覆盖', () => {
  const profile = createEmptyUserProfile();
  profile.education = [{
    id: 'edu-1', school: '示例大学（985）', major: '人工确认专业', degree: '硕士',
    startDate: '2024-09', endDate: '2027-07',
  }];
  profile.resume = {
    fileName: 'resume.pdf', fileData: 'data:application/pdf;base64,', fileType: 'pdf',
    uploadDate: '2026-09-04',
    parsedText: '教育背景\n2024-09 ~ 2027-07 示例大学 附件专业（硕士）',
  };

  assert.equal(buildAuthoritativeFillProfile(profile).education[0].major, '人工确认专业');
});
