import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createPageFillTaskRunner } from './pageFillTask';

test('先确认启动并交还弹窗控制权，后执行填写，运行期间拒绝重复启动', async () => {
  const pending: Array<() => void> = [];
  const errors: unknown[] = [];
  const start = createPageFillTaskRunner(task => pending.push(task), error => errors.push(error));
  let calls = 0;
  const task = async () => { calls += 1; };
  assert.equal(start(task).success, true);
  assert.equal(calls, 0);
  assert.equal(start(task).success, false);
  pending.shift()?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(start(task).success, true);
  assert.deepEqual(errors, []);
});

test('填写失败也释放运行锁并报告异常，不留下永久忙碌状态', async () => {
  const pending: Array<() => void> = [];
  const errors: unknown[] = [];
  const error = new Error('测试拒绝');
  const start = createPageFillTaskRunner(task => pending.push(task), failure => errors.push(failure));
  start(async () => { throw error; });
  pending.shift()?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, [error]);
  assert.equal(start(async () => {}).success, true);
});

test('快速和 AI 填充入口都立即确认启动，旧 FILL_FORM 协议继续保留', () => {
  const content = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const taskRunner = readFileSync(new URL('./pageFillTask.ts', import.meta.url), 'utf8');
  const popup = readFileSync(new URL('../popup/App.tsx', import.meta.url), 'utf8');
  assert.match(content, /message\.type === 'START_QUICK_FILL' \|\| message\.type === 'START_AI_PAGE_FILL'/);
  assert.match(content, /sendResponse\(startPageFillTask\(/);
  assert.match(content, /message\.type === 'FILL_FORM'/);
  assert.match(taskRunner, /document\.hasFocus\(\)/);
  assert.match(popup, /type: 'START_QUICK_FILL'[\s\S]*?if \(response.success\) \{\s*window.close\(\)/);
});
