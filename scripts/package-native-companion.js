import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const companionDir = join(projectRoot, 'native-mail-companion');
const releaseDir = join(projectRoot, 'release');
const archiveName = 'job-application-helper-native-mail-companion.zip';
const archivePath = join(releaseDir, archiveName);
const checksumPath = `${archivePath}.sha256`;
const tempRoot = resolve(tmpdir());
const stageDir = mkdtempSync(join(tempRoot, 'job-application-helper-native-'));

function fail(message) {
  throw new Error(message);
}

function requirePath(path, message) {
  if (!existsSync(path)) fail(message);
}

function copyRequiredFile(relativePath) {
  const source = join(companionDir, ...relativePath.split('/'));
  const destination = join(stageDir, ...relativePath.split('/'));
  requirePath(source, `Native companion 缺少文件：${relativePath}`);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function copyRequiredDirectory(relativePath) {
  const source = join(companionDir, relativePath);
  const destination = join(stageDir, relativePath);
  requirePath(source, `Native companion 缺少目录：${relativePath}`);
  cpSync(source, destination, { recursive: true });
}

function tryArchive(command, args) {
  return spawnSync(command, args, { cwd: stageDir, stdio: 'inherit', shell: false }).status === 0;
}

function tryPowerShell() {
  const command = [
    'Compress-Archive',
    '-Path', `"${join(stageDir, '*')}"`,
    '-DestinationPath', `"${archivePath}"`,
    '-Force',
  ].join(' ');
  return spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { cwd: projectRoot, stdio: 'inherit', shell: false },
  ).status === 0;
}

function listArchiveEntries() {
  const result = spawnSync('tar', ['-tf', archivePath], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) fail('无法读取 Native companion 压缩包');
  return result.stdout
    .split(/\r?\n/)
    .map(entry => entry.replaceAll('\\', '/').replace(/^\.\/?/, ''))
    .filter(Boolean);
}

function cleanStage() {
  const relativeStage = relative(tempRoot, stageDir);
  if (!relativeStage || relativeStage.startsWith('..') || isAbsolute(relativeStage)) {
    fail(`拒绝清理非预期临时目录：${stageDir}`);
  }
  rmSync(stageDir, { recursive: true, force: true });
}

try {
  mkdirSync(releaseDir, { recursive: true });
  rmSync(archivePath, { force: true });
  rmSync(checksumPath, { force: true });

  for (const file of ['package.json', 'package-lock.json', 'README.md', 'tsconfig.json']) {
    copyRequiredFile(file);
  }
  for (const directory of ['src', 'scripts', 'dist']) copyRequiredDirectory(directory);

  const entryPath = join(stageDir, 'dist', 'index.js');
  requirePath(entryPath, 'Native companion 构建入口 dist/index.js 不存在');
  if (!statSync(entryPath).isFile()) fail('Native companion 构建入口不是文件');

  const packed = tryArchive('zip', ['-r', archivePath, '.', '-x', '*.DS_Store', '__MACOSX/*'])
    || tryArchive('tar', ['-a', '-c', '-f', archivePath, '.'])
    || tryPowerShell();
  if (!packed) fail('Native companion 打包失败：没有可用的 ZIP 工具');

  const entries = listArchiveEntries();
  const requiredEntries = [
    'package.json',
    'package-lock.json',
    'README.md',
    'tsconfig.json',
    'dist/index.js',
    'scripts/install-host.mjs',
    'scripts/uninstall-host.mjs',
  ];
  const missing = requiredEntries.filter(entry => !entries.includes(entry));
  if (missing.length > 0) fail(`Native companion 压缩包缺少：${missing.join(', ')}`);
  if (entries.some(entry => entry === 'node_modules' || entry.startsWith('node_modules/'))) {
    fail('Native companion 压缩包不得包含 node_modules');
  }

  const checksum = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  writeFileSync(checksumPath, `${checksum}  ${archiveName}\n`, 'utf8');
  console.log(`Native companion 打包完成：${archivePath}`);
  console.log(`SHA-256：${checksum}`);
} finally {
  cleanStage();
}
