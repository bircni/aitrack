import { describe, expect, it } from 'vitest';

import {
  filterDayMapByYear,
  filterProviderDataByYear,
  getOrCreateDay,
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
