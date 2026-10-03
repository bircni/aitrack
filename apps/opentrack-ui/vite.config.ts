import { fileURLToPath } from 'node:url';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

import { aitrackLibAlias } from './vite.alias.js';

// Absolute: the Nx executor runs Vite from the workspace root, not this folder.
const root = fileURLToPath(new URL('src/renderer/', import.meta.url));

export default defineConfig({
  root,
  base: './',
  plugins: [svelte()],
  resolve: { alias: aitrackLibAlias },
  build: {
    outDir: fileURLToPath(new URL('dist/renderer/', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome140',
    // Named explicitly so the Nx Vite plugin infers a build target for a nested root.
    rolldownOptions: { input: fileURLToPath(new URL('src/renderer/index.html', import.meta.url)) },
  },
});
