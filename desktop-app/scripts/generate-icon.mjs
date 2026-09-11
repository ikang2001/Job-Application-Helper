import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(desktopRoot, 'build/icon.png');
const sourcePath = resolve(desktopRoot, '../public/icons/job-application-autofill-icon.svg');
const environment = {
  ...process.env,
  JOB_HELPER_ICON_SOURCE: sourcePath,
  JOB_HELPER_ICON_OUTPUT: outputPath,
};
delete environment.ELECTRON_RUN_AS_NODE;

const exitCode = await new Promise((resolvePromise, reject) => {
  const child = spawn(electronPath, [resolve(desktopRoot, 'scripts/icon-renderer.mjs')], {
    cwd: desktopRoot,
    env: environment,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', code => resolvePromise(code));
});

if (exitCode !== 0) throw new Error(`桌面图标生成失败，退出码：${exitCode}`);
if ((await stat(outputPath)).size === 0) throw new Error('桌面图标文件为空');
console.log(outputPath);
