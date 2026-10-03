import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Release tooling is exercised in subprocesses; measure the pricing scripts here.
      include: ['build-pricing-pack.ts', 'update-pricing.ts'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80, perFile: true },
    },
  },
});
