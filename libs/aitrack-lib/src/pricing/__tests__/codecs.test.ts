import { describe, expect, it } from 'vitest';

import {
  catalogFromCompact,
  catalogFromLiteLLM,
  catalogFromModelsDev,
  compactFromCatalog,
  findCatalogRates,
} from '../codecs.js';
import { isCompactCatalog } from '../validation.js';

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

  it('prefers anthropic/openai providers in models.dev without bare aliases', () => {
    const catalog = catalogFromModelsDev({
      cortecs: {
        models: {
          'claude-sonnet-4-6': { cost: { input: 2.9, output: 14.5 } },
        },
      },
      openai: {
        models: {
          shared: { cost: { input: 1, output: 2 } },
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
    expect(catalog.entries.has('claude-sonnet-4-6')).toBe(false);
    expect(catalog.entries.has('shared')).toBe(false);
    expect(findCatalogRates(catalog, 'claude-sonnet-4-6', ['anthropic'])?.rates).toMatchObject({
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheWriteIsExplicit: true,
    });
    expect(findCatalogRates(catalog, 'shared', ['anthropic'])).toBeUndefined();
    expect(findCatalogRates(catalog, 'shared', ['openai'])?.key).toBe('openai/shared');
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

  it('skips zero-cost and aggregator models.dev rows', () => {
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
    expect(overlay.entries.get('openai/gpt-5.6-sol')?.inputPerMillion).toBe(5);
    expect(overlay.entries.has('freebie')).toBe(false);
    expect(overlay.entries.has('ignored')).toBe(false);
  });

  it('drops negative required prices and defaults negative optional prices in both feeds', () => {
    const litellm = catalogFromLiteLLM({
      'openai/negative-input': { input_cost_per_token: -1, output_cost_per_token: 2e-6 },
      'openai/negative-output': { input_cost_per_token: 1e-6, output_cost_per_token: -1 },
      'openai/valid': {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        cache_creation_input_token_cost: -1,
        cache_read_input_token_cost: -1,
        input_cost_per_token_above_200k_tokens: -1,
        output_cost_per_token_above_200k_tokens: -1,
        cache_creation_input_token_cost_above_200k_tokens: -1,
        cache_read_input_token_cost_above_200k_tokens: -1,
        provider_specific_entry: { fast: -1 },
      },
      'openai/zero-input': { input_cost_per_token: 0, output_cost_per_token: 2e-6 },
    });
    const modelsDev = catalogFromModelsDev({
      openai: {
        models: {
          'negative-input': { cost: { input: -1, output: 2 } },
          'negative-output': { cost: { input: 1, output: -1 } },
          valid: { cost: { input: 1, output: 2, cache_write: -1, cache_read: -1 } },
          'zero-input': { cost: { input: 0, output: 2 } },
        },
      },
    });
    for (const catalog of [litellm, modelsDev]) {
      expect(catalog.entries.has('openai/negative-input')).toBe(false);
      expect(catalog.entries.has('openai/negative-output')).toBe(false);
      expect(catalog.entries.get('openai/valid')).toMatchObject({
        cacheWritePerMillion: 1,
        cacheWriteIsExplicit: false,
        cacheReadIsExplicit: false,
        fastMultiplier: 1,
      });
      const compact = compactFromCatalog(catalog);
      expect(compact.models['openai/valid']?.cr).toBeCloseTo(0.1);
      expect(compact.models['openai/valid']).toMatchObject({
        i: 1,
        o: 2,
        cw: 1,
        cre: false,
        cwe: false,
      });
      expect(catalog.entries.get('openai/zero-input')?.inputPerMillion).toBe(0);
      expect(isCompactCatalog(compactFromCatalog(catalog))).toBe(true);
    }
  });

  it('restricts qualified lookups to allowed providers and the supported gateway prefix', () => {
    const rates = { i: 1, o: 2, cw: 1, cr: 0.1 };
    const compact = (models: Record<string, typeof rates>) =>
      catalogFromCompact({ retrievedAt: '2026-01-01', models });

    for (const key of [
      'openai/shared',
      'other/anthropic/shared',
      'vercel_ai_gateway/openai/shared',
    ]) {
      const catalog = compact({ [key]: rates });
      expect(findCatalogRates(catalog, 'shared', ['anthropic'])).toBeUndefined();
      expect(findCatalogRates(catalog, key, ['anthropic'])).toBeUndefined();
    }
    for (const key of [
      'shared',
      'anthropic/shared',
      'anthropic/nested/shared',
      'vercel_ai_gateway/anthropic/shared',
    ]) {
      expect(findCatalogRates(compact({ [key]: rates }), 'shared', ['anthropic'])?.key).toBe(key);
    }

    const preferred = compact({ shared: rates, 'anthropic/shared': { ...rates, i: 3 } });
    expect(findCatalogRates(preferred, 'shared', ['anthropic'])?.rates.inputPerMillion).toBe(3);
  });

  it('rejects bare aliases when a disallowed provider owns the same model id', () => {
    const catalog = catalogFromCompact({
      retrievedAt: '2026-01-01',
      models: {
        shared: { i: 9, o: 9, cw: 9, cr: 0.9 },
        'openai/shared': { i: 1, o: 2, cw: 1, cr: 0.1 },
      },
    });
    expect(findCatalogRates(catalog, 'shared', ['anthropic'])).toBeUndefined();
    expect(findCatalogRates(catalog, 'shared', ['openai'])?.key).toBe('openai/shared');
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
