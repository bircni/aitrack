import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computePreviousUsageWindow, computeUsageWindow } from '../usagePeriods.js';

describe('comparison usage windows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T10:00:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('compares calendar week-to-date with the same days of the previous week', () => {
    const options = { period: 'thisweek' as const };
    const current = computeUsageWindow(options);

    expect(computePreviousUsageWindow(options, current)).toMatchObject({
      start: '2026-06-08',
      end: '2026-06-10',
    });
  });

  it('compares month-to-date with the available days in the previous month', () => {
    vi.setSystemTime(new Date('2026-03-31T10:00:00'));
    const options = { period: 'thismonth' as const };

    expect(computePreviousUsageWindow(options)).toMatchObject({
      start: '2026-02-01',
      end: '2026-02-28',
    });
  });

  it('uses an equally sized preceding window for custom ranges', () => {
    const options = {
      period: 'range' as const,
      from: '2026-06-10',
      to: '2026-06-12',
    };

    expect(computePreviousUsageWindow(options)).toMatchObject({
      start: '2026-06-07',
      end: '2026-06-09',
    });
  });

  it('compares the current year with the previous year to date', () => {
    expect(computePreviousUsageWindow({ period: 'year' })).toMatchObject({
      start: '2025-01-01',
      end: '2025-06-17',
    });
  });

  it('rejects all-time comparisons', () => {
    expect(() => computePreviousUsageWindow({ period: 'all' })).toThrow(
      'does not have a comparable previous period',
    );
  });
});
