import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('WebDAV 同步文案明确说明投递记录会额外保留 CSV 副本', () => {
  const source = readFileSync(new URL('./DataSyncSettings.tsx', import.meta.url), 'utf8');
  assert.match(source, /投递记录会额外保留一份 CSV 副本/);
});

test('本地 JSON 备份文案明确包含投递记录', () => {
  const source = readFileSync(new URL('./DataSyncSettings.tsx', import.meta.url), 'utf8');
  assert.match(source, /导入或导出全部简历资料、简历原文件、AI 配置、通用设置和投递记录。/);
});

test('立即同步按钮不再要求启用自动同步', () => {
  const source = readFileSync(new URL('./DataSyncSettings.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /disabled=\{busy !== null \|\| !config\.enabled\}/);
  assert.match(source, /disabled=\{busy !== null\}/);
});

test('立即同步成功后显示明确成功提示', () => {
  const source = readFileSync(new URL('./DataSyncSettings.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /操作未完成，请查看下方同步状态/);
  assert.match(source, /同步完成/);
});

test('本机桌面同步无需 WebDAV 且明确敏感数据边界', () => {
  const source = readFileSync(new URL('./DataSyncSettings.tsx', import.meta.url), 'utf8');
  assert.match(source, /无需导入文件或配置 WebDAV/);
  assert.match(source, /API Key、邮箱授权码、WebDAV 密码、简历文件和其他设置不会写入共享文件/);
  assert.match(source, /SYNC_LOCAL_DESKTOP_NOW/);
});
