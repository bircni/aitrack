import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_PRICING_BY_ID,
  CLAUDE_PRICING_OVERRIDES,
  estimateClaudeCostUSD,
  findClaudePricing,
  lookupClaudePricing,
} from '../claude.js';
import {
  CODEX_PRICING_BY_ID,
  CODEX_PRICING_CURRENT,
  CODEX_PRICING_HISTORICAL,
  CODEX_PRICING_OVERRIDES,
  estimateCodexCostUSD,
  findCodexPricing,
  lookupCodexPricing,
} from '../codex.js';
import {
  CURSOR_FAST_MULTIPLIERS,
  CURSOR_MODELS,
  estimateCursorCostUSD,
  resolveCursorRates,
} from '../cursor.js';
import type { PricingManifest, PricingSupplement } from '../packMeta.js';
import { pricingPackBaseUrl } from '../packMeta.js';
import {
  currentModelPricing,
  PricingStore,
  resetSharedPricingStore,
  sharedPricingStore,
} from '../store.js';
import { supplementFromTables } from '../supplementFromTables.js';
import { syncPricingPack } from '../syncPack.js';
import { CLAUDE_FAMILY_FALLBACK, CODEX_FAMILY_FALLBACK } from '../tables.js';

const directories: string[] = [];
afterEach(async () => {
  resetSharedPricingStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function updateHashes(files: Record<string, string>): void {
  const manifest = JSON.parse(files['manifest.json'] ?? '') as PricingManifest;
  manifest.hashes = {
    supplement: createHash('sha256')
      .update(files['supplement.json'] ?? '')
      .digest('hex'),
    litellm: createHash('sha256')
      .update(files['litellm.json'] ?? '')
      .digest('hex'),
    modelsDev: createHash('sha256')
      .update(files['models_dev.json'] ?? '')
      .digest('hex'),
  };
  files['manifest.json'] = JSON.stringify(manifest);
}

async function fixture(modify?: (supplement: PricingSupplement) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-'));
  directories.push(dir);
  const supplement = supplementFromTables();
  supplement.updatedAt = '2099-01-01T00:00:00.000Z';
  supplement.claude.models['claude-sonnet-4-6'] = {
    inputPerMillion: 9,
    outputPerMillion: 45,
    cacheReadPerMillion: 0.9,
    cacheCreatePerMillion: 11.25,
  };
  modify?.(supplement);
  const catalog = {
    retrievedAt: supplement.updatedAt,
    models: { stub: { i: 1, o: 2, cw: 1, cr: 0.1 } },
  };
  const files: Record<string, string> = {
    'supplement.json': JSON.stringify(supplement),
    'litellm.json': JSON.stringify(catalog),
    'models_dev.json': JSON.stringify(catalog),
  };
  const manifest: PricingManifest = {
    schemaVersion: 1,
    updatedAt: supplement.updatedAt,
    files: { supplement: 'supplement.json', litellm: 'litellm.json', modelsDev: 'models_dev.json' },
    hashes: {
      supplement: createHash('sha256')
        .update(files['supplement.json'] ?? '')
        .digest('hex'),
      litellm: createHash('sha256')
        .update(files['litellm.json'] ?? '')
        .digest('hex'),
      modelsDev: createHash('sha256')
        .update(files['models_dev.json'] ?? '')
        .digest('hex'),
    },
  };
  files['manifest.json'] = JSON.stringify(manifest);
  const fetchMock = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    const name =
      (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        .split('/')
        .at(-1) ?? '';
    if ((options?.headers as Record<string, string> | undefined)?.['if-none-match']) {
      return Promise.resolve(new Response(null, { status: 304 }));
    }
    return Promise.resolve(
      new Response(files[name] ?? 'missing', {
        status: files[name] ? 200 : 404,
        headers: { etag: `"${name}"` },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('AITRACK_PRICING_URL', 'https://example.test/pricing');
  vi.stubEnv('AITRACK_NO_PRICING_REFRESH', '0');
  async function cache(fetchedAt = '2000-01-01T00:00:00.000Z') {
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        sources: Object.fromEntries(
          ['manifest', 'supplement', 'litellm', 'modelsDev'].map((key) => [
            key,
            { etag: `"${key}"`, fetchedAt },
          ]),
        ),
      }),
    );
  }
  return { dir, supplement, files, fetchMock, cache };
}

describe('PricingStore', () => {
  it.each(['claude', 'codex', 'codexCurrent', 'codexHistorical', 'cursor'] as const)(
    'keeps mutable %s model exports connected to costs and refreshes',
    async (provider) => {
      const { dir } = await fixture();
      const store = new PricingStore(dir);
      vi.spyOn(sharedPricingStore(), 'current').mockImplementation(() => store.current());
      const exports = {
        claude: CLAUDE_PRICING_BY_ID,
        codex: CODEX_PRICING_BY_ID,
        codexCurrent: CODEX_PRICING_CURRENT,
        codexHistorical: CODEX_PRICING_HISTORICAL,
        cursor: CURSOR_MODELS,
      };
      const model = 'custom-pricing-model';
      const pricing = {
        inputPerMillion: 7,
        outputPerMillion: 35,
        cacheReadPerMillion: 0.7,
        cacheCreatePerMillion: 8.75,
        cacheWritePerMillion: 8.75,
      };
      const models = exports[provider];
      const cost = {
        claude: () =>
          estimateClaudeCostUSD(model, { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
        codex: () => estimateCodexCostUSD(model, 1_000_000, 1_000_000),
        codexCurrent: () => estimateCodexCostUSD(model, 1_000_000, 1_000_000),
        codexHistorical: () => estimateCodexCostUSD(model, 1_000_000, 1_000_000),
        cursor: () =>
          estimateCursorCostUSD(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      }[provider];
      expect(cost()).toBeUndefined();
      models[model] = pricing;
      expect(cost()).toBe(42);
      expect(Object.keys(models)).toContain(model);
      expect({ ...models }[model]).toBe(pricing);
      pricing.inputPerMillion = 8;
      expect(cost()).toBe(43);
      Object.assign(models[model] ?? {}, { outputPerMillion: 40 });
      expect(cost()).toBe(48);
      models[model] = { ...pricing, inputPerMillion: 9 };
      expect(cost()).toBe(49);
      expect(Reflect.defineProperty(models, model, { value: pricing })).toBe(false);
      expect(Reflect.preventExtensions(models)).toBe(false);
      expect(Reflect.deleteProperty(models, model)).toBe(true);
      expect(cost()).toBeUndefined();
      models[model] = pricing;
      await expect(store.refreshIfDue(true)).resolves.toMatchObject({ updated: true });
      expect(cost()).toBeUndefined();
      expect(model in models).toBe(false);
    },
  );

  it('shares Codex rows between the combined and current/historical exports', async () => {
    const { dir } = await fixture();
    const store = new PricingStore(dir);
    vi.spyOn(sharedPricingStore(), 'current').mockImplementation(() => store.current());
    const pricing = { inputPerMillion: 7, outputPerMillion: 35 };
    CODEX_PRICING_BY_ID['gpt-5.4'] = pricing;
    expect(CODEX_PRICING_CURRENT['gpt-5.4']).toBe(pricing);
    CODEX_PRICING_BY_ID['gpt-5.1'] = pricing;
    expect(CODEX_PRICING_HISTORICAL['gpt-5.1']).toBe(pricing);
    Reflect.deleteProperty(CODEX_PRICING_BY_ID, 'gpt-5.1');
    expect(lookupCodexPricing('gpt-5.1')).toBeUndefined();
    await store.refreshIfDue(true);
    expect(CODEX_PRICING_BY_ID['gpt-5.4']).toEqual(CODEX_PRICING_CURRENT['gpt-5.4']);
    expect(lookupCodexPricing('gpt-5.4')?.inputPerMillion).toBe(2.5);
  });

  it.each(['claude', 'codex'] as const)(
    'preserves dated %s prices when base rates change and refresh',
    async (provider) => {
      const historical = {
        inputPerMillion: 4,
        outputPerMillion: 20,
        cacheReadPerMillion: 0.4,
        cacheCreatePerMillion: 5,
      };
      const { dir } = await fixture((remote) => {
        remote.claude.overrides['claude-sonnet-4-6'] = [
          { before: '2026-04-01', pricing: historical },
        ];
        remote.codex.overrides['gpt-5.4'] = [{ before: '2026-04-01', pricing: historical }];
      });
      const store = new PricingStore(dir);
      vi.spyOn(sharedPricingStore(), 'current').mockImplementation(() => store.current());
      const model = provider === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.4';
      const models = provider === 'claude' ? CLAUDE_PRICING_BY_ID : CODEX_PRICING_BY_ID;
      const overrides = provider === 'claude' ? CLAUDE_PRICING_OVERRIDES : CODEX_PRICING_OVERRIDES;
      const cost =
        provider === 'claude'
          ? (date?: string) => estimateClaudeCostUSD(model, { input_tokens: 1_000_000 }, date)
          : (date?: string) => estimateCodexCostUSD(model, 1_000_000, 0, 0, date);
      overrides[model] = [{ before: '2026-04-01', pricing: historical }];
      const current = { ...historical, inputPerMillion: 7 };
      models[model] = current;
      expect(cost('2026-03-31')).toBe(4);
      expect(cost('2026-04-01')).toBe(7);
      expect(cost()).toBe(7);
      current.inputPerMillion = 8;
      expect(cost('2026-03-31')).toBe(4);
      expect(cost('2026-04-01')).toBe(8);
      await store.refreshIfDue(true);
      expect(cost('2026-03-31')).toBe(4);
      expect(cost('2026-04-01')).toBe(provider === 'claude' ? 9 : 2.5);
    },
  );

  it('uses mutable family fallbacks and fast multipliers in live resolvers', async () => {
    const { dir } = await fixture();
    const store = new PricingStore(dir);
    vi.spyOn(sharedPricingStore(), 'current').mockImplementation(() => store.current());
    CLAUDE_FAMILY_FALLBACK.sonnet = {
      inputPerMillion: 7,
      outputPerMillion: 35,
      cacheReadPerMillion: 0.7,
      cacheCreatePerMillion: 8.75,
    };
    expect(findClaudePricing('claude-sonnet-future')?.inputPerMillion).toBe(7);
    CLAUDE_FAMILY_FALLBACK.sonnet.inputPerMillion = 8;
    expect(findClaudePricing('claude-sonnet-future')?.inputPerMillion).toBe(8);
    CODEX_FAMILY_FALLBACK.unshift({
      match: /^custom-fallback$/u,
      pricing: { inputPerMillion: 7, outputPerMillion: 35 },
    });
    expect(findCodexPricing('custom-fallback')?.inputPerMillion).toBe(7);
    Object.assign(CODEX_FAMILY_FALLBACK[0]?.pricing ?? {}, { inputPerMillion: 8 });
    expect(findCodexPricing('custom-fallback')?.inputPerMillion).toBe(8);
    CURSOR_FAST_MULTIPLIERS['gpt-5.4'] = 3;
    expect(resolveCursorRates('gpt-5.4-fast')?.inputPerMillion).toBe(7.5);
    expect(Array.isArray(CODEX_FAMILY_FALLBACK)).toBe(true);
    expect([...CODEX_FAMILY_FALLBACK][0]?.match.source).toBe('^custom-fallback$');
    expect(Object.keys(CODEX_FAMILY_FALLBACK)).toContain('0');
    await store.refreshIfDue(true);
    expect(findClaudePricing('claude-sonnet-future')?.inputPerMillion).toBe(3);
    expect(findCodexPricing('custom-fallback')).toBeUndefined();
    expect(resolveCursorRates('gpt-5.4-fast')?.inputPerMillion).toBe(5);
  });
  it('loads the offline baseline and a complete newer disk pack without init', async () => {
    const { dir, cache } = await fixture();
    const store = new PricingStore(dir);
    expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(3);
    expect(store.current().lookupCodex('gpt-5.6-sol')?.outputPerMillion).toBe(20);
    expect(store.current().lookupCursorNative('composer-2.5')?.inputPerMillion).toBe(0.5);
    await cache();
    expect(new PricingStore(dir).current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(
      9,
    );
  });

  it('uses refreshed overrides through the actual provider resolvers', async () => {
    const { dir } = await fixture((supplement) => {
      supplement.claude.overrides['claude-sonnet-4-6'] = [
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
      supplement.codex.overrides['gpt-5.4'] = [
        { before: '2026-04-01', pricing: { inputPerMillion: 4, outputPerMillion: 20 } },
      ];
    });
    const store = new PricingStore(dir);
    vi.spyOn(sharedPricingStore(), 'current').mockImplementation(() => store.current());
    await store.refreshIfDue(true);
    expect(findClaudePricing('claude-sonnet-4-6', '2026-03-15')?.inputPerMillion).toBe(4);
    expect(findClaudePricing('claude-sonnet-4-6', '2026-04-01')?.inputPerMillion).toBe(9);
    expect(estimateCodexCostUSD('gpt-5.4', 1_000_000, 1_000_000, 0, '2026-03-15')).toBe(24);
    expect(estimateCodexCostUSD('gpt-5.4', 1_000_000, 1_000_000, 0, '2026-04-01')).toBe(17.5);
    expect(resolveCursorRates('composer')?.inputPerMillion).toBe(0.5);
    expect(resolveCursorRates('stub')).toBeUndefined();
  });

  it.each(['disk', 'refresh'] as const)(
    'retains bundled entries missing from a newer supplement on %s',
    async (source) => {
      const local = supplementFromTables();
      const { dir, cache, files, supplement } = await fixture((remote) => {
        remote.claude.models = Object.fromEntries(
          Object.entries(remote.claude.models).filter(([model]) => model === 'claude-sonnet-4-6'),
        );
        remote.claude.overrides = {};
        remote.codex.current = { 'gpt-5.4': { inputPerMillion: 8, outputPerMillion: 40 } };
        remote.codex.historical = {};
        remote.codex.overrides = {};
        remote.codex.familyFallback = [
          { match: '-nano$', inputPerMillion: 8, outputPerMillion: 40 },
        ];
        remote.cursor.models = {};
        remote.cursor.fastMultipliers = { 'gpt-5.4': 3 };
        remote.cursor.aliases = [{ pattern: '^default$', canonical: 'composer-2.5' }];
      });
      if (source === 'disk') await cache();
      const store = new PricingStore(dir);
      if (source === 'refresh') await store.refreshIfDue(true);
      const check = (pricing: ReturnType<PricingStore['current']>) => {
        expect(pricing.updatedAt).toBe(supplement.updatedAt);
        expect(pricing.lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(9);
        expect(pricing.lookupClaude('claude-opus-4-8')).toEqual(
          local.claude.models['claude-opus-4-8'],
        );
        expect(pricing.pricingOverrides('claude')).toEqual(local.claude.overrides);
        expect(pricing.lookupCodex('gpt-5.4')?.inputPerMillion).toBe(8);
        expect(pricing.lookupCodex('gpt-6.1-sol')).toEqual(local.codex.current['gpt-6.1-sol']);
        expect(pricing.lookupCodex('gpt-5.1')).toEqual(local.codex.historical['gpt-5.1']);
        expect(pricing.lookupCodex('gpt-5.6-sol', '2026-08-01')).toEqual(
          local.codex.overrides['gpt-5.6-sol']?.[0]?.pricing,
        );
        const fallbacks = pricing.codexFamilyFallbacks();
        expect(fallbacks.filter((rule) => rule.match.source === '-nano$')).toHaveLength(1);
        expect(
          fallbacks.find((rule) => rule.match.test('unknown-nano'))?.pricing.inputPerMillion,
        ).toBe(8);
        expect(
          fallbacks.find((rule) => rule.match.test('gpt-6-future'))?.pricing.inputPerMillion,
        ).toBe(10);
        expect(pricing.lookupCursorNative('composer-2.5')).toEqual(
          local.cursor.models['composer-2.5'],
        );
        expect(pricing.cursorFastMultiplier('gpt-5.4')).toBe(3);
        expect(pricing.cursorFastMultiplier('gpt-6.1-sol')).toBe(2);
        expect(pricing.applyCursorAlias('default')).toBe('composer-2.5');
        expect(pricing.applyCursorAlias('composer')).toBe('composer-2.5');
      };
      check(store.current());
      check(new PricingStore(dir).current());
      await expect(store.refreshIfDue(true)).resolves.toMatchObject({ updated: false });
      expect(JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8'))).toEqual(files);
      check(store.current());
    },
  );

  it.each(['2000-01-01T00:00:00.000Z', supplementFromTables().updatedAt])(
    'keeps bundled rates when the supplement timestamp is %s',
    async (updatedAt) => {
      const { dir, cache } = await fixture((remote) => {
        remote.updatedAt = updatedAt;
      });
      await cache();
      const store = new PricingStore(dir);
      expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(3);
      vi.spyOn(sharedPricingStore(), 'current').mockImplementation(() => store.current());
      Object.assign(CLAUDE_PRICING_BY_ID['claude-sonnet-4-6'] ?? {}, { inputPerMillion: 7 });
      expect(lookupClaudePricing('claude-sonnet-4-6')?.inputPerMillion).toBe(7);
      await store.refreshIfDue(true);
      expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(3);
    },
  );

  it.each(['claude', 'codex'] as const)(
    'keeps the mutable %s override export synchronized with lookups and refreshes',
    async (provider) => {
      const { dir } = await fixture((supplement) => {
        const pricing = {
          inputPerMillion: 4,
          outputPerMillion: 20,
          cacheReadPerMillion: 0.4,
          cacheCreatePerMillion: 5,
        };
        supplement.claude.overrides['claude-sonnet-4-6'] = [{ before: '2026-04-01', pricing }];
        supplement.codex.overrides['gpt-5.4'] = [{ before: '2026-04-01', pricing }];
      });
      const store = new PricingStore(dir);
      vi.spyOn(sharedPricingStore(), 'current').mockImplementation(() => store.current());
      const overrides = provider === 'claude' ? CLAUDE_PRICING_OVERRIDES : CODEX_PRICING_OVERRIDES;
      const lookup = provider === 'claude' ? lookupClaudePricing : lookupCodexPricing;
      const model = provider === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.4';
      const baseline = lookup(model);
      const pricing = {
        inputPerMillion: 7,
        outputPerMillion: 35,
        cacheReadPerMillion: 0.7,
        cacheCreatePerMillion: 8.75,
      };
      overrides[model] = [{ before: '2026-04-01', pricing }];
      expect(lookup(model, '2026-03-15')?.inputPerMillion).toBe(7);
      expect(lookup(model, '2026-04-01')).toEqual(baseline);
      expect(lookup(model)).toEqual(baseline);
      pricing.inputPerMillion = 8;
      expect(lookup(model, '2026-03-15')?.inputPerMillion).toBe(8);
      expect(Object.keys(overrides)).toContain(model);
      expect(model in overrides).toBe(true);
      expect({ ...overrides }[model]).toEqual([{ before: '2026-04-01', pricing }]);
      expect(Reflect.defineProperty(overrides, model, { value: [] })).toBe(false);
      expect(Reflect.preventExtensions(overrides)).toBe(false);
      expect(Object.keys(overrides)).toContain(model);
      expect(lookup(model, '2026-03-15')?.inputPerMillion).toBe(8);
      Reflect.deleteProperty(overrides, model);
      expect(lookup(model, '2026-03-15')).toEqual(baseline);
      await expect(store.refreshIfDue(true)).resolves.toMatchObject({ updated: true });
      expect(overrides[model][0]?.pricing.inputPerMillion).toBe(4);
      expect(lookup(model, '2026-03-15')?.inputPerMillion).toBe(4);
      overrides[model].push({ before: '2026-05-01', pricing });
      expect(lookup(model, '2026-04-15')?.inputPerMillion).toBe(8);
      await expect(store.refreshIfDue(true)).resolves.toMatchObject({ updated: false });
      expect(lookup(model, '2026-04-15')).toEqual(lookup(model));
    },
  );

  it('preserves downloaded bytes and reuses hashed cache files on HTTP 304', async () => {
    const { dir, files, fetchMock } = await fixture();
    const store = new PricingStore(dir);
    await expect(store.refreshIfDue(true)).resolves.toMatchObject({ updated: true });
    const cached = JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(cached).toEqual(files);
    fetchMock.mockClear();
    await expect(store.refreshIfDue(true)).resolves.toMatchObject({ updated: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(9);
    expect(new PricingStore(dir).current().updatedAt).toBe(store.current().updatedAt);
  });

  it('skips fresh caches, honors failure backoff, and allows a forced retry', async () => {
    const { dir, cache, fetchMock } = await fixture();
    await cache(new Date().toISOString());
    const store = new PricingStore(dir);
    await expect(store.refreshIfDue()).resolves.toMatchObject({ reason: 'cache still fresh' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const result = await store.refreshIfDue(true);

    expect(result.reason).toContain('refresh failed: offline');
    fetchMock.mockClear();
    await expect(store.refreshIfDue()).resolves.toMatchObject({ updated: false });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(store.refreshIfDue(true)).resolves.toMatchObject({
      reason: 'remote pack unchanged',
    });
  });

  it('backs off after a failed first fetch across process restarts', async () => {
    const { dir, fetchMock } = await fixture();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await new PricingStore(dir).refreshIfDue();
    fetchMock.mockClear();
    await expect(new PricingStore(dir).refreshIfDue()).resolves.toMatchObject({ updated: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables refresh and deduplicates simultaneous requests', async () => {
    const { dir, fetchMock } = await fixture();
    const store = new PricingStore(dir);
    vi.stubEnv('AITRACK_NO_PRICING_REFRESH', '1');
    const result = await store.refreshIfDue(true);

    expect(result.reason).toContain('AITRACK_NO_PRICING_REFRESH');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv('AITRACK_NO_PRICING_REFRESH', '0');
    const first = store.refreshIfDue(true);
    expect(store.refreshIfDue(true)).toBe(first);
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(['manifest.json', 'supplement.json', 'litellm.json', 'models_dev.json'])(
    'refetches a corrupt %s on HTTP 304',
    async (name) => {
      const { dir, cache, fetchMock } = await fixture();
      await cache(new Date().toISOString());
      await writeFile(join(dir, name), '{not-json');
      const store = new PricingStore(dir);
      expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(3);
      await expect(store.refreshIfDue()).resolves.toMatchObject({ updated: true });
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(9);
    },
  );

  it.each(['manifest.json', 'supplement.json', 'litellm.json', 'models_dev.json'])(
    'never borrows legacy files for an aggregate missing %s and recovers on HTTP 304',
    async (name) => {
      const { dir, files, cache, fetchMock } = await fixture();
      await cache(new Date().toISOString());
      const incomplete = Object.fromEntries(Object.entries(files).filter(([key]) => key !== name));
      await writeFile(join(dir, 'pack.json'), JSON.stringify(incomplete));
      const store = new PricingStore(dir);
      expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(3);
      await expect(store.refreshIfDue()).resolves.toMatchObject({ updated: true });
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(
        new PricingStore(dir).current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion,
      ).toBe(9);
      const cached: unknown = JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8'));
      expect(cached).toEqual(files);
    },
  );

  it('recovers a missing manifest after a conditional response', async () => {
    const { dir, cache, fetchMock } = await fixture();
    await cache();
    await rm(join(dir, 'manifest.json'));
    await expect(new PricingStore(dir).refreshIfDue(true)).resolves.toMatchObject({
      updated: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([
    [
      'incomplete supplement',
      'supplement.json',
      { updatedAt: '2099-01-01', claude: {}, codex: {}, cursor: {} },
    ],
    ['empty catalog', 'litellm.json', { retrievedAt: '2099-01-01', models: {} }],
    ['null catalog row', 'litellm.json', { retrievedAt: '2099-01-01', models: { broken: null } }],
    [
      'negative rate',
      'models_dev.json',
      { retrievedAt: '2099-01-01', models: { broken: { i: -1, o: 2, cw: 1, cr: 0.1 } } },
    ],
    ['unsupported schema', 'manifest.json', { schemaVersion: 99 }],
  ])('rejects %s on disk and over the network', async (_, name, payload) => {
    const { dir, files, cache } = await fixture();
    files[name] = JSON.stringify(payload);
    updateHashes(files);
    await cache();
    const store = new PricingStore(dir);
    expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(3);
    const result = await store.refreshIfDue(true);

    expect(result.reason).toContain('invalid pricing payload');
    expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(3);
  });

  it.each([undefined, {}, { supplement: 'a'.repeat(64) }])(
    'rejects manifests without complete hashes: %j',
    async (hashes) => {
      const { dir, files } = await fixture();
      const manifest = JSON.parse(files['manifest.json'] ?? '') as Record<string, unknown>;
      manifest.hashes = hashes;
      files['manifest.json'] = JSON.stringify(manifest);
      const result = await new PricingStore(dir).refreshIfDue(true);
      expect(result.reason).toContain('invalid pricing payload');
    },
  );

  it('rejects invalid alias regexes before persisting a supplement', async () => {
    const { dir, files, supplement } = await fixture();
    supplement.cursor.aliases.push({ pattern: '[', canonical: 'broken' });
    files['supplement.json'] = JSON.stringify(supplement);
    updateHashes(files);
    const rejected = await new PricingStore(dir).refreshIfDue(true);
    expect(rejected.reason).toContain('invalid pricing payload');
    await expect(readFile(join(dir, 'pack.json'))).rejects.toThrow('ENOENT');
  });

  it('retains the complete previous pack when a later download has a bad hash', async () => {
    const { dir, files, fetchMock } = await fixture();
    const store = new PricingStore(dir);
    await store.refreshIfDue(true);
    const before = await readFile(join(dir, 'pack.json'), 'utf8');
    fetchMock.mockImplementation((input) => {
      const name =
        (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
          .split('/')
          .at(-1) ?? '';
      return Promise.resolve(
        new Response(name === 'models_dev.json' ? '{}' : files[name], { status: 200 }),
      );
    });
    const result = await store.refreshIfDue(true);

    expect(result.reason).toContain('hash mismatch');
    expect(await readFile(join(dir, 'pack.json'), 'utf8')).toBe(before);
    expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(9);
    expect(new PricingStore(dir).current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(
      9,
    );
  });

  it('keeps a complete generation when independent refreshes interleave', async () => {
    const { dir, files, fetchMock } = await fixture();
    const other = structuredClone(files);
    const supplement = JSON.parse(other['supplement.json'] ?? '') as PricingSupplement;
    supplement.claude.models['claude-sonnet-4-6'] = {
      inputPerMillion: 12,
      outputPerMillion: 60,
      cacheReadPerMillion: 1.2,
      cacheCreatePerMillion: 15,
    };
    other['supplement.json'] = JSON.stringify(supplement);
    other['litellm.json'] = JSON.stringify({
      retrievedAt: supplement.updatedAt,
      models: { stub: { i: 2, o: 4, cw: 2, cr: 0.2 } },
    });
    updateHashes(other);
    let release!: () => void;
    let stalled!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      stalled = resolve;
    });
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const first = url.includes('/first/');
      const name = url.split('/').at(-1) ?? '';
      if (first && name === 'models_dev.json') {
        stalled();
        await gate;
      }
      return new Response((first ? files : other)[name], { status: 200 });
    });
    const firstStore = new PricingStore(dir);
    const secondStore = new PricingStore(dir);
    vi.stubEnv('AITRACK_PRICING_URL', 'https://example.test/first');
    const pending = firstStore.refreshIfDue(true);
    await ready;
    vi.stubEnv('AITRACK_PRICING_URL', 'https://example.test/second');
    await expect(secondStore.refreshIfDue(true)).resolves.toMatchObject({ updated: true });
    release();
    await expect(pending).resolves.toMatchObject({ updated: true });
    const restarted = new PricingStore(dir);
    expect(restarted.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(9);
    expect(restarted.current().lookupCatalogCodex('stub')?.inputPerMillion).toBe(1);
    const cached = JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(cached).toEqual(files);
  });

  it('preserves the in-memory snapshot and removes temporary files after a failed commit', async () => {
    const { dir, files, fetchMock } = await fixture();
    const store = new PricingStore(dir);
    await store.refreshIfDue(true);
    const before = await readFile(join(dir, 'pack.json'), 'utf8');
    await rm(join(dir, 'pack.json'));
    await mkdir(join(dir, 'pack.json'));
    fetchMock.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(new Response(files[url.split('/').at(-1) ?? ''], { status: 200 }));
    });
    const result = await store.refreshIfDue(true);
    expect(result.reason).toContain('refresh failed:');
    expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(9);
    await rm(join(dir, 'pack.json'), { recursive: true });
    await writeFile(join(dir, 'pack.json'), before);
    expect(new PricingStore(dir).current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(
      9,
    );
    const names = await readdir(dir);
    expect(names.some((file) => file.endsWith('.tmp'))).toBe(false);
  });

  it('fails open when the cache path cannot be a directory', async () => {
    const { dir } = await fixture();
    const path = join(dir, 'file');
    await writeFile(path, 'file');
    const store = new PricingStore(path);
    const result = await store.refreshIfDue(true);

    expect(result.reason).toContain('refresh failed:');
    expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(3);
  });

  it('bounds stalled network requests with an abort signal', async () => {
    const { dir, fetchMock } = await fixture();
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new Error('timed out'));
      }, ms);
      return controller.signal;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchMock.mockImplementation(
      (_, options) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('timed out'));
          });
          started();
        }),
    );
    try {
      const pending = new PricingStore(dir).refreshIfDue(true);
      await ready;
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result.reason).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares a process-wide snapshot and exposes sync refresh status', async () => {
    vi.stubEnv('AITRACK_NO_PRICING_REFRESH', '1');
    const store = sharedPricingStore();
    expect(sharedPricingStore()).toBe(store);
    expect(currentModelPricing()).toBe(store.current());
    const result = await syncPricingPack({ force: true });
    expect(result.detail).toContain('AITRACK_NO_PRICING_REFRESH');
    vi.stubEnv('AITRACK_PRICING_URL', ' https://mirror.test/pack/ ');
    expect(pricingPackBaseUrl()).toBe('https://mirror.test/pack');
  });
});
