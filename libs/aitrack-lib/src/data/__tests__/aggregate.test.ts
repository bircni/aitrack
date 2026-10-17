import { describe, expect, it } from 'vitest';

import { aggregateModelsByDayMap, sumDayMap } from '../aggregate.js';
import type { DayEntry, DayMap } from '../types.js';

function day(
  byModel: DayEntry['byModel'],
  totals?: { inputTokens: number; outputTokens: number; costUSD?: number },
): DayEntry {
  const inputTokens = totals?.inputTokens ?? 0;
  const outputTokens = totals?.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    ...(totals?.costUSD !== undefined && { costUSD: totals.costUSD }),
    byModel,
  };
}

describe('aggregateModelsByDayMap', () => {
  it('aggregates tokens and costs per model across days', () => {
    const dayMap: DayMap = new Map([
      [
        '2024-01-01',
        day(
          { sonnet: { inputTokens: 100, outputTokens: 50, costUSD: 1 } },
          { inputTokens: 100, outputTokens: 50, costUSD: 1 },
        ),
      ],
      [
        '2024-01-02',
        day(
          { sonnet: { inputTokens: 200, outputTokens: 100, costUSD: 2 } },
          { inputTokens: 200, outputTokens: 100, costUSD: 2 },
        ),
      ],
    ]);

    const agg = aggregateModelsByDayMap(dayMap);
    expect(agg.get('sonnet')).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      cachedInputTokens: 0,
      hasCached: false,
      costUSD: 3,
      hasCost: true,
      days: 2,
    });
  });

  it('skips zero-token models without cost', () => {
    const dayMap: DayMap = new Map([
      ['2024-01-01', day({ empty: { inputTokens: 0, outputTokens: 0 } })],
    ]);
    expect(aggregateModelsByDayMap(dayMap).size).toBe(0);
  });

  it('keeps a zero-token model that carries cost and flags equal input and output as unpriced', () => {
    const dayMap: DayMap = new Map([
      [
        '2024-01-01',
        day({
          credit: { inputTokens: 0, outputTokens: 0, costUSD: 0.5 },
          even: { inputTokens: 5, outputTokens: 5 },
        }),
      ],
    ]);
    const agg = aggregateModelsByDayMap(dayMap);
    expect(agg.get('credit')).toMatchObject({ hasCost: true, costUSD: 0.5 });
    expect(agg.get('credit')?.hasUnpricedTokens).toBeUndefined();
    expect(agg.get('even')).toMatchObject({ hasCost: false, hasUnpricedTokens: true });
  });

  it('sums cached input when the split is present', () => {
    const dayMap: DayMap = new Map([
      [
        '2024-01-01',
        day({ astra: { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 900 } }),
      ],
    ]);
    expect(aggregateModelsByDayMap(dayMap).get('astra')).toMatchObject({
      cachedInputTokens: 900,
      hasCached: true,
    });
  });

  it('filters by year, start, and end dates', () => {
    const dayMap: DayMap = new Map([
      ['2024-06-01', day({ m: { inputTokens: 10, outputTokens: 5 } })],
      ['2025-01-01', day({ m: { inputTokens: 20, outputTokens: 10 } })],
    ]);

    const yearOnly = aggregateModelsByDayMap(dayMap, { year: 2024 });
    expect(yearOnly.get('m')?.inputTokens).toBe(10);

    const range = aggregateModelsByDayMap(dayMap, { start: '2024-12-01', end: '2025-12-31' });
    expect(range.get('m')?.inputTokens).toBe(20);
  });
});

describe('sumDayMap', () => {
  it('counts only days with tokens and sums cost where present', () => {
    const dayMap: DayMap = new Map([
      ['2024-01-01', day({}, { inputTokens: 10, outputTokens: 0, costUSD: 1 })],
      ['2024-01-02', day({}, { inputTokens: 0, outputTokens: 4 })],
      ['2024-01-03', day({}, { inputTokens: 0, outputTokens: 0 })],
    ]);
    expect(sumDayMap(dayMap)).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      costUSD: 1,
      hasCost: true,
      days: 2,
    });
    expect(sumDayMap(new Map()).hasCost).toBe(false);
  });
});
