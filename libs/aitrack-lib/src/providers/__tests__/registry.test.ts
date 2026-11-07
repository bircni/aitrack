import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isProviderKey, PROVIDER_DESCRIPTORS, QUOTA_PROVIDERS } from '../descriptors.js';
import {
  getProvider,
  liveProviders,
  normalizeProviderKey,
  PROVIDER_BY_ALIAS,
  PROVIDER_BY_KEY,
  PROVIDERS,
  providerKeys,
  syncedProviders,
} from '../index.js';

describe('provider registry', () => {
  it('builds on the descriptors, which stay free of runtime imports', () => {
    expect(PROVIDERS.map((provider) => provider.descriptor)).toEqual(
      Object.values(PROVIDER_DESCRIPTORS),
    );
    expect(QUOTA_PROVIDERS).toEqual(['claude_code', 'codex', 'cursor']);
    const source = readFileSync(new URL('../descriptors.ts', import.meta.url), 'utf8');
    expect(source.match(/^import (?!type ).*$/gmu)).toBeNull();
  });

  it('normalizes aliases regardless of case and rejects unknown names', () => {
    expect(normalizeProviderKey(' Claude-Code ')).toBe('claude_code');
    expect(normalizeProviderKey('gemini')).toBeNull();
  });

  it('accepts only canonical keys as provider keys', () => {
    expect(isProviderKey('claude_code')).toBe(true);
    for (const value of ['claude', 'toString', '__proto__', 1, null]) {
      expect(isProviderKey(value)).toBe(false);
    }
  });

  it('exposes claude_code, codex and cursor in display order', () => {
    expect(providerKeys()).toEqual(['claude_code', 'codex', 'cursor']);
  });

  it('indexes every provider by key and by each of its aliases', () => {
    for (const provider of PROVIDERS) {
      expect(PROVIDER_BY_KEY[provider.descriptor.key]).toBe(provider);
      for (const alias of provider.descriptor.aliases) {
        expect(PROVIDER_BY_ALIAS[alias]).toBe(provider);
      }
    }
  });

  it('getProvider returns undefined for an unknown key', () => {
    expect(getProvider('gemini')).toBeUndefined();
  });

  it('splits synced from live by which reader the provider carries', () => {
    expect(syncedProviders().map((p) => p.descriptor.key)).toEqual(['claude_code', 'codex']);
    expect(liveProviders().map((p) => p.descriptor.key)).toEqual(['cursor']);
  });

  it('gives every synced provider a readData and every live provider a liveFetch', () => {
    for (const provider of syncedProviders()) {
      expect(provider.reader.readData).toBeTypeOf('function');
    }
    for (const provider of liveProviders()) {
      expect(provider.live.liveFetch).toBeTypeOf('function');
    }
  });

  it('gives every provider a five-stop heatmap ramp for both themes', () => {
    for (const provider of PROVIDERS) {
      expect(provider.heatmap.light).toHaveLength(5);
      expect(provider.heatmap.dark).toHaveLength(5);
    }
  });

  it('routes pricing through the owning provider', () => {
    const counts = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      rawInputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    expect(
      getProvider('claude_code')?.pricing.priceModelCost(
        'claude-sonnet-4-5',
        counts,
        undefined,
        'recompute',
      ),
    ).toBeGreaterThan(0);
    expect(
      getProvider('cursor')?.pricing.priceModelCost(
        'claude-sonnet-4-5',
        counts,
        undefined,
        'merge',
      ),
    ).toBeGreaterThan(0);
    expect(
      getProvider('cursor')?.pricing.priceModelCost(
        'unknown-cursor-model',
        counts,
        undefined,
        'merge',
      ),
    ).toBeUndefined();
  });

  it('marks Claude as needing a breakdown to reprice and Codex as not', () => {
    expect(getProvider('claude_code')?.pricing.repriceRequiresBreakdown).toBe(true);
    expect(getProvider('codex')?.pricing.repriceRequiresBreakdown).toBeFalsy();
  });
});
