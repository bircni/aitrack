import { describe, expect, it } from 'vitest';

import {
  inclusiveDayCount,
  mondayOfWeek,
  sameDayInYear,
  shiftDate,
  shiftMonthEnd,
  shiftMonthSameDay,
  shiftMonthStart,
  yearOf,
} from '../calendar.js';

describe('calendar date-string arithmetic', () => {
  it('shifts dates across month and year boundaries', () => {
    expect(shiftDate('2026-06-17', 1)).toBe('2026-06-18');
    expect(shiftDate('2026-06-30', 1)).toBe('2026-07-01');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDate('2026-03-15', -30)).toBe('2026-02-13');
  });

  it('reads the year regardless of offset sign', () => {
    expect(yearOf('2026-06-17')).toBe(2026);
    expect(yearOf('0001-01-01')).toBe(1);
  });

  it('finds the first and last day of an offset month', () => {
    expect(shiftMonthStart('2026-06-17', 0)).toBe('2026-06-01');
    expect(shiftMonthStart('2026-01-10', -1)).toBe('2025-12-01');
    expect(shiftMonthEnd('2026-02-10', 0)).toBe('2026-02-28');
    expect(shiftMonthEnd('2024-02-10', 0)).toBe('2024-02-29'); // leap year
    expect(shiftMonthEnd('2026-06-17', -1)).toBe('2026-05-31');
  });

  it('clamps the same-day-of-month shift to the target month length', () => {
    // Jan 31 one month back has no 31st in a 30-day month... forward to Feb.
    expect(shiftMonthSameDay('2026-03-31', -1)).toBe('2026-02-28');
    expect(shiftMonthSameDay('2024-03-31', -1)).toBe('2024-02-29');
    expect(shiftMonthSameDay('2026-05-31', -1)).toBe('2026-04-30');
    expect(shiftMonthSameDay('2026-06-15', -1)).toBe('2026-05-15');
  });

  it('keeps Feb 29 alive when projecting a date into another year', () => {
    expect(sameDayInYear('2024-02-29', 2023)).toBe('2023-02-28');
    expect(sameDayInYear('2024-02-29', 2028)).toBe('2028-02-29');
    expect(sameDayInYear('2026-07-04', 2025)).toBe('2025-07-04');
  });

  it('snaps any weekday back to its Monday', () => {
    expect(mondayOfWeek('2026-06-17')).toBe('2026-06-15'); // Wed -> Mon
    expect(mondayOfWeek('2026-06-15')).toBe('2026-06-15'); // Mon -> Mon
    expect(mondayOfWeek('2026-06-21')).toBe('2026-06-15'); // Sun -> Mon
  });

  it('counts days inclusively at both ends', () => {
    expect(inclusiveDayCount('2026-06-17', '2026-06-17')).toBe(1);
    expect(inclusiveDayCount('2026-06-01', '2026-06-30')).toBe(30);
    expect(inclusiveDayCount('2025-12-31', '2026-01-01')).toBe(2);
  });
});
