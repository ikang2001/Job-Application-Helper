import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeHostSpawnCommand } from './desktopNativeMailClient.ts';

test('Windows 批处理邮箱组件路径只由 spawn 转义，不额外嵌入引号', () => {
  const hostPath = 'C:\\Users\\candidate\\Desktop\\Job Helper\\mail-host.cmd';
  assert.deepEqual(nativeHostSpawnCommand(hostPath, 'win32', 'C:\\Windows\\System32\\cmd.exe'), {
    executable: 'C:\\Windows\\System32\\cmd.exe',
    arguments: ['/d', '/s', '/c', hostPath],
  });
});

test('可执行邮箱组件由系统直接启动', () => {
  const hostPath = 'C:\\Program Files\\Job Helper\\mail-host.exe';
  assert.deepEqual(nativeHostSpawnCommand(hostPath, 'win32'), {
    executable: hostPath,
    arguments: [],
  });
});
