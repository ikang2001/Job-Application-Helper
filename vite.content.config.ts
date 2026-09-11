import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * Manifest V3 content_scripts 没有 module 类型，不能加载含顶层 import 的产物。
 * 单入口 IIFE 构建会把共享模块全部内联到 content.js。
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      name: 'JobApplicationHelperContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
