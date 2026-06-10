import { describe, expect, it } from 'vitest';

import { filterProviderDataByYear } from '../../data/dayMap.js';
import type { DayEntry } from '../../data/types.js';
import {
  computeModelStats,
  currentStreak,
  displayModelName,
  longestStreak,
  mergeAllProviderDayMaps,
  peakMonth,
  percentile,
  renderToPng,
} from '../renderPng.js';

function makeDay(input: number, output: number, costUSD?: number): DayEntry {
  return {
    inputTokens: input,
    outputTokens: output,
    ...(costUSD === undefined ? {} : { costUSD }),
    byModel: {
      'test-model': {
        inputTokens: input,
        outputTokens: output,
        ...(costUSD === undefined ? {} : { costUSD }),
      },
    },
  };
}

describe('renderToPng', () => {
  it('returns a valid PNG buffer', () => {
    const dayMap = new Map([['2024-01-15', makeDay(1000, 500)]]);
    const buf = renderToPng({ claude_code: dayMap }, [], {});
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  it('works in dark mode', () => {
    const dayMap = new Map([['2024-01-15', makeDay(500, 250)]]);
    const buf = renderToPng({ claude_code: dayMap }, [], { dark: true });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('defaults to one section per provider for multiple providers', () => {
    const claudeMap = new Map([['2024-01-15', makeDay(100, 50)]]);
    const codexMap = new Map([['2024-01-16', makeDay(200, 100)]]);
    const buf = renderToPng({ claude_code: claudeMap, codex: codexMap }, [], {});
    expect(buf).toBeInstanceOf(Buffer);
  });

  it('handles empty provider data without crashing', () => {
    expect(() => renderToPng({}, [], {})).not.toThrow();
  });

  it('mergeAllProviderDayMaps sums days and models across providers', () => {
    const claudeMap = new Map([['2024-01-15', makeDay(100, 50, 0.2)]]);
    const codexMap = new Map([
      [
        '2024-01-15',
        {
          inputTokens: 200,
          outputTokens: 80,
          costUSD: 0.3,
          byModel: { 'gpt-4': { inputTokens: 200, outputTokens: 80, costUSD: 0.3 } },
        },
      ],
    ]);
    const merged = mergeAllProviderDayMaps({ claude_code: claudeMap, codex: codexMap });
    const day = merged.get('2024-01-15');
    expect(day?.inputTokens).toBe(300);
    expect(day?.outputTokens).toBe(130);
    expect(day?.costUSD).toBeCloseTo(0.5);
  });

  it('displayModelName humanizes Claude and Codex IDs', () => {
    expect(displayModelName('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(displayModelName('gpt-5.1-codex')).toBe('GPT-5.1 Codex');
  });

  it('percentile picks the value at the requested rank', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  it('computeModelStats returns top model + peak day in one pass', () => {
    const dayMap = new Map<string, DayEntry>([
      [
        '2024-06-01',
        {
          inputTokens: 5000,
          outputTokens: 1000,
          byModel: { opus: { inputTokens: 3000, outputTokens: 800 } },
        },
      ],
    ]);
    const stats = computeModelStats(dayMap);
    expect(stats.peak).toEqual({ date: '2024-06-01', tokens: 6000 });
  });

  it('longestStreak finds the longest consecutive active run', () => {
    const dayMap = new Map([
      ['2024-01-01', makeDay(1, 0)],
      ['2024-01-02', makeDay(1, 0)],
      ['2024-01-03', makeDay(1, 0)],
    ]);
    expect(longestStreak(dayMap)).toBe(3);
    expect(currentStreak(dayMap)).toBe(0);
  });

  it('peakMonth returns the month with the highest token total', () => {
    const dayMap = new Map([
      ['2024-02-01', makeDay(500, 0)],
      ['2024-02-15', makeDay(200, 0)],
    ]);
    expect(peakMonth(dayMap)).toEqual({ month: '2024-02', tokens: 700 });
  });

  it('filterProviderDataByYear keeps only matching dates', () => {
    const data = {
      claude_code: new Map([
        ['2024-01-01', makeDay(10, 5)],
        ['2025-01-01', makeDay(20, 5)],
      ]),
    };
    const filtered = filterProviderDataByYear(data, 2024);
    expect([...(filtered.claude_code?.keys() ?? [])]).toEqual(['2024-01-01']);
  });

  it('merges into one section when all is true', () => {
    const claudeMap = new Map([['2024-01-15', makeDay(100, 50)]]);
    const codexMap = new Map([['2024-01-16', makeDay(200, 100)]]);
    const buf = renderToPng({ claude_code: claudeMap, codex: codexMap }, [], { all: true });
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
  });

  it('renders with a year filter', () => {
    const dayMap = new Map([
      ['2024-06-01', makeDay(100, 50)],
      ['2025-06-01', makeDay(200, 100)],
    ]);
    const buf = renderToPng({ claude_code: dayMap }, [], { year: 2024 });
    expect(buf[0]).toBe(0x89);
  });
});
