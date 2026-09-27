import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['aitrack-lib'] },
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          ingestWorker: resolve('src/main/ingestWorker.ts'),
        },
        output: { entryFileNames: '[name].js' },
        external: ['pdfkit', '@napi-rs/canvas'],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ['zod'] },
      rollupOptions: {
        output: {
          format: 'cjs',
          inlineDynamicImports: true,
          entryFileNames: 'index.js',
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { '@': resolve('src/renderer/src') },
    },
    plugins: [react(), tailwindcss()],
  },
});
