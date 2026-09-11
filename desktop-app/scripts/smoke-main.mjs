import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const capturePath = resolve(desktopRoot, '../.artifacts/desktop-main-smoke.png');
const environment = { ...process.env, JOB_HELPER_DESKTOP_SMOKE_CAPTURE: capturePath };
delete environment.ELECTRON_RUN_AS_NODE;

const exitCode = await new Promise((resolvePromise, reject) => {
  const child = spawn(electronPath, [desktopRoot], {
    cwd: desktopRoot,
    env: environment,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', code => resolvePromise(code));
});

if (exitCode !== 0) throw new Error(`Electron 主进程烟测退出码：${exitCode}`);
if ((await stat(capturePath)).size === 0) throw new Error('Electron 主进程没有生成有效截图');
console.log(capturePath);
