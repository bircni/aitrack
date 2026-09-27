import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: {
    timeout: 20_000,
    toHaveScreenshot: { animations: 'disabled' },
  },
  snapshotPathTemplate: '{testDir}/snapshots/{arg}-{platform}{ext}',
  outputDir: './e2e/artifacts/results',
  use: {
    viewport: { width: 1280, height: 840 },
  },
});
