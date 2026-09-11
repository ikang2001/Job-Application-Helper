import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryPath = resolve(projectDir, 'dist', 'index.js');

try {
  await access(entryPath, constants.R_OK);
} catch {
  throw new Error(`Native host 构建入口不存在：${entryPath}`);
}
