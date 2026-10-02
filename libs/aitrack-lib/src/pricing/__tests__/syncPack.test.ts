import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetSharedPricingStore } from '../store.js';
import { syncPricingPack } from '../syncPack.js';

afterEach(() => {
  resetSharedPricingStore();
  vi.unstubAllGlobals();
  delete process.env.AITRACK_NO_PRICING_REFRESH;
  delete process.env.AITRACK_PRICING_URL;
});

describe('syncPricingPack', () => {
  it('returns the disabled refresh detail without hitting the network', async () => {
    process.env.AITRACK_NO_PRICING_REFRESH = '1';
    const result = await syncPricingPack({ force: true });
    expect(result.refreshed).toBe(false);
    expect(result.detail).toContain('AITRACK_NO_PRICING_REFRESH');
    expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});
