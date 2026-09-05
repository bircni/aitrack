import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // chalk decides on colour from the ambient TTY, so the same assertion passed
    // standalone and failed under a runner that forwards colour. Pin it.
    env: { FORCE_COLOR: '0' },
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Type-only modules and the re-export barrel: no statements to cover, so
      // including them would only dilute the ratios.
      exclude: [
        'src/**/__tests__/**',
        'src/index.ts',
        'src/data/types.ts',
        'src/configTypes.ts',
        'src/display/renderOptions.ts',
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
