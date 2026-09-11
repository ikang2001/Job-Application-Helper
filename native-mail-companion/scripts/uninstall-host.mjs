import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HOST_NAME = 'com.job_application_helper.mail';
const browser = readArgument('--browser') || 'chrome';
if (!['chrome', 'edge'].includes(browser)) throw new Error('--browser 只支持 chrome 或 edge');

const manifestPath = join(nativeManifestDirectory(browser), `${HOST_NAME}.json`);
await rm(manifestPath, { force: true });

if (process.platform === 'win32') {
  const registryRoot = browser === 'edge'
    ? 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts'
    : 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts';
  spawnSync('reg.exe', ['DELETE', `${registryRoot}\\${HOST_NAME}`, '/f'], {
    stdio: 'ignore',
    shell: false,
  });
}

process.stdout.write(`Native Mail host 已卸载：${manifestPath}\n`);

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
