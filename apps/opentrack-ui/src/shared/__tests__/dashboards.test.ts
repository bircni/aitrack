import { QUOTA_PROVIDERS } from 'aitrack-lib/quota/index';
import { describe, expect, it } from 'vitest';

import dashboards from '../provider-dashboards.json' with { type: 'json' };

describe('provider dashboards', () => {
  it('has an https console URL for every quota provider', () => {
    expect(Object.keys(dashboards).toSorted()).toEqual([...QUOTA_PROVIDERS].toSorted());
    for (const key of QUOTA_PROVIDERS) {
      expect(dashboards[key]).toMatch(/^https:\/\//u);
    }
  });
});
