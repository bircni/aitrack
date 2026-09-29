import { defineConfig } from 'vitest/config';

import { aitrackLibAlias } from './vite.alias.js';

export default defineConfig({
  resolve: { alias: aitrackLibAlias },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        // Process and webview glue: needs the running app, checked by hand (see README).
        'src/sidecar/index.ts',
        'src/renderer/main.ts',
        'src/renderer/api.ts',
        'src/shared/types.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 80,
      },
    },
  },
});
