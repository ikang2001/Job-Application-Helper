import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = resolve(desktopRoot, '../release/desktop');
const entries = await readdir(releaseDirectory, { withFileTypes: true });
const packageDocument = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
const installerName = `job-application-helper-desktop-${packageDocument.version}-setup.exe`;
if (!entries.some(entry => entry.isFile() && entry.name === installerName)) {
  throw new Error(`未找到当前版本桌面端安装包：${installerName}`);
}
const installerPath = join(releaseDirectory, installerName);
const checksum = createHash('sha256').update(await readFile(installerPath)).digest('hex');
await writeFile(`${installerPath}.sha256`, `${checksum}  ${installerName}\n`, 'utf8');
console.log(`桌面端安装包：${installerPath}`);
console.log(`SHA-256：${checksum}`);
