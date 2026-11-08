import { fileURLToPath } from 'node:url';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('src/renderer/', import.meta.url)),
  base: './',
  plugins: [svelte()],
  build: {
    outDir: fileURLToPath(new URL('dist/renderer/', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome140',
  },
});
