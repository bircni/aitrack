import { describe, expect, it } from 'vitest';

import { estimateCursorCostUSD, resolveCursorRates } from '../cursor.js';
import { applyCursorAlias } from '../tables.js';

describe('cursor pricing', () => {
  it('prices composer-1 output at the published native rate', () => {
    expect(
      estimateCursorCostUSD('composer-1', {
        inputTokens: 0,
        outputTokens: 1_000_000,
        rawInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
    ).toBe(10);
  });

  it('prices Muse Spark four-bucket rows at the shared effort rate', () => {
    const counts = {
      inputTokens: 3_000_000,
      outputTokens: 1_000_000,
      rawInputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    };
    // $1.25 input + $1.25 cache write + $0.15 cache read + $4.25 output
    expect(estimateCursorCostUSD('muse-spark-1.3-xhigh', counts)).toBeCloseTo(6.9);
    expect(estimateCursorCostUSD('muse-spark-1.3-extra-high', counts)).toBeCloseTo(6.9);
  });

  it('maps Cursor Router labels and Claude effort slugs onto catalog rates', () => {
    expect(applyCursorAlias('Opus 5 (Auto Balanced)')).toBe('claude-opus-5');
    expect(applyCursorAlias('Opus 5.5 (Auto Balanced)')).toBe('claude-opus-5-5');
    expect(applyCursorAlias('claude-opus-4-8-thinking-max')).toBe('claude-opus-4-8');
    expect(applyCursorAlias('claude-opus-5-5-thinking-medium')).toBe('claude-opus-5-5');
    expect(resolveCursorRates('claude-opus-5')?.inputPerMillion).toBe(5);
    expect(resolveCursorRates('claude-opus-5-5')?.inputPerMillion).toBe(4);
    expect(resolveCursorRates('claude-opus-5-5-fast')?.inputPerMillion).toBe(8);
    expect(resolveCursorRates('claude-opus-4-8-thinking-max')?.inputPerMillion).toBe(5);
    expect(resolveCursorRates('gpt-6-sol')?.inputPerMillion).toBe(2);
    expect(resolveCursorRates('gpt-6-luna')?.inputPerMillion).toBe(0.1);
    expect(resolveCursorRates('grok-4.7')?.inputPerMillion).toBe(2);
  });

  it('applies the GPT-5.5 fast multiplier instead of the standard-speed rate', () => {
    const standard = resolveCursorRates('gpt-5.5');
    const fast = resolveCursorRates('gpt-5.5-extra-high-fast');
    expect(standard?.inputPerMillion).toBe(5);
    expect(fast?.inputPerMillion).toBe(12.5);
  });

  it('leaves unknown models unpriced instead of guessing a family rate', () => {
    expect(resolveCursorRates('totally-unknown-model-xyz')).toBeUndefined();
    expect(
      estimateCursorCostUSD('totally-unknown-model-xyz', {
        inputTokens: 1000,
        outputTokens: 100,
      }),
    ).toBeUndefined();
  });

  it('does not price a -fast slug when no multiplier is published', () => {
    expect(resolveCursorRates('composer-1-fast')).toBeUndefined();
    expect(resolveCursorRates('-fast')).toBeUndefined();
  });

  it('treats a missing cache breakdown as uncached input', () => {
    expect(estimateCursorCostUSD('composer-1', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      1.25,
    );
  });

  it('prices Gemini 3.8 Flash effort slugs from the Cursor table', () => {
    expect(
      estimateCursorCostUSD('gemini-3.8-flash-high', {
        inputTokens: 3_000_000,
        outputTokens: 1_000_000,
        rawInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      }),
    ).toBeCloseTo(5.075);
  });
});
