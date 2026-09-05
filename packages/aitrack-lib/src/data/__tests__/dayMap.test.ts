import { EXTREME_TIME_ZONES, useTimeZone } from '@aitrack/test-fixtures';
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
    // Two probes so the UTC and local dates disagree whichever side of UTC the
    // machine runs on: just before local midnight the UTC date has already
    // rolled over west of UTC, and just after it has not yet rolled over east
    // of it. Pinning a single UTC instant only held for offsets near zero.
    expect(toLocalDateString(new Date(2024, 5, 15, 23, 30, 0))).toBe('2024-06-15');
    expect(toLocalDateString(new Date(2024, 5, 15, 0, 30, 0))).toBe('2024-06-15');
  });

  it('toLocalDateString treats a string and a Date the same', () => {
    const iso = new Date(2024, 5, 15, 12).toISOString();
    expect(toLocalDateString(iso)).toBe(toLocalDateString(new Date(iso)));
    expect(toLocalDateString(iso)).toBe('2024-06-15');
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
    expect(tryLocalDateString(iso)).toBe('2024-12-31');
  });

  it('still rejects an unparseable timestamp', () => {
    expect(tryLocalDateString('not a date')).toBeNull();
  });
});
