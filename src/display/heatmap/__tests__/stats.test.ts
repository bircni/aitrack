import { describe, expect, it } from 'vitest';

import type { DayEntry } from '../../../data/types.js';
import { computeModelStats, currentStreak, longestStreak, peakMonth } from '../stats.js';

function makeDay(input: number, output: number): DayEntry {
  return {
    inputTokens: input,
    outputTokens: output,
    byModel: { m: { inputTokens: input, outputTokens: output } },
  };
}

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
