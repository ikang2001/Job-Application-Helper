import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(projectDir, 'dist');

if (dirname(distDir) !== projectDir || basename(distDir) !== 'dist') {
  throw new Error(`拒绝清理非预期构建目录：${distDir}`);
}

await rm(distDir, { recursive: true, force: true });
