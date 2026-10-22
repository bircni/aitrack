import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^aitrack-lib\/(.*)$/u,
        replacement: `${fileURLToPath(new URL('../../libs/aitrack-lib/src/', import.meta.url))}$1.ts`,
      },
    ],
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/format.ts'],
    },
  },
});
