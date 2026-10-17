import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

import { aitrackLibAlias } from './vite.alias.js';

// The tests must never read or write the developer's real ~/.config/aitrack (live pricing pack, config, caches).
const testHome = join(tmpdir(), 'aitrack-vitest-home');
mkdirSync(testHome, { recursive: true });

export default defineConfig({
  plugins: [svelte()],
  resolve: { alias: aitrackLibAlias, conditions: ['browser'] },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    env: { HOME: testHome, USERPROFILE: testHome },
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.svelte'],
      exclude: [
        'src/**/__tests__/**',
        // Untested process and webview glue; opentrack:bundle:check only smoke-runs startup.
        'src/sidecar/index.ts',
        'src/renderer/main.ts',
        'src/shared/types.ts',
      ],
      thresholds: {
        perFile: { lines: 80, statements: 80, functions: 80, branches: 80 },
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 80,
      },
    },
  },
});
