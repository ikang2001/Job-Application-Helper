import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = join(__dirname, '..');
const distDir = join(projectRoot, 'dist');
const releaseDir = join(projectRoot, 'release');
const unpackedReleaseDir = join(releaseDir, 'extension');
const zipFile = join(releaseDir, 'job-application-helper-extension.zip');
const checksumFile = `${zipFile}.sha256`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
  fail('未找到 dist/ 目录，请先运行 npm run build。');
}

if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true });
}

// Edge 调试通常直接加载 release/extension；每次打包都同步它，避免浏览器
// 继续运行旧的 dist 副本而让源码修复看起来没有生效。
if (existsSync(unpackedReleaseDir)) {
  rmSync(unpackedReleaseDir, { recursive: true, force: true });
}
cpSync(distDir, unpackedReleaseDir, { recursive: true });
console.log(`✓ 已同步未压缩扩展目录：${unpackedReleaseDir}`);

if (existsSync(zipFile)) {
  rmSync(zipFile, { force: true });
}
if (existsSync(checksumFile)) rmSync(checksumFile, { force: true });

function tryZip() {
  const result = spawnSync('zip', ['-r', zipFile, '.', '-x', '*.DS_Store', '__MACOSX/*'], {
    cwd: distDir,
    stdio: 'inherit',
  });
  return result.status === 0;
}

function tryTar() {
  const result = spawnSync('tar', ['-a', '-c', '-f', zipFile, '.'], {
    cwd: distDir,
    stdio: 'inherit',
    shell: false,
  });
  return result.status === 0;
}

function tryPowerShell() {
  const psCommand = [
    'Compress-Archive',
    '-Path', `"${join(distDir, '*')}"`,
    '-DestinationPath', `"${zipFile}"`,
    '-Force',
  ].join(' ');

  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
    {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
    }
  );

  return result.status === 0;
}

console.log('== 打包浏览器扩展压缩包 ==');

const packed = tryZip() || tryTar() || tryPowerShell();

if (!packed) {
  fail('打包失败：未找到可用的压缩工具。请在 macOS 使用 zip，或在 Windows 使用 PowerShell Compress-Archive。');
}

function tryListArchive(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
  });
  return result.status === 0 ? result.stdout : undefined;
}

function listArchiveEntries() {
  const output = tryListArchive('unzip', ['-Z1', zipFile])
    ?? tryListArchive('tar', ['-tf', zipFile]);
  if (output === undefined) fail('无法读取刚生成的扩展压缩包');
  return output
    .split(/\r?\n/)
    .map(entry => entry.replaceAll('\\', '/').replace(/^\.\/?/, ''))
    .filter(Boolean);
}

const entries = listArchiveEntries();
const requiredEntries = [
  'manifest.json',
  'background.js',
  'content.js',
  'src/popup/index.html',
  'src/options/index.html',
  'src/sidepanel/index.html',
  'src/application-records/index.html',
  'src/offscreen/index.html',
];
const missingEntries = requiredEntries.filter(entry => !entries.includes(entry));
if (missingEntries.length > 0) {
  fail(`扩展压缩包缺少关键入口：${missingEntries.join(', ')}`);
}

const checksum = createHash('sha256').update(readFileSync(zipFile)).digest('hex');
writeFileSync(checksumFile, `${checksum}  job-application-helper-extension.zip\n`, 'utf8');

console.log('\n打包完成。');
console.log(`压缩包位置：${zipFile}`);
console.log(`SHA-256：${checksum}`);
console.log('注意：浏览器不能直接加载 zip，请先解压，再选择解压后的目录进行“加载已解压的扩展程序”。');
