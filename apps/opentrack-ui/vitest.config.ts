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
  },
});
