import { describe, expect, it } from 'vitest';

import { isStaleSync } from '../staleSync.js';

const STALE_SYNC_MS = 3 * 86_400_000;

describe('isStaleSync', () => {
  const now = Date.parse('2026-06-10T00:00:00Z');

  it('flags a sync older than three days only', () => {
    expect(isStaleSync(new Date(now - STALE_SYNC_MS - 1).toISOString(), now)).toBe(true);
    expect(isStaleSync(new Date(now - STALE_SYNC_MS).toISOString(), now)).toBe(false);
    expect(isStaleSync('', now)).toBe(false);
  });
});
