import { describe, expect, it } from 'vitest';

import { CODEX_PRICING_OVERRIDES, estimateCodexCostUSD, findCodexPricing } from '../codex.js';
import { createFallbackCollector } from '../fallback.js';

describe('codex pricing', () => {
  it('costs 1M+1M tokens correctly for known models', () => {
    expect(estimateCodexCostUSD('gpt-6-astra', 1_000_000, 1_000_000)).toBe(60);
    expect(estimateCodexCostUSD('gpt-5.6-sol', 1_000_000, 1_000_000)).toBe(24);
    expect(estimateCodexCostUSD('gpt-5.6-terra', 1_000_000, 1_000_000)).toBe(14);
    expect(estimateCodexCostUSD('gpt-5.6-luna', 1_000_000, 1_000_000)).toBe(1.4);
    expect(estimateCodexCostUSD('gpt-5.5', 1_000_000, 1_000_000)).toBe(35);
    expect(estimateCodexCostUSD('gpt-5.5-pro', 1_000_000, 1_000_000)).toBe(210);
    expect(estimateCodexCostUSD('gpt-5.4', 1_000_000, 1_000_000)).toBe(17.5);
    expect(estimateCodexCostUSD('gpt-5.4-pro', 1_000_000, 1_000_000)).toBe(210);
    expect(estimateCodexCostUSD('gpt-5.1-codex', 1_000_000, 1_000_000)).toBe(11.25);
    expect(estimateCodexCostUSD('gpt-5.1-codex-mini', 1_000_000, 1_000_000)).toBe(2.25);
    expect(estimateCodexCostUSD('gpt-5.3-codex', 1_000_000, 1_000_000)).toBe(15.75);
  });

  it('falls back to family pricing by suffix', () => {
    // unknown -mini -> mini fallback ($0.25/$2)
    const mini = findCodexPricing('gpt-5.9-codex-mini');
    expect(mini?.inputPerMillion).toBe(0.25);
    expect(mini?.outputPerMillion).toBe(2);
    // unknown -codex -> codex fallback
    const codex = findCodexPricing('gpt-5.9-codex');
    expect(codex?.inputPerMillion).toBe(1.25);
    // unknown -nano -> nano fallback, which must win over the gpt-5 catch-all
    const nano = findCodexPricing('gpt-5.9-nano');
    expect(nano?.inputPerMillion).toBe(0.2);
    expect(nano?.outputPerMillion).toBe(1.25);
    // plain unknown gpt-5 variant -> the base gpt-5 rate
    const bare = findCodexPricing('gpt-5.9');
    expect(bare?.inputPerMillion).toBe(1.25);
    expect(bare?.outputPerMillion).toBe(10);
  });

  it('bills cached input at 10% of base', () => {
    // gpt-5.1-codex: $1.25 input / $10 output.
    // 1M input, 900k of which is cached, 100k output:
    //   fresh   = 100k * 1.25/M = 0.125
    //   cached  = 900k * 0.125/M = 0.1125
    //   output  = 100k * 10/M = 1.0
    //   total   = 1.2375
    expect(estimateCodexCostUSD('gpt-5.1-codex', 1_000_000, 100_000, 900_000)).toBeCloseTo(1.2375);
    // No cache argument -> same as cached=0
    expect(estimateCodexCostUSD('gpt-5.1-codex', 1_000_000, 100_000)).toBeCloseTo(2.25);
  });

  it('honors date-versioned pricing overrides', () => {
    // Simulate Anthropic-style scenario: a model's price changes mid-life.
    // Before 2026-04-01 gpt-5.4 cost $4 / $20; after, $2.50 / $15 (current).
    CODEX_PRICING_OVERRIDES['gpt-5.4'] = [
      { before: '2026-04-01', pricing: { inputPerMillion: 4, outputPerMillion: 20 } },
    ];
    try {
      // Old session: should use the override.
      expect(estimateCodexCostUSD('gpt-5.4', 1_000_000, 1_000_000, 0, '2026-03-15')).toBe(24);
      // New session: should use current pricing.
      expect(estimateCodexCostUSD('gpt-5.4', 1_000_000, 1_000_000, 0, '2026-05-15')).toBe(17.5);
      // No date: latest pricing.
      expect(estimateCodexCostUSD('gpt-5.4', 1_000_000, 1_000_000)).toBe(17.5);
    } finally {
      delete CODEX_PRICING_OVERRIDES['gpt-5.4'];
    }
  });

  it('prices gpt-5.6 sessions at the rate in effect on the usage date', () => {
    // OpenAI cut Terra and Luna on 2026-07-30, then Sol on 2026-08-21.
    // Terra: $2.50/$15 -> $2/$12, Luna: $1/$6 -> $0.20/$1.20, Sol: $5/$30 -> $4/$20.
    expect(estimateCodexCostUSD('gpt-5.6-terra', 1_000_000, 1_000_000, 0, '2026-07-29')).toBe(17.5);
    expect(estimateCodexCostUSD('gpt-5.6-terra', 1_000_000, 1_000_000, 0, '2026-07-30')).toBe(14);
    expect(estimateCodexCostUSD('gpt-5.6-luna', 1_000_000, 1_000_000, 0, '2026-07-29')).toBe(7);
    expect(estimateCodexCostUSD('gpt-5.6-luna', 1_000_000, 1_000_000, 0, '2026-07-30')).toBe(1.4);
    expect(estimateCodexCostUSD('gpt-5.6-sol', 1_000_000, 1_000_000, 0, '2026-07-29')).toBe(35);
    expect(estimateCodexCostUSD('gpt-5.6-sol', 1_000_000, 1_000_000, 0, '2026-08-20')).toBe(35);
    expect(estimateCodexCostUSD('gpt-5.6-sol', 1_000_000, 1_000_000, 0, '2026-08-21')).toBe(24);
  });

  it('records fallback hits for unknown models', () => {
    const fallbacks = createFallbackCollector();
    findCodexPricing('gpt-5.9-codex-mini', undefined, fallbacks);
    findCodexPricing('gpt-5.9', undefined, fallbacks);
    expect(fallbacks.drain()).toEqual(['gpt-5.9', 'gpt-5.9-codex-mini']);
    // drained → empty next time
    expect(fallbacks.drain()).toEqual([]);
  });

  it("keeps each run's fallback hits to itself", () => {
    // The old module-level Set leaked hits between runs, so a long-lived process
    // reported one tick's unknown models on the next tick.
    const first = createFallbackCollector();
    findCodexPricing('gpt-5.9', undefined, first);
    expect(first.drain()).toEqual(['gpt-5.9']);

    const second = createFallbackCollector();
    expect(second.drain()).toEqual([]);
  });

  it('returns undefined for non-gpt-5 models', () => {
    expect(findCodexPricing('davinci')).toBeUndefined();
    expect(estimateCodexCostUSD('unknown', 1000, 500)).toBeUndefined();
  });
});
