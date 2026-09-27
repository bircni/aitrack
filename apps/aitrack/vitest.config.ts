import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
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
      // `cli.ts` is a two-line shebang entry point; the smoke tests cover it
      // end to end, which coverage of an out-of-process run cannot see.
      exclude: [
        'src/**/__tests__/**',
        'src/cli.ts',
        // The workspace library has its own test target and coverage gate.
        'aitrack-lib/src/**',
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
