import { describe, expect, it } from 'vitest';

import {
  catalogFromCompact,
  catalogFromLiteLLM,
  catalogFromModelsDev,
  compactFromCatalog,
  findCatalogRates,
  mergeCatalogs,
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

  it('parses LiteLLM long-context and provider-specific fast multipliers', () => {
    const catalog = catalogFromLiteLLM({
      'anthropic/claude-sonnet-4-6': {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 15e-6,
        input_cost_per_token_above_200k_tokens: 6e-6,
        output_cost_per_token_above_200k_tokens: 22.5e-6,
        cache_creation_input_token_cost_above_200k_tokens: 7.5e-6,
        cache_read_input_token_cost_above_200k_tokens: 0.6e-6,
        provider_specific_entry: { fast: 2 },
      },
    });
    expect(catalog.entries.get('anthropic/claude-sonnet-4-6')).toMatchObject({
      inputAbove200kPerMillion: 6,
      outputAbove200kPerMillion: 22.5,
      cacheWriteAbove200kPerMillion: 7.5,
      cacheReadAbove200kPerMillion: 0.6,
      fastMultiplier: 2,
    });
  });

  it('merges catalogs and skips zero-cost models.dev rows', () => {
    const base = catalogFromLiteLLM({
      'openai/gpt-5.6-sol': {
        input_cost_per_token: 4e-6,
        output_cost_per_token: 20e-6,
      },
    });
    const overlay = catalogFromModelsDev({
      openai: {
        models: {
          'gpt-5.6-sol': { cost: { input: 5, output: 25 } },
          freebie: { cost: { input: 0, output: 0 } },
        },
      },
      cortecs: {
        models: {
          ignored: { cost: { input: 1, output: 2 } },
        },
      },
    });
    const merged = mergeCatalogs(base, overlay);
    expect(merged.entries.get('openai/gpt-5.6-sol')?.inputPerMillion).toBe(5);
    expect(merged.entries.has('freebie')).toBe(false);
    expect(findCatalogRates(merged, 'gpt-5.6-sol', ['openai'])?.rates.outputPerMillion).toBe(25);
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
