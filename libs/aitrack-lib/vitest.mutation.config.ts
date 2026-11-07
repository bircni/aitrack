import { isolatedTestEnv } from '@aitrack/test-fixtures/test-env';
import { defineConfig, mergeConfig } from 'vitest/config';

import base from './vitest.config.js';

// os.homedir() reads the process's own environment, which a worker thread's env does not reach.
Object.assign(process.env, isolatedTestEnv());

// Stryker pins vitest to worker threads, where useTimeZone cannot move the process
// zone, so the groups that need a non-UTC zone are skipped (the target runs TZ=UTC).
export default mergeConfig(base, defineConfig({ test: { testNamePattern: '^(?!.*Pacific/)' } }));
