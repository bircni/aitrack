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

  it('clamps month-to-date onto a shorter previous month', () => {
    // May 31 has no counterpart in April; the comparison ends on the 30th
    // rather than rolling into May and comparing the month with itself.
    vi.setSystemTime(new Date('2026-05-31T10:00:00'));

    expect(computePreviousUsageWindow({ period: 'thismonth' })).toMatchObject({
      start: '2026-04-01',
      end: '2026-04-30',
    });
  });

  it('rolls the previous calendar month back across a year boundary', () => {
    vi.setSystemTime(new Date('2026-01-20T10:00:00'));

    expect(computePreviousUsageWindow({ period: 'lastmonth' })).toMatchObject({
      start: '2025-11-01',
      end: '2025-11-30',
    });
  });

  it('clamps a leap day onto the previous, non-leap year', () => {
    vi.setSystemTime(new Date('2028-02-29T10:00:00'));

    expect(computePreviousUsageWindow({ period: 'year' })).toMatchObject({
      start: '2027-01-01',
      end: '2027-02-28',
    });
  });
});

describe('computeUsageWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the calendar week on Monday', () => {
    // A Sunday: the week it belongs to started six days earlier, not the day after.
    vi.setSystemTime(new Date('2026-06-21T10:00:00'));

    expect(computeUsageWindow({ period: 'thisweek' })).toMatchObject({
      start: '2026-06-15',
      end: '2026-06-21',
    });
    expect(computeUsageWindow({ period: 'lastweek' })).toMatchObject({
      start: '2026-06-08',
      end: '2026-06-14',
    });
  });

  it('rolls the previous calendar month back across a year boundary', () => {
    vi.setSystemTime(new Date('2026-01-15T10:00:00'));

    expect(computeUsageWindow({ period: 'lastmonth' })).toMatchObject({
      start: '2025-12-01',
      end: '2025-12-31',
    });
    expect(computeUsageWindow({ period: 'thismonth' })).toMatchObject({
      start: '2026-01-01',
      end: '2026-01-15',
    });
  });

  it('counts a rolling window inclusively from today', () => {
    vi.setSystemTime(new Date('2026-03-03T10:00:00'));

    expect(computeUsageWindow({ period: 'week' })).toMatchObject({
      start: '2026-02-25',
      end: '2026-03-03',
    });
    expect(computeUsageWindow({ period: 'last', n: 1 })).toMatchObject({
      start: '2026-03-03',
      end: '2026-03-03',
    });
  });

  it('stays on local calendar days across a DST transition', () => {
    // 2026-03-29 is when European clocks jump forward. Day arithmetic that goes
    // through a wall clock loses or gains an hour here and can land a day off.
    vi.setSystemTime(new Date('2026-03-30T10:00:00'));

    expect(computeUsageWindow({ period: 'yesterday' })).toMatchObject({
      start: '2026-03-29',
      end: '2026-03-29',
    });
    expect(computeUsageWindow({ period: 'thisweek' })).toMatchObject({
      start: '2026-03-30',
      end: '2026-03-30',
    });
  });
});
