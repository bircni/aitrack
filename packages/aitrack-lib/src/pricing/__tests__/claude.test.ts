import { describe, expect, it } from 'vitest';

import { CLAUDE_PRICING_OVERRIDES, findClaudePricing } from '../claude.js';
import { createFallbackCollector } from '../fallback.js';

describe('claude pricing', () => {
  it('finds exact pricing for known model ids', () => {
    const opus5 = findClaudePricing('claude-opus-5');
    expect(opus5).toEqual({
      inputPerMillion: 5,
      outputPerMillion: 25,
      cacheReadPerMillion: 0.5,
      cacheCreatePerMillion: 6.25,
    });

    // Fable 5.1 and Mythos 5.1 bill cache hits at 0.025x input, not 0.1x.
    expect(findClaudePricing('claude-fable-5-1')).toEqual({
      inputPerMillion: 10,
      outputPerMillion: 50,
      cacheReadPerMillion: 0.25,
      cacheCreatePerMillion: 12.5,
    });
    expect(findClaudePricing('claude-mythos-5-1').cacheReadPerMillion).toBe(0.25);
    expect(findClaudePricing('claude-fable-5').cacheReadPerMillion).toBe(1);

    const sonnet = findClaudePricing('claude-sonnet-4-6');
    expect(sonnet.inputPerMillion).toBe(3);
    expect(sonnet.outputPerMillion).toBe(15);

    const sonnet5Intro = findClaudePricing('claude-sonnet-5', '2026-07-01');
    expect(sonnet5Intro.inputPerMillion).toBe(2);
    expect(sonnet5Intro.outputPerMillion).toBe(10);

    const sonnet5Standard = findClaudePricing('claude-sonnet-5', '2026-09-01');
    expect(sonnet5Standard.inputPerMillion).toBe(3);
    expect(sonnet5Standard.outputPerMillion).toBe(15);

    const dated = findClaudePricing('claude-haiku-4-5-20251001');
    expect(dated.inputPerMillion).toBe(1);
    expect(dated.outputPerMillion).toBe(5);

    const fallbacks = createFallbackCollector();
    const legacyVersionFirst = findClaudePricing('claude-3-5-haiku-20241022', undefined, fallbacks);
    expect(legacyVersionFirst.inputPerMillion).toBe(0.8);
    expect(legacyVersionFirst.outputPerMillion).toBe(4);
    expect(fallbacks.drain()).toEqual([]);
  });

  it('prices the Claude 3 generation from its own rates, not the modern tier', () => {
    const fallbacks = createFallbackCollector();

    // The opus family fallback ($5/$25) undercharges these by 3x.
    const opus3 = findClaudePricing('claude-3-opus-20240229', undefined, fallbacks);
    expect(opus3.inputPerMillion).toBe(15);
    expect(opus3.outputPerMillion).toBe(75);

    // The haiku family fallback ($1/$5) overcharges these by 4x.
    const haiku3 = findClaudePricing('claude-3-haiku-20240307', undefined, fallbacks);
    expect(haiku3.inputPerMillion).toBe(0.25);
    expect(haiku3.outputPerMillion).toBe(1.25);

    const sonnet37 = findClaudePricing('claude-3-7-sonnet-20250219', undefined, fallbacks);
    expect(sonnet37.inputPerMillion).toBe(3);
    expect(sonnet37.outputPerMillion).toBe(15);

    // Exact matches, so none of these should warn about a family fallback.
    expect(fallbacks.drain()).toEqual([]);
  });

  it('returns the same pricing on repeated lookups of one id', () => {
    // Canonicalization is memoized; make sure the cache does not blur ids that
    // normalize differently.
    expect(findClaudePricing('claude-opus-3').inputPerMillion).toBe(15);
    expect(findClaudePricing('claude-3-opus-20240229').inputPerMillion).toBe(15);
    expect(findClaudePricing('claude-opus-3').inputPerMillion).toBe(15);
    expect(findClaudePricing('claude-haiku-3').inputPerMillion).toBe(0.25);
    expect(findClaudePricing('CLAUDE-OPUS-3').inputPerMillion).toBe(15);
  });

  it('falls back to family pricing for unknown models', () => {
    const fallbacks = createFallbackCollector();
    const opus = findClaudePricing('claude-opus-9-9', undefined, fallbacks);
    expect(opus.inputPerMillion).toBe(5);
    expect(fallbacks.drain()).toEqual(['claude-opus-9-9']);
  });

  it('keeps unknown fable and mythos models on the top tier, not sonnet', () => {
    const fallbacks = createFallbackCollector();
    for (const model of ['claude-fable-6', 'claude-mythos-6']) {
      const pricing = findClaudePricing(model, undefined, fallbacks);
      expect(pricing.inputPerMillion).toBe(10);
      expect(pricing.outputPerMillion).toBe(50);
    }
    expect(fallbacks.drain()).toEqual(['claude-fable-6', 'claude-mythos-6']);
  });

  it('honors date-versioned pricing overrides', () => {
    CLAUDE_PRICING_OVERRIDES['claude-sonnet-4-6'] = [
      {
        before: '2026-04-01',
        pricing: {
          inputPerMillion: 4,
          outputPerMillion: 20,
          cacheReadPerMillion: 0.4,
          cacheCreatePerMillion: 5,
        },
      },
    ];
    try {
      expect(findClaudePricing('claude-sonnet-4-6', '2026-03-15').inputPerMillion).toBe(4);
      expect(findClaudePricing('claude-sonnet-4-6', '2026-05-15').inputPerMillion).toBe(3);
      expect(findClaudePricing('claude-sonnet-4-6').inputPerMillion).toBe(3);
    } finally {
      delete CLAUDE_PRICING_OVERRIDES['claude-sonnet-4-6'];
    }
  });
});
