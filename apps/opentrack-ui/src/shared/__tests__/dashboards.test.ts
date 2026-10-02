import { QUOTA_PROVIDERS } from 'aitrack-lib/quota/index';
import { describe, expect, it } from 'vitest';

import { PROVIDER_DASHBOARDS } from '../dashboards.js';

describe('provider dashboards', () => {
  it('has an https console URL for every quota provider', () => {
    expect(Object.keys(PROVIDER_DASHBOARDS).toSorted()).toEqual([...QUOTA_PROVIDERS].toSorted());
    for (const key of QUOTA_PROVIDERS) {
      expect(PROVIDER_DASHBOARDS[key]).toMatch(/^https:\/\//u);
    }
  });
});
