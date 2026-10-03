import { describe, expect, it } from 'vitest';

import type { CompactCatalog } from '../codecs.js';
import { type ModelPricing, modelPricingFromPack } from '../modelPricing.js';
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
    expect(pricing.lookupCursorNative('composer-2.5')?.inputPerMillion).toBe(0.5);
    expect(pricing.codexFamilyFallbacks().length).toBeGreaterThan(0);
  });

  it('applies Cursor aliases and exposes fast multipliers', () => {
    const pricing = pricingWithCatalog();
    expect(pricing.applyCursorAlias('composer')).toBe('composer-2.5');
    expect(pricing.cursorFastMultiplier('gpt-5.6-sol')).toBe(2);
  });

  it('fills Claude and Codex gaps from catalogs', () => {
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
    expect(pricing.lookupCatalogClaude('claude-brand-new-9')?.inputPerMillion).toBe(7);
    expect(pricing.lookupCatalogCodex('gpt-9-catalog-only')?.outputPerMillion).toBe(12);
    expect(pricing.lookupCatalogClaude('totally-unknown-model')).toBeUndefined();
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
    const pricing = modelPricingFromPack({
      supplement,
      litellm: emptyCatalog,
      modelsDev: emptyCatalog,
    });
    expect(pricing.lookupClaude(modelId, '2020-01-01')?.inputPerMillion).toBe(1);
    expect(pricing.lookupClaude(modelId, '2099-06-01')?.inputPerMillion).toBe(
      supplement.claude.models[modelId]?.inputPerMillion,
    );
  });
});
