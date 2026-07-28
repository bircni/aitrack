import { describe, expect, it } from 'vitest';

import {
  filterDayMapByYear,
  filterProviderDataByYear,
  getOrCreateDay,
  mergeDayMaps,
  toLocalDateString,
  tryLocalDateString,
} from '../dayMap.js';
import type { DayEntry, DayMap } from '../types.js';

function emptyDay(): DayEntry {
  return { inputTokens: 0, outputTokens: 0, byModel: {} };
}

describe('dayMap helpers', () => {
  it('getOrCreateDay returns the same entry for repeated dates', () => {
    const dayMap: DayMap = new Map();
    const first = getOrCreateDay(dayMap, '2024-01-01');
    first.inputTokens = 10;
    const second = getOrCreateDay(dayMap, '2024-01-01');
    expect(second).toBe(first);
    expect(second.inputTokens).toBe(10);
  });

  it('toLocalDateString uses local calendar components', () => {
    const date = new Date(2024, 5, 15, 23, 30, 0);
    expect(toLocalDateString(date)).toBe('2024-06-15');
    expect(toLocalDateString('2024-06-15T12:00:00.000Z')).toMatch(/^2024-06-1[45]$/);
  });

  it('tryLocalDateString rejects timestamps that cannot be parsed', () => {
    expect(tryLocalDateString('corrupted')).toBeNull();
    expect(tryLocalDateString(new Date('nonsense'))).toBeNull();
    // Without the guard this is the string "NaN-NaN-NaN", a usable Map key.
    expect(toLocalDateString('corrupted')).toBe('NaN-NaN-NaN');
  });

  it('tryLocalDateString matches toLocalDateString for valid input', () => {
    const date = new Date(2024, 5, 15, 23, 30, 0);
    expect(tryLocalDateString(date)).toBe(toLocalDateString(date));
  });

  it('mergeDayMaps carries the cache token breakdown across', () => {
    // The heatmap used to have its own copy of this merge that dropped these
    // fields, so a merged view silently reported zero cached tokens.
    const dst: DayMap = new Map();
    const source: DayMap = new Map([
      [
        '2024-01-01',
        {
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 80,
          rawInputTokens: 15,
          cacheCreationInputTokens: 5,
          costUSD: 1.5,
          byModel: {
            m: {
              inputTokens: 100,
              outputTokens: 50,
              cachedInputTokens: 80,
              costUSD: 1.5,
            },
          },
        },
      ],
    ]);

    mergeDayMaps(dst, source);
    mergeDayMaps(dst, source);

    const day = dst.get('2024-01-01');
    expect(day?.inputTokens).toBe(200);
    expect(day?.cachedInputTokens).toBe(160);
    expect(day?.rawInputTokens).toBe(30);
    expect(day?.cacheCreationInputTokens).toBe(10);
    expect(day?.costUSD).toBe(3);
    expect(day?.byModel.m?.cachedInputTokens).toBe(160);
  });

  it('filterDayMapByYear keeps only matching dates', () => {
    const dayMap: DayMap = new Map([
      ['2024-01-01', { ...emptyDay(), inputTokens: 1 }],
      ['2025-01-01', { ...emptyDay(), inputTokens: 2 }],
    ]);
    const filtered = filterDayMapByYear(dayMap, 2024);
    expect([...filtered.keys()]).toEqual(['2024-01-01']);
  });

  it('filterProviderDataByYear drops empty providers', () => {
    const filtered = filterProviderDataByYear(
      {
        claude_code: new Map([['2024-01-01', { ...emptyDay(), inputTokens: 1 }]]),
        codex: new Map([['2025-01-01', { ...emptyDay(), inputTokens: 2 }]]),
      },
      2024,
    );
    expect(Object.keys(filtered)).toEqual(['claude_code']);
  });
});
