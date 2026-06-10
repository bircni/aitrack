import { describe, expect, it } from 'vitest';

import type { DayEntry } from '../../../data/types.js';
import { mergeAllProviderDayMaps } from '../merge.js';

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

describe('mergeAllProviderDayMaps', () => {
  it('sums days and models across providers', () => {
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
    expect(day?.byModel['test-model']?.inputTokens).toBe(100);
    expect(day?.byModel['test-model']?.costUSD).toBeCloseTo(0.2);
    expect(day?.byModel['gpt-4']?.inputTokens).toBe(200);
    expect(day?.byModel['gpt-4']?.costUSD).toBeCloseTo(0.3);
  });
});
