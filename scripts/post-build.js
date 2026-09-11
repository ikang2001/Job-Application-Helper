import { copyFileSync, mkdirSync, existsSync, readdirSync, cpSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = join(__dirname, '..');
const distDir = join(projectRoot, 'dist');

function requirePath(path, message) {
  if (!existsSync(path)) throw new Error(message);
}

try {
  // 复制 manifest.json
  const manifestSrc = join(projectRoot, 'manifest.json');
  const manifestDest = join(distDir, 'manifest.json');
  requirePath(manifestSrc, '缺少 manifest.json');
  copyFileSync(manifestSrc, manifestDest);
  console.log('✓ manifest.json copied to dist/');

  // 复制 icons
  const iconsSrcDir = join(projectRoot, 'public', 'icons');
  const iconsDestDir = join(distDir, 'icons');

  if (!existsSync(iconsDestDir)) {
    mkdirSync(iconsDestDir, { recursive: true });
  }

  if (existsSync(iconsSrcDir)) {
    const iconFiles = readdirSync(iconsSrcDir).filter(f => f.endsWith('.png'));
    if (iconFiles.length < 4) throw new Error(`扩展图标不完整：只找到 ${iconFiles.length} 个 PNG`);
    for (const file of iconFiles) {
      copyFileSync(join(iconsSrcDir, file), join(iconsDestDir, file));
    }
    console.log(`✓ ${iconFiles.length} icon files copied to dist/icons/`);
  } else throw new Error('缺少 public/icons/ 目录');

  // 复制 PDF.js worker 文件
  const pdfWorkerSrc = join(projectRoot, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
  const pdfWorkerDest = join(distDir, 'pdf.worker.min.js');

  requirePath(pdfWorkerSrc, '缺少 PDF.js worker，无法交付 PDF 解析');
  copyFileSync(pdfWorkerSrc, pdfWorkerDest);
  console.log('✓ PDF.js worker copied to dist/');

  // 复制 PDF.js 中文字体与 CMap 资源
  const pdfCmapsSrc = join(projectRoot, 'node_modules', 'pdfjs-dist', 'cmaps');
  const pdfCmapsDest = join(distDir, 'cmaps');
  requirePath(pdfCmapsSrc, '缺少 PDF.js CMap，无法交付 CJK PDF 解析');
  cpSync(pdfCmapsSrc, pdfCmapsDest, { recursive: true });
  console.log('✓ PDF.js cmaps copied to dist/cmaps/');

  const pdfStandardFontsSrc = join(projectRoot, 'node_modules', 'pdfjs-dist', 'standard_fonts');
  const pdfStandardFontsDest = join(distDir, 'standard_fonts');
  requirePath(pdfStandardFontsSrc, '缺少 PDF.js standard fonts，无法交付完整 PDF 解析');
  cpSync(pdfStandardFontsSrc, pdfStandardFontsDest, { recursive: true });
  console.log('✓ PDF.js standard fonts copied to dist/standard_fonts/');

  const requiredOutputs = [
    'manifest.json',
    'background.js',
    'content.js',
    'pdf.worker.min.js',
    'src/popup/index.html',
    'src/options/index.html',
    'src/sidepanel/index.html',
    'src/application-records/index.html',
    'src/offscreen/index.html',
  ];
  for (const relativePath of requiredOutputs) {
    requirePath(join(distDir, ...relativePath.split('/')), `构建产物缺失：${relativePath}`);
  }

  // Manifest content_scripts 按经典脚本加载。只检查文件存在无法发现 Vite
  // 拆出的 ESM import，必须在发布前阻止不可执行的产物。
  const contentScript = readFileSync(join(distDir, 'content.js'), 'utf8');
  const hasStaticModuleSyntax = /(^|[;\n])\s*(?:import(?:\s|\{|["'])|export\s)/m.test(contentScript);
  if (hasStaticModuleSyntax) {
    throw new Error('content.js 含顶层 import/export，无法作为 Manifest content script 执行');
  }

  console.log('\n✅ 构建完成！可以加载 dist/ 目录到浏览器。');
} catch (error) {
  console.error('构建后处理失败:', error);
  process.exit(1);
}
