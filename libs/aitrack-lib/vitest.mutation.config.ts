import { defineConfig, mergeConfig } from 'vitest/config';

import base from './vitest.config.js';

// Stryker pins vitest to worker threads, where useTimeZone cannot move the process
// zone, so the groups that need a non-UTC zone are skipped (the target runs TZ=UTC).
export default mergeConfig(
  base,
  defineConfig({ test: { testNamePattern: '^(?!.*explicit report clock in Pacific/)' } }),
);
