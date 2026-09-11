import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'node22',
    outDir: resolve(import.meta.dirname, 'dist/main'),
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/main/preload.ts'),
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
});
