import { EXTREME_TIME_ZONES, useTimeZone } from '@aitrack/test-fixtures';
import { describe, expect, it } from 'vitest';

import {
  addModelUsage,
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
  it('addModelUsage updates the model row and the day totals together', () => {
    const day = emptyDay();
    addModelUsage(day, 'm', {
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 3,
      costUSD: 0.5,
    });
    addModelUsage(day, 'm', { inputTokens: 5, outputTokens: 1, costUSD: 0.25 });

    expect(day.inputTokens).toBe(15);
    expect(day.outputTokens).toBe(5);
    expect(day.cachedInputTokens).toBe(3);
    expect(day.costUSD).toBe(0.75);
    expect(day.byModel.m).toEqual({
      inputTokens: 15,
      outputTokens: 5,
      cachedInputTokens: 3,
      costUSD: 0.75,
    });
  });

  it('getOrCreateDay returns the same entry for repeated dates', () => {
    const dayMap: DayMap = new Map();
    const first = getOrCreateDay(dayMap, '2024-01-01');
    first.inputTokens = 10;
    const second = getOrCreateDay(dayMap, '2024-01-01');
    expect(second).toBe(first);
    expect(second.inputTokens).toBe(10);
  });

  it('mergeDayMaps carries the cache token breakdown across', () => {
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

describe.each(EXTREME_TIME_ZONES)('day keys at %s', (timeZone) => {
  useTimeZone(timeZone);

  it('keeps an instant built from local components on its own day', () => {
    // Both edges of a local day. Under a UTC-only run these pass whatever the
    // helper does with the offset; at UTC+14 and UTC-11 they only pass if it
    // reads local components rather than the UTC ones.
    expect(toLocalDateString(new Date(2024, 5, 15, 0, 0, 0))).toBe('2024-06-15');
    expect(toLocalDateString(new Date(2024, 5, 15, 23, 59, 59))).toBe('2024-06-15');
  });

  it('agrees with the calendar date the timestamp reads as locally', () => {
    const iso = new Date(2024, 11, 31, 23, 30).toISOString();
    expect(toLocalDateString(iso)).toBe('2024-12-31');
    expect(toLocalDateString(new Date(iso))).toBe('2024-12-31');
    expect(tryLocalDateString(iso)).toBe('2024-12-31');
  });

  it('rejects an unparseable timestamp that would otherwise key as NaN-NaN-NaN', () => {
    expect(tryLocalDateString('not a date')).toBeNull();
    expect(tryLocalDateString(new Date('nonsense'))).toBeNull();
    expect(toLocalDateString('not a date')).toBe('NaN-NaN-NaN');
  });
});

it.each([true, false])(
  'retains unpriced usage when priced records arrive first: %s',
  (pricedFirst) => {
    const day = emptyDay();
    const priced = { inputTokens: 10, outputTokens: 2, costUSD: 1 };
    const unpriced = { inputTokens: 20, outputTokens: 3 };
    for (const counts of pricedFirst ? [priced, unpriced] : [unpriced, priced])
      addModelUsage(day, 'mixed', counts);
    expect(day).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
      costUSD: 1,
      hasUnpricedTokens: true,
    });
    expect(day.byModel.mixed).toMatchObject({
      inputTokens: 30,
      costUSD: 1,
      hasUnpricedTokens: true,
    });
    const merged: DayMap = new Map();
    mergeDayMaps(merged, new Map([['2026-01-01', day]]));
    expect(merged.get('2026-01-01')?.hasUnpricedTokens).toBe(true);
  },
);
