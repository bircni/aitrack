import { describe, expect, it } from 'vitest';

import { type CursorCostTokens, estimateCursorCostUSD } from '../cursor.js';

const M = 1_000_000;

/** An aggregate-only row: `input` known, no cache split. */
function aggregate(input: number, output: number): CursorCostTokens {
  return { input, output, rawInput: 0, cacheRead: 0, cacheWrite: 0, hasBreakdown: false };
}

/** A row with the full per-column breakdown Cursor's newer exports provide. */
function breakdown(parts: {
  rawInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}): CursorCostTokens {
  return {
    input: parts.rawInput + parts.cacheRead + parts.cacheWrite,
    output: parts.output,
    rawInput: parts.rawInput,
    cacheRead: parts.cacheRead,
    cacheWrite: parts.cacheWrite,
    hasBreakdown: true,
  };
}

describe('estimateCursorCostUSD', () => {
  it('prices Claude models written in Cursor’s dotted, version-first form', () => {
    // claude-4.5-sonnet -> claude-sonnet-4-5 ($3 / $15 per M)
    expect(estimateCursorCostUSD('claude-4.5-sonnet', aggregate(M, M))).toBeCloseTo(3 + 15);
    expect(estimateCursorCostUSD('claude-4-5-sonnet', aggregate(M, M))).toBeCloseTo(18);
    expect(estimateCursorCostUSD('claude-sonnet-4-5', aggregate(M, M))).toBeCloseTo(18);
  });

  it('prices a bare-major Claude id', () => {
    // claude-3-opus -> claude-opus-3 ($15 / $75 per M)
    expect(estimateCursorCostUSD('claude-3-opus', aggregate(M, M))).toBeCloseTo(15 + 75);
  });

  it('prices GPT-5-family ids by exact table key', () => {
    expect(estimateCursorCostUSD('gpt-5', aggregate(M, M))).toBeCloseTo(1.25 + 10);
    expect(estimateCursorCostUSD('gpt-5-codex', aggregate(M, M))).toBeCloseTo(1.25 + 10);
  });

  it('discounts cache reads and surcharges cache writes for Claude when the split is known', () => {
    // claude-sonnet-4-5: input $3/M, output $15/M, cache read 0.1x = $0.30/M,
    // cache write 1.25x = $3.75/M.
    const cost = estimateCursorCostUSD(
      'claude-4.5-sonnet',
      breakdown({ rawInput: M, cacheRead: M, cacheWrite: M, output: M }),
    );
    expect(cost).toBeCloseTo(3 + 0.3 + 3.75 + 15);

    // Same tokens with no split is charged at the full input rate — strictly more.
    expect(estimateCursorCostUSD('claude-4.5-sonnet', aggregate(3 * M, M))).toBeCloseTo(3 * 3 + 15);
    expect(cost).toBeLessThan(3 * 3 + 15);
  });

  it('applies the cache-read discount for GPT models', () => {
    // gpt-5: input $1.25/M, output $10/M, cache read 0.1x.
    const cost = estimateCursorCostUSD(
      'gpt-5',
      breakdown({ rawInput: M, cacheRead: M, cacheWrite: 0, output: M }),
    );
    expect(cost).toBeCloseTo(1.25 + 0.125 + 10);
  });

  it('leaves models with no tracked list price unpriced', () => {
    for (const model of [
      'gpt-4o',
      'gpt-4.1',
      'o3',
      'cursor-small',
      'composer-1',
      'auto',
      'default',
      'gemini-2.5-pro',
      'grok-4',
      'deepseek-v3',
    ]) {
      expect(
        estimateCursorCostUSD(
          model,
          breakdown({ rawInput: M, cacheRead: 0, cacheWrite: 0, output: M }),
        ),
      ).toBeUndefined();
    }
  });

  it('does not fall back to a family tier for an unknown Claude variant', () => {
    expect(estimateCursorCostUSD('claude-9-supernova', aggregate(M, M))).toBeUndefined();
  });
});
