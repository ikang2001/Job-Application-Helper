import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HOST_NAME = 'com.job_application_helper.mail';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, '..');
const extensionId = readArgument('--extension-id');
const browser = readArgument('--browser') || 'chrome';

if (!/^[a-p]{32}$/.test(extensionId)) {
  throw new Error('请通过 --extension-id 提供 32 位 Chrome/Edge 扩展 ID');
}
if (!['chrome', 'edge'].includes(browser)) {
  throw new Error('--browser 只支持 chrome 或 edge');
}

const hostEntry = resolve(projectDir, 'dist', 'index.js');
const launcherDir = resolve(projectDir, 'generated');
await mkdir(launcherDir, { recursive: true });
const launcherPath = process.platform === 'win32'
  ? join(launcherDir, 'job-application-helper-mail-host.cmd')
  : join(launcherDir, 'job-application-helper-mail-host.sh');

if (process.platform === 'win32') {
  const content = `@echo off\r\n"${process.execPath}" "${hostEntry}"\r\n`;
  await writeFile(launcherPath, content, 'utf8');
} else {
  const content = `#!/bin/sh\nexec "${process.execPath}" "${hostEntry}"\n`;
  await writeFile(launcherPath, content, { encoding: 'utf8', mode: 0o755 });
  await chmod(launcherPath, 0o755);
}

const manifestDir = nativeManifestDirectory(browser);
await mkdir(manifestDir, { recursive: true });
const manifestPath = join(manifestDir, `${HOST_NAME}.json`);
await writeFile(manifestPath, JSON.stringify({
  name: HOST_NAME,
  description: 'Local IMAP and application-record bridge for Job-Application-Helper',
  path: launcherPath,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, 2), 'utf8');

if (process.platform === 'win32') {
  const registryRoot = browser === 'edge'
    ? 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts'
    : 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts';
  const result = spawnSync('reg.exe', [
    'ADD', `${registryRoot}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f',
  ], { stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error('写入 Native Messaging 注册表失败');
}

process.stdout.write(`Native Mail host 已安装：${manifestPath}\n`);

function readArgument(name) {
  const exact = process.argv.find(argument => argument.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

function nativeManifestDirectory(targetBrowser) {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || process.env.APPDATA || homedir(), 'JobApplicationHelper', 'NativeMessagingHosts');
  }
  if (process.platform === 'darwin') {
    return targetBrowser === 'edge'
      ? join(homedir(), 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts')
      : join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  }
  return targetBrowser === 'edge'
    ? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'microsoft-edge', 'NativeMessagingHosts')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'google-chrome', 'NativeMessagingHosts');
}
