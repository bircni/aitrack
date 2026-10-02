import { describe, expect, it } from 'vitest';

import {
  catalogFromCompact,
  catalogFromLiteLLM,
  catalogFromModelsDev,
  compactFromCatalog,
  findCatalogRates,
} from '../codecs.js';

describe('pricing codecs', () => {
  it('parses LiteLLM per-token costs into per-million rates with cache defaults', () => {
    const catalog = catalogFromLiteLLM({
      'anthropic/claude-sonnet-4-6': {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 15e-6,
      },
      'bedrock/skip-me': {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
    });
    const rates = catalog.entries.get('anthropic/claude-sonnet-4-6');
    expect(rates?.inputPerMillion).toBe(3);
    expect(rates?.outputPerMillion).toBe(15);
    expect(rates?.cacheWritePerMillion).toBe(3);
    expect(rates?.cacheReadPerMillion).toBeCloseTo(0.3);
    expect(rates?.cacheWriteIsExplicit).toBe(false);
    expect(rates?.cacheReadIsExplicit).toBe(false);
    expect(catalog.entries.has('bedrock/skip-me')).toBe(false);
  });

  it('prefers anthropic/openai providers in models.dev', () => {
    const catalog = catalogFromModelsDev({
      cortecs: {
        models: {
          'claude-sonnet-4-6': { cost: { input: 2.9, output: 14.5 } },
        },
      },
      anthropic: {
        models: {
          'claude-sonnet-4-6': {
            cost: { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
          },
        },
      },
    });
    expect(findCatalogRates(catalog, 'claude-sonnet-4-6', ['anthropic'])?.rates).toMatchObject({
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheWriteIsExplicit: true,
    });
  });

  it('round-trips compact catalogs', () => {
    const original = catalogFromLiteLLM({
      'openai/gpt-5.6-sol': {
        input_cost_per_token: 4e-6,
        output_cost_per_token: 20e-6,
        cache_read_input_token_cost: 4e-7,
      },
    });
    const compact = compactFromCatalog(original);
    const restored = catalogFromCompact(compact);
    expect(restored.entries.get('openai/gpt-5.6-sol')).toEqual(
      original.entries.get('openai/gpt-5.6-sol'),
    );
  });
});
