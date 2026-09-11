import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDescriptionText } from './descriptionText.ts';

test('合并简历版面硬换行但保留编号条目', () => {
  assert.equal(
    normalizeDescriptionText([
      '2，空间遥感目标检测实验智能诊断平台',
      '（1）工作介绍：参与搭建目标检测平台，已在团队内部上线，',
      '统一',
      '治理目标检测训练全链路资产，支持实验检索和版本对比。',
    ].join('\n')),
    '2，空间遥感目标检测实验智能诊断平台\n（1）工作介绍：参与搭建目标检测平台，已在团队内部上线，统一治理目标检测训练全链路资产，支持实验检索和版本对比。',
  );
});

test('清理空白行并正确处理英文断行', () => {
  assert.equal(
    normalizeDescriptionText('Built reliable\nAI systems.\n\n• 完成模型评测\n与上线'),
    'Built reliable AI systems.\n• 完成模型评测与上线',
  );
});

test('保留短项目标题与正文之间的换行', () => {
  assert.equal(
    normalizeDescriptionText('1，“千人千案”智能学习系统\n面向考研专业课复习场景研发。\n基于知识点权重动态生成计划。'),
    '1，“千人千案”智能学习系统\n面向考研专业课复习场景研发。基于知识点权重动态生成计划。',
  );
});
