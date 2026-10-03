import { describe, expect, it } from 'vitest';

import type { MachineFile, TokenCounts } from '../../data/types.js';
import { createFallbackCollector } from '../fallback.js';
import { repriceMachineDays } from '../reprice.js';

function daysWith(
  provider: string,
  byModel: Record<string, TokenCounts>,
  costUSD = 999,
): MachineFile['days'] {
  return {
    '2026-09-01': {
      [provider]: {
        byModel,
        totals: {
          inputTokens: Object.values(byModel).reduce((sum, counts) => sum + counts.inputTokens, 0),
          outputTokens: Object.values(byModel).reduce(
            (sum, counts) => sum + counts.outputTokens,
            0,
          ),
          costUSD,
        },
      },
    },
  };
}

const opus: TokenCounts = {
  inputTokens: 1_100_000,
  outputTokens: 100_000,
  rawInputTokens: 100_000,
  cachedInputTokens: 1_000_000,
};

describe('repriceMachineDays', () => {
  it('reprices stored cache breakdowns and becomes a no-op on a second pass', () => {
    const days = daysWith('claude_code', { 'claude-opus-4-7': { ...opus, costUSD: 999 } });
    expect(repriceMachineDays(days)).toEqual({ isTouched: true, legacySkipped: 0 });
    expect(days['2026-09-01']?.claude_code?.byModel['claude-opus-4-7']?.costUSD).toBeCloseTo(3.5);
    expect(days['2026-09-01']?.claude_code?.totals.costUSD).toBeCloseTo(3.5);
    expect(repriceMachineDays(days)).toEqual({ isTouched: false, legacySkipped: 0 });
  });

  it('repairs a stale total even when model costs are current', () => {
    const days = daysWith('claude_code', { 'claude-opus-4-7': { ...opus, costUSD: 3.5 } });
    expect(repriceMachineDays(days).isTouched).toBe(true);
    expect(days['2026-09-01']?.claude_code?.totals.costUSD).toBeCloseTo(3.5);
  });

  it('preserves totals if a model is unpriced, and uses stored costs if available', () => {
    const days = daysWith('codex', { unknown: { inputTokens: 100, outputTokens: 10 } });
    expect(repriceMachineDays(days)).toEqual({ isTouched: false, legacySkipped: 0 });
    expect(days['2026-09-01']?.codex?.totals.costUSD).toBe(999);
    const priced = daysWith('codex', {
      unknown: { inputTokens: 100, outputTokens: 10, costUSD: 2 },
    });
    expect(repriceMachineDays(priced).isTouched).toBe(true);
    expect(priced['2026-09-01']?.codex?.totals.costUSD).toBe(2);
  });

  it('leaves legacy Claude rows without cache breakdown intact and counts them', () => {
    const days = daysWith(
      'claude_code',
      { 'claude-sonnet-4-6': { inputTokens: 1_000_000, outputTokens: 100_000, costUSD: 4.5 } },
      4.5,
    );
    const before = structuredClone(days);
    expect(repriceMachineDays(days)).toEqual({ isTouched: false, legacySkipped: 1 });
    expect(days).toEqual(before);
  });

  it('ignores empty days and providers without sync support', () => {
    const days = daysWith('cursor', { 'composer-2.5': { inputTokens: 100, outputTokens: 10 } });
    days['2026-09-02'] = {
      codex: { byModel: {}, totals: { inputTokens: 0, outputTokens: 0, costUSD: 999 } },
    };
    const before = structuredClone(days);
    expect(repriceMachineDays(days)).toEqual({ isTouched: false, legacySkipped: 0 });
    expect(days).toEqual(before);
  });

  it('uses usage-date overrides and returns fallback hits to the caller', () => {
    const days = daysWith('codex', {
      'gpt-5.6-sol': { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'gpt-5.9-codex': { inputTokens: 0, outputTokens: 0 },
    });
    days['2026-08-20'] = days['2026-09-01'] ?? {};
    delete days['2026-09-01'];
    const fallbacks = createFallbackCollector();
    expect(repriceMachineDays(days, fallbacks).isTouched).toBe(true);
    expect(days['2026-08-20'].codex?.byModel['gpt-5.6-sol']?.costUSD).toBe(35);
    expect(fallbacks.drain()).toEqual(['gpt-5.9-codex']);
  });
});
