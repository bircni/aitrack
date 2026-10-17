import { makeMachineFile, makeProviderDay } from '@aitrack/test-fixtures';
import { describe, expect, it } from 'vitest';

import { repriceMachineDays } from '../../pricing/reprice.js';
import { compactDays, COMPACTED_MODEL } from '../compact.js';
import { mergePersistedDays } from '../localData.js';
import type { DayEntry, ProviderDay } from '../types.js';
import { mergeProviderDay } from '../usageData.js';
import { checkMachineFile } from '../validate.js';

function twoModelDay(): ProviderDay {
  return {
    byModel: {
      'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 10, costUSD: 1 },
      'claude-opus-4-8': { inputTokens: 200, outputTokens: 20, costUSD: 2 },
    },
    totals: { inputTokens: 300, outputTokens: 30, costUSD: 3 },
  };
}

function reported(day: ProviderDay | undefined): DayEntry {
  const rec: DayEntry = { inputTokens: 0, outputTokens: 0, byModel: {} };
  if (day) mergeProviderDay(rec, 'claude_code', day, '2026-01-01');
  return rec;
}

describe('compactDays', () => {
  const days = {
    '2026-01-01': { claude_code: twoModelDay() },
    '2026-03-01': { claude_code: twoModelDay() },
  };

  it('drops the model breakdown of old days only and keeps reported totals', () => {
    const compacted = compactDays(days, 30, '2026-03-15');
    const oldDay = compacted['2026-01-01']?.claude_code;

    expect(Object.keys(oldDay?.byModel ?? {})).toEqual([COMPACTED_MODEL]);
    expect(Object.keys(compacted['2026-03-01']?.claude_code?.byModel ?? {})).toHaveLength(2);
    const before = reported(days['2026-01-01'].claude_code);
    const after = reported(oldDay);
    expect(after).toMatchObject({
      inputTokens: before.inputTokens,
      outputTokens: before.outputTokens,
      costUSD: 3,
    });
    expect(after.hasUnpricedTokens).toBeUndefined();
  });

  it('keeps the day cost priced from the models when no total was stored', () => {
    const day = makeProviderDay(1_000_000, 1_000_000, undefined, 'claude-sonnet-4-6');
    const compacted = compactDays({ '2026-01-01': { claude_code: day } }, 1, '2026-03-15');

    const priced = reported(day).costUSD ?? 0;
    expect(priced).toBeGreaterThan(0);
    expect(reported(compacted['2026-01-01']?.claude_code).costUSD).toBeCloseTo(priced);
  });

  it('flags a day whose models cannot be priced and compacts an empty provider day', () => {
    const unknown = makeProviderDay(10, 5, undefined, 'no-such-model');
    const empty: ProviderDay = { byModel: {}, totals: { inputTokens: 0, outputTokens: 0 } };
    const compacted = compactDays(
      { '2026-01-01': { claude_code: unknown, codex: empty } },
      1,
      '2026-03-15',
    );

    expect(compacted['2026-01-01']?.claude_code?.totals.hasUnpricedTokens).toBe(true);
    expect(compacted['2026-01-01']?.codex?.totals.hasUnpricedTokens).toBeUndefined();
  });

  it('stays valid for older readers, is stable on re-sync and is left alone by repricing', () => {
    const compacted = compactDays(days, 30, '2026-03-15');

    expect(checkMachineFile(makeMachineFile('host', compacted), 'host.json').machine?.days).toEqual(
      compacted,
    );
    expect(repriceMachineDays(compacted).isTouched).toBe(false);
    expect(compacted['2026-01-01']?.claude_code?.totals.costUSD).toBe(3);

    const fresh = { '2026-01-01': { claude_code: twoModelDay() } };
    expect(mergePersistedDays(compacted, fresh)).toEqual(compacted);
  });
});
