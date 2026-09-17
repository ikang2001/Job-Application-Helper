import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');

async function readJson(filePath: string) {
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
}

test('npm test 使用仓库内受版本控制的 tsx 依赖，而不是 npx 临时下载', async () => {
  const packageJson = await readJson(path.join(repoRoot, 'package.json')) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packageLock = await readJson(path.join(repoRoot, 'package-lock.json')) as {
    packages?: Record<string, { devDependencies?: Record<string, string> }>;
  };

  assert.equal(typeof packageJson.scripts?.test, 'string');
  assert.doesNotMatch(packageJson.scripts!.test, /\bnpx\b/);
  assert.match(packageJson.scripts!.test, /^tsx --test\b/);
  assert.doesNotMatch(packageJson.scripts!.test, /--experimental-strip-types/);
  assert.match(packageJson.scripts!.test, /\bnpm run test:sidepanel\b/);
  assert.match(packageJson.scripts!.test, /\bnpm run test:resume-profiles\b/);
  assert.match(packageJson.scripts!['test:resume-profiles'], /src\/options\/AwardsSection\.test\.tsx/);
  assert.equal(typeof packageJson.scripts?.['test:sidepanel'], 'string');
  assert.match(packageJson.scripts!['test:sidepanel'], /\btsx\b/);
  assert.doesNotMatch(packageJson.scripts!['test:sidepanel'], /\bnpx\b/);
  assert.ok(packageJson.devDependencies?.tsx, 'package.json 应声明 tsx 为 devDependency');
  assert.equal(
    packageLock.packages?.['']?.devDependencies?.tsx,
    packageJson.devDependencies?.tsx
  );
  assert.ok(packageLock.packages?.['node_modules/tsx'], 'package-lock.json 应锁定 node_modules/tsx');
  assert.match(packageJson.scripts?.['package:native'] ?? '', /package-native-companion\.js/);
  assert.match(packageJson.scripts?.['package:desktop'] ?? '', /desktop-app run package:win/);
  assert.match(packageJson.scripts?.['package:all'] ?? '', /package:extension/);
  assert.match(packageJson.scripts?.['package:all'] ?? '', /package:native/);
  assert.match(packageJson.scripts?.['package:release'] ?? '', /package:desktop/);
  assert.match(packageJson.scripts?.['check:all'] ?? '', /check:desktop/);
  assert.match(packageJson.scripts?.build ?? '', /vite\.content\.config\.ts/);

  const viteConfig = await readFile(path.join(repoRoot, 'vite.config.ts'), 'utf8');
  const contentConfig = await readFile(path.join(repoRoot, 'vite.content.config.ts'), 'utf8');
  const postBuild = await readFile(path.join(repoRoot, 'scripts/post-build.js'), 'utf8');
  assert.doesNotMatch(viteConfig, /content:\s*resolve\(/);
  assert.match(contentConfig, /formats:\s*\['iife'\]/);
  assert.match(contentConfig, /content\.js/);
  assert.match(postBuild, /content\.js 含顶层 import\/export/);
});

test('ZIP 产物优先使用 unzip 校验，并在不可用时回退 tar', async () => {
  for (const scriptPath of [
    'scripts/package-extension.js',
    'scripts/package-native-companion.js',
  ]) {
    const script = await readFile(path.join(repoRoot, scriptPath), 'utf8');
    const unzipCall = script.indexOf("tryListArchive('unzip', ['-Z1'");
    const tarCall = script.indexOf("tryListArchive('tar', ['-tf'");

    assert.notEqual(unzipCall, -1, `${scriptPath} 应使用 unzip -Z1 读取 ZIP`);
    assert.notEqual(tarCall, -1, `${scriptPath} 应保留 tar -tf 回退`);
    assert.ok(unzipCall < tarCall, `${scriptPath} 应优先使用 unzip，再回退 tar`);
  }
});
