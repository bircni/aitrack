import { describe, expect, it } from 'vitest';

import { calendarDateInTimeZone } from '../timezone.js';

describe('calendarDateInTimeZone', () => {
  const instant = new Date('2026-06-15T03:00:00Z');

  it('returns the civil date in that zone', () => {
    expect(calendarDateInTimeZone('UTC', instant)).toBe('2026-06-15');
    expect(calendarDateInTimeZone('America/Los_Angeles', instant)).toBe('2026-06-14');
  });

  it('returns null for a missing or invalid zone', () => {
    expect(calendarDateInTimeZone('unknown', instant)).toBeNull();
    expect(calendarDateInTimeZone('Not/AZone', instant)).toBeNull();
  });
});
