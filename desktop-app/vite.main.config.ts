import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const external = ['electron', ...builtinModules, ...builtinModules.map(module => `node:${module}`)];

export default defineConfig({
  build: {
    ssr: resolve(import.meta.dirname, 'src/main/main.ts'),
    target: 'node22',
    outDir: resolve(import.meta.dirname, 'dist/main'),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      external,
      output: {
        entryFileNames: 'main.js',
        format: 'es',
      },
    },
  },
});
