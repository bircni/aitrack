import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/__tests__/**/*.test.ts'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // scripts/ is partly covered via src/pricing/__tests__/checker.test.ts;
      // without it that coverage was invisible.
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
      // Type-only modules: no statements to cover, so including them would
      // only dilute the ratios.
      exclude: [
        'src/**/__tests__/**',
        'src/data/types.ts',
        'src/configTypes.ts',
        'src/display/renderOptions.ts',
        'src/cli.ts',
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
