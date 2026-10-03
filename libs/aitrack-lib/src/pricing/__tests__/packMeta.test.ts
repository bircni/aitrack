import { expect, it, vi } from 'vitest';

import { pricingPackBaseUrl, pricingPackUrls } from '../packMeta.js';

it('uses default pack endpoints and trims mirror overrides', () => {
  vi.stubEnv('AITRACK_PRICING_URL', '');
  expect(pricingPackBaseUrl()).toContain('/pricing');
  vi.stubEnv('AITRACK_PRICING_URL', '  https://mirror.example/pricing/  ');
  expect(pricingPackBaseUrl()).toBe('https://mirror.example/pricing');
  expect(pricingPackUrls().manifest).toBe('https://mirror.example/pricing/manifest.json');
  expect(pricingPackUrls('https://custom').modelsDev).toBe('https://custom/models_dev.json');
  vi.unstubAllEnvs();
});
