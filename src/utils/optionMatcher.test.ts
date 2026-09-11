import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areEquivalentOptionValues,
  findBestMatchingOptionIndex,
  scoreOptionMatch,
} from './optionMatcher.ts';

test('统招全日制会选择网站的全日制选项而不是非全日制', () => {
  const options = ['请选择', '非全日制', '全日制'];
  assert.equal(findBestMatchingOptionIndex('统招全日制', options), 2);
  assert.equal(areEquivalentOptionValues('全日制', '统招全日制'), true);
  assert.equal(scoreOptionMatch('非全日制', '统招全日制'), 0);
});

test('统招非全日制不会因为包含全日制而误选全日制', () => {
  const options = ['全日制', '非全日制'];
  assert.equal(findBestMatchingOptionIndex('统招非全日制', options), 1);
  assert.equal(areEquivalentOptionValues('全日制', '统招非全日制'), false);
});

test('兼容常见学习方式同义文案', () => {
  assert.equal(areEquivalentOptionValues('普通高等教育', '统招全日制'), true);
  assert.equal(areEquivalentOptionValues('普通高校全日制', '全日制'), true);
  assert.equal(areEquivalentOptionValues('全国普通高等院校全日制', '统招全日制'), true);
  assert.equal(areEquivalentOptionValues('自学考试', '自考'), true);
  assert.equal(areEquivalentOptionValues('海外及港澳台', '境外教育'), true);
});

test('兼容学历、性别和带地区文字的国家区号选项', () => {
  assert.equal(areEquivalentOptionValues('硕士研究生', '硕士'), true);
  assert.equal(areEquivalentOptionValues('学士', '本科'), true);
  assert.equal(findBestMatchingOptionIndex('本科', ['专科', '学士', '硕士学位']), 1);
  assert.equal(areEquivalentOptionValues('男性', '男'), true);
  assert.equal(areEquivalentOptionValues('+86 中国大陆', '+86'), true);
  assert.equal(areEquivalentOptionValues('中国大陆 +86', '+86'), true);
  assert.equal(areEquivalentOptionValues('+852 中国香港', '+86'), false);
});

test('学校只选择完整名称，不把同名附属学院当作该大学', () => {
  assert.equal(findBestMatchingOptionIndex('西北工业大学', ['西北工业大学明德学院', '西北工业大学']), 1);
  assert.equal(findBestMatchingOptionIndex('西北工业大学', ['西北工业大学明德学院']), -1);
  assert.equal(areEquivalentOptionValues('西北工业大学', '西 北 工 业 大 学'), true);
});

test('兼容国家和地区选项的常见官方名称', () => {
  assert.equal(areEquivalentOptionValues('中华人民共和国', '中国'), true);
  assert.equal(areEquivalentOptionValues('中国大陆', '中国'), true);
  assert.equal(areEquivalentOptionValues('中国香港', '中国'), false);
});

test('普通数字和日期不会被国家区号规则误判', () => {
  assert.equal(areEquivalentOptionValues('2023-09', '2023-06'), false);
  assert.equal(areEquivalentOptionValues('2023 年 9 月', '2023 年 6 月'), false);
  assert.equal(areEquivalentOptionValues('+86 中国大陆', '86'), true);
});

test('兼容常见外语证书的中英文简称', () => {
  assert.equal(areEquivalentOptionValues('大学英语六级', 'CET-6'), true);
  assert.equal(areEquivalentOptionValues('英语专业八级', 'TEM8'), true);
  assert.equal(areEquivalentOptionValues('雅思 IELTS', 'IELTS'), true);
});

test('兼容其他常用下拉枚举的不同网站文案', () => {
  assert.equal(areEquivalentOptionValues('中华人民共和国居民身份证', '身份证'), true);
  assert.equal(areEquivalentOptionValues('中国共产党党员', '中共党员'), true);
  assert.equal(areEquivalentOptionValues('English', '英语'), true);
  assert.equal(areEquivalentOptionValues('合格', '通过'), true);
});

test('数字成绩会选择覆盖该成绩的真实区间选项', () => {
  const ranges = ['0~424', '425~499', '500~579', '580~649', '650~710'];
  assert.equal(findBestMatchingOptionIndex('463', ranges), 1);
  assert.equal(findBestMatchingOptionIndex('580分', ranges), 3);
  assert.equal(areEquivalentOptionValues('425～499', '463'), true);
  assert.equal(areEquivalentOptionValues('500~579', '463'), false);
});

test('无语义关系的普通选项不会被模糊命中', () => {
  assert.equal(findBestMatchingOptionIndex('统招全日制', ['定向', '委培']), -1);
  assert.equal(areEquivalentOptionValues('机器人学院', '机器人工程'), false);
});
