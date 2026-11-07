import { EXTREME_TIME_ZONES, makeDay, useTimeZone } from '@aitrack/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shiftDate } from '../../../data/calendar.js';
import { toLocalDateString } from '../../../data/dayMap.js';
import type { DayEntry } from '../../../data/types.js';
import {
  buildDateGrid,
  computeModelStats,
  currentStreak,
  longestStreak,
  monthLabels,
  peakMonth,
} from '../stats.js';

function week(first: string): Array<string | null> {
  return [first, null, null, null, null, null, null];
}

function dayKey(offsetDays: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return toLocalDateString(d);
}

// A frozen clock: grids for a year in progress stop at today, so a real one breaks these in 2028.
beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 8, 20, 12) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('computeModelStats', () => {
  it('returns top model + peak day in one pass', () => {
    const dayMap = new Map<string, DayEntry>([
      [
        '2024-01-01',
        {
          inputTokens: 100,
          outputTokens: 50,
          byModel: { sonnet: { inputTokens: 100, outputTokens: 50 } },
        },
      ],
      [
        '2024-06-01',
        {
          inputTokens: 5000,
          outputTokens: 1000,
          byModel: {
            opus: { inputTokens: 3000, outputTokens: 800 },
            sonnet: { inputTokens: 2000, outputTokens: 200 },
          },
        },
      ],
    ]);
    const stats = computeModelStats(dayMap);
    expect(stats.peak).toEqual({ date: '2024-06-01', tokens: 6000 });
    expect(stats.topAllTime?.model).toBe('opus');
    expect(stats.topAllTime?.tokens).toBe(3800);
  });

  it('counts the last 30 days including today as recent', () => {
    const stats = computeModelStats(
      new Map([
        [dayKey(30), makeDay(100, 0, undefined, 'old')],
        [dayKey(29), makeDay(1, 0, undefined, 'recent')],
      ]),
    );
    expect(stats.topRecent).toEqual({ model: 'recent', tokens: 1 });
  });

  it('returns nulls on empty input', () => {
    const stats = computeModelStats(new Map());
    expect(stats.topAllTime).toBeNull();
    expect(stats.peak).toBeNull();
  });
});

describe('longestStreak', () => {
  it('finds the longest consecutive active run', () => {
    const dayMap = new Map([
      ['2024-01-01', makeDay(1, 0)],
      ['2024-01-02', makeDay(1, 0)],
      ['2024-01-03', makeDay(1, 0)],
      ['2024-01-10', makeDay(1, 0)],
      ['2024-01-11', makeDay(1, 0)],
    ]);
    expect(longestStreak(dayMap)).toBe(3);
    expect(currentStreak(dayMap)).toBe(0);
  });
});

describe('currentStreak', () => {
  it('counts a run that ends yesterday, before today has any usage', () => {
    const dayMap = new Map([
      [dayKey(3), makeDay(1, 0)],
      [dayKey(2), makeDay(1, 0)],
      [dayKey(1), makeDay(1, 0)],
    ]);

    expect(currentStreak(dayMap)).toBe(3);
  });

  it('includes today once it has usage', () => {
    const dayMap = new Map([
      [dayKey(1), makeDay(1, 0)],
      [dayKey(0), makeDay(1, 0)],
    ]);

    expect(currentStreak(dayMap)).toBe(2);
  });

  it('is zero when neither today nor yesterday was active', () => {
    expect(currentStreak(new Map([[dayKey(2), makeDay(1, 0)]]))).toBe(0);
  });
});

describe('peakMonth', () => {
  it('returns the month with the highest token total', () => {
    const dayMap = new Map([
      ['2024-01-01', makeDay(100, 0)],
      ['2024-02-01', makeDay(500, 0)],
      ['2024-02-15', makeDay(200, 0)],
    ]);
    expect(peakMonth(dayMap)).toEqual({ month: '2024-02', tokens: 700 });
  });
});

describe.each(EXTREME_TIME_ZONES)('today in %s', (zone) => {
  useTimeZone(zone);

  it.each(['2026-01-01T00:15:00Z', '2026-01-01T23:45:00Z'])('at %s', (now) => {
    vi.setSystemTime(new Date(now));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(now));

    expect(currentStreak(new Map([[today, makeDay(1, 0)]]))).toBe(1);
    expect(currentStreak(new Map([[shiftDate(today, -1), makeDay(1, 0)]]))).toBe(1);
    expect(
      computeModelStats(
        new Map([
          [shiftDate(today, -30), makeDay(100, 0, undefined, 'old')],
          [shiftDate(today, -29), makeDay(1, 0, undefined, 'recent')],
        ]),
      ).topRecent?.model,
    ).toBe('recent');
  });
});

describe('monthLabels', () => {
  it('labels each month once, at its first column', () => {
    const weeks = [week('2026-01-04'), week('2026-01-11'), week('2026-02-01')];
    expect(monthLabels(weeks)).toEqual([
      { column: 0, label: 'Jan' },
      { column: 2, label: 'Feb' },
    ]);
  });

  it('drops a leading month that would collide with the next label', () => {
    const weeks = [week('2025-11-30'), week('2025-12-07')];
    expect(monthLabels(weeks)).toEqual([{ column: 1, label: 'Dec' }]);
  });
});

describe('buildDateGrid', () => {
  useTimeZone('America/Santiago'); // DST starts at midnight, so local 00:00 can be skipped

  it('ends the rolling grid on today', () => {
    vi.useFakeTimers({ now: new Date(2026, 8, 20, 12) });
    const dates = buildDateGrid().flat();
    expect(dates.findLast((d) => d !== null)).toBe('2026-09-20');
    expect(dates).toContain('2026-09-06');
  });

  it('needs 54 columns for a leap year starting on Saturday', () => {
    // Jan 1 is a Saturday in each of these, so the grid opens with a nearly
    // empty week and still has to carry all 366 days.
    for (const year of [2000, 2028, 2056]) {
      expect(buildDateGrid(year)).toHaveLength(54);
    }
  });

  it('uses 53 columns for an ordinary year', () => {
    expect(buildDateGrid(2023)).toHaveLength(53);
    expect(buildDateGrid(2024)).toHaveLength(53);
  });

  it('covers every day of the year exactly once', () => {
    const dates = buildDateGrid(2028)
      .flat()
      .filter((d): d is string => d !== null);
    expect(new Set(dates).size).toBe(366);
    expect(dates).toContain('2028-12-31');
    expect(
      buildDateGrid(9999)
        .flat()
        .findLast((d) => d !== null),
    ).toBe('9999-12-31');
  });
});
