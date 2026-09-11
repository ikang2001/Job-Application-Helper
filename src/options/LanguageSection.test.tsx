import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { LanguageInfo } from '../shared/types.ts';
import { LanguageSection } from './LanguageSection.tsx';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('外语能力提供语种、证书和等级三个独立字段', async () => {
  const items: LanguageInfo[] = [{
    id: 'language-1',
    language: '英语',
    certificate: '大学英语六级',
    level: '通过',
  }];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LanguageSection items={items} onChange={() => {}} />);
  });

  const text = JSON.stringify(renderer.toJSON());
  assert.match(text, /外语语种/);
  assert.match(text, /证书 \/ 考试类型/);
  assert.match(text, /等级 \/ 成绩/);
  assert.match(text, /大学英语六级/);
});

test('新增外语能力生成可保存的空记录', async () => {
  let current: LanguageInfo[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LanguageSection items={current} onChange={next => { current = next; }} />,
    );
  });
  const add = renderer.root.findAllByType('button')
    .find(button => button.children.join('') === '添加外语能力');
  await act(async () => { add?.props.onClick(); });

  assert.equal(current.length, 1);
  assert.match(current[0].id, /.+/);
  assert.deepEqual({ ...current[0], id: '<id>' }, {
    id: '<id>',
    language: '',
    certificate: '',
    level: '',
  });
});
