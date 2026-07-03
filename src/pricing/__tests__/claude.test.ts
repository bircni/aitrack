import { describe, expect, it } from 'vitest';

import {
  CLAUDE_PRICING_OVERRIDES,
  consumeClaudeFallbackHits,
  findClaudePricing,
} from '../claude.js';

describe('claude pricing', () => {
  it('finds exact pricing for known model ids', () => {
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
  });

  it('falls back to family pricing for unknown models', () => {
    consumeClaudeFallbackHits();
    const opus = findClaudePricing('claude-opus-9-9');
    expect(opus.inputPerMillion).toBe(5);
    expect(consumeClaudeFallbackHits()).toEqual(['claude-opus-9-9']);
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
