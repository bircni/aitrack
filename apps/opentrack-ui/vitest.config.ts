import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Tests must never read or write the developer's real data.
const home = join(tmpdir(), 'opentrack-vitest-home');
mkdirSync(home, { recursive: true });

export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ['browser'] },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    env: { HOME: home, USERPROFILE: home },
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.svelte'],
      exclude: [
        'src/**/__tests__/**',
        'src/test/**',
        // Untested webview glue.
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
