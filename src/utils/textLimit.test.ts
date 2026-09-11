import assert from 'node:assert/strict';
import test from 'node:test';
import { findTextLengthLimit, truncateToTextLength } from './textLimit.ts';

test('uses a control maxlength before surrounding text hints', () => {
  assert.equal(findTextLengthLimit(50, '当前 80 / 100，最多可输入100个字'), 50);
});

test('recognizes common long-text counters without treating dates as limits', () => {
  assert.equal(findTextLengthLimit(-1, '工作描述 1341 / 1000 最多可输入1000个字'), 1000);
  assert.equal(findTextLengthLimit(-1, '最多可输入 800 个字符'), 800);
  assert.equal(findTextLengthLimit(-1, '学习时间 2023/09 至 2026/06'), null);
});

test('truncates only values longer than the accepted limit', () => {
  assert.equal(truncateToTextLength('abcdef', 4), 'abcd');
  assert.equal(truncateToTextLength('abc', 4), 'abc');
  assert.equal(truncateToTextLength('abc', null), 'abc');
});
