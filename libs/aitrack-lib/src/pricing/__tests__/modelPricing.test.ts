import { describe, expect, it } from 'vitest';

import type { CompactCatalog } from '../codecs.js';
import { ModelPricing, modelPricingFromPack } from '../modelPricing.js';
import { supplementFromTables } from '../supplementFromTables.js';

const emptyCatalog: CompactCatalog = {
  retrievedAt: '2026-01-01T00:00:00.000Z',
  models: {},
};

function pricingWithCatalog(extra: CompactCatalog = emptyCatalog): ModelPricing {
  return modelPricingFromPack({
    supplement: supplementFromTables(),
    litellm: extra,
    modelsDev: emptyCatalog,
  });
}

describe('ModelPricing', () => {
  it('exposes supplement counts and native lookups', () => {
    const pricing = pricingWithCatalog();
    expect(pricing.claudeModelCount()).toBeGreaterThan(0);
    expect(pricing.codexModelCount()).toBeGreaterThan(0);
    expect(pricing.cursorModelCount()).toBeGreaterThan(0);
    expect(pricing.getSupplement().updatedAt).toBe(pricing.updatedAt);
    expect(pricing.lookupCursorNative('composer-2.5')?.inputPerMillion).toBe(0.5);
    expect(pricing.codexFamilyFallbacks().length).toBeGreaterThan(0);
  });

  it('resolves supplement rates for Claude, Codex, and Cursor natives', () => {
    const pricing = pricingWithCatalog();
    expect(pricing.resolveRates('claude-sonnet-4-6')?.source).toBe('supplement');
    expect(pricing.resolveRates('gpt-5.6-sol')?.source).toBe('supplement');
    expect(pricing.resolveRates('composer-2.5')?.source).toBe('supplement');
    expect(pricing.resolveRates('claude-sonnet-4-6')).toEqual(
      pricing.resolveRates('claude-sonnet-4-6'),
    );
  });

  it('applies Cursor aliases and fast multipliers', () => {
    const pricing = pricingWithCatalog();
    expect(pricing.applyCursorAlias('composer')).toBe('composer-2.5');
    const fast = pricing.resolveRates('gpt-5.6-sol-fast');
    expect(fast?.source).toBe('fast_multiplier');
    expect(fast?.inputPerMillion).toBeCloseTo(
      (pricing.resolveRates('gpt-5.6-sol')?.inputPerMillion ?? 0) * 2,
    );
  });

  it('falls back to Claude family rates for unknown family models', () => {
    const pricing = pricingWithCatalog();
    const rates = pricing.resolveRates('claude-unknown-opus-preview');
    expect(rates?.source).toBe('family_fallback');
    expect(rates?.inputPerMillion).toBe(pricing.claudeFamilyFallback('opus').inputPerMillion);
  });

  it('reads Cursor rates from catalog when supplement has no native row', () => {
    const litellm: CompactCatalog = {
      retrievedAt: '2026-01-01T00:00:00.000Z',
      models: {
        'cursor/catalog-only-model': {
          i: 1.5,
          o: 6,
          cw: 1.5,
          cr: 0.15,
        },
        'openai/implicit-cache-model': {
          i: 2,
          o: 8,
          cw: 2,
          cr: 0.2,
          cre: false,
          cwe: false,
        },
        'anthropic/claude-brand-new-9': {
          i: 7,
          o: 35,
          cw: 8.75,
          cr: 0.7,
        },
        'openai/gpt-9-catalog-only': {
          i: 3,
          o: 12,
          cw: 3,
          cr: 0.3,
        },
      },
    };
    const pricing = pricingWithCatalog(litellm);
    expect(pricing.catalogModelCount()).toBe(4);
    expect(pricing.catalogCursor('catalog-only-model')).toMatchObject({
      inputPerMillion: 1.5,
      outputPerMillion: 6,
      cacheReadPerMillion: 0.15,
      cacheWritePerMillion: 1.5,
    });
    expect(pricing.catalogCursor('implicit-cache-model')?.cacheWritePerMillion).toBe(2);
    expect(pricing.catalogCursor('missing-model')).toBeUndefined();
    expect(pricing.resolveRates('claude-brand-new-9')?.source).toBe('catalog');
    expect(pricing.lookupCatalogClaude('claude-brand-new-9')?.inputPerMillion).toBe(7);
    expect(pricing.lookupCatalogCodex('gpt-9-catalog-only')?.outputPerMillion).toBe(12);
    expect(pricing.resolveRates('totally-unknown-model')).toBeUndefined();
  });

  it('applies date overrides when present', () => {
    const supplement = structuredClone(supplementFromTables());
    const modelId = Object.keys(supplement.claude.models)[0];
    if (!modelId) throw new Error('expected Claude models');
    supplement.claude.overrides[modelId] = [
      {
        before: '2099-01-01',
        pricing: {
          inputPerMillion: 1,
          outputPerMillion: 2,
          cacheReadPerMillion: 0.1,
          cacheCreatePerMillion: 1.25,
        },
      },
    ];
    const pricing = new ModelPricing(
      supplement,
      { retrievedAt: emptyCatalog.retrievedAt, entries: new Map() },
      { retrievedAt: emptyCatalog.retrievedAt, entries: new Map() },
    );
    expect(pricing.lookupClaude(modelId, '2020-01-01')?.inputPerMillion).toBe(1);
    expect(pricing.lookupClaude(modelId, '2099-06-01')?.inputPerMillion).toBe(
      supplement.claude.models[modelId]?.inputPerMillion,
    );
  });
});
