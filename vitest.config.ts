import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types.ts', 'src/cli.ts'],
    },
  },
});
