import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PricingManifest, PricingSupplement } from '../packMeta.js';
import { pricingPackBaseUrl } from '../packMeta.js';
import {
  currentModelPricing,
  ensurePricingStore,
  PricingStore,
  resetSharedPricingStore,
} from '../store.js';
import { supplementFromTables } from '../supplementFromTables.js';

afterEach(() => {
  resetSharedPricingStore();
  vi.unstubAllGlobals();
  delete process.env.AITRACK_PRICING_URL;
  delete process.env.AITRACK_NO_PRICING_REFRESH;
});

function stubPricingFiles(files: Record<string, string>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const name = url.slice(url.lastIndexOf('/') + 1);
      const body = files[name];
      if (!body) return Promise.resolve(new Response('missing', { status: 404 }));
      return Promise.resolve(new Response(body, { status: 200, headers: { etag: `"${name}"` } }));
    }),
  );
}

describe('PricingStore', () => {
  it('loads local tables without a disk cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-'));
    const store = new PricingStore(dir);
    const pricing = await store.init();
    const local = supplementFromTables();
    expect(pricing.updatedAt).toBe(local.updatedAt);
    expect(pricing.lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(3);
    expect(pricing.lookupCodex('gpt-5.6-sol')?.outputPerMillion).toBe(20);
    expect(pricing.lookupCursorNative('composer-2.5')?.inputPerMillion).toBe(0.5);
  });

  it('refreshes from a pricing-pack URL when forced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-'));
    const local = supplementFromTables();
    const newer = structuredClone(local);
    newer.updatedAt = '2099-01-01T00:00:00.000Z';
    newer.claude.models['claude-sonnet-4-6'] = {
      inputPerMillion: 9,
      outputPerMillion: 45,
      cacheReadPerMillion: 0.9,
      cacheCreatePerMillion: 11.25,
    };

    const emptyCatalog = {
      retrievedAt: '2099-01-01T00:00:00.000Z',
      models: { stub: { i: 1, o: 2, cw: 1, cr: 0.1 } },
    };
    stubPricingFiles({
      'manifest.json': JSON.stringify({
        schemaVersion: 1,
        updatedAt: newer.updatedAt,
        files: {
          supplement: 'supplement.json',
          litellm: 'litellm.json',
          modelsDev: 'models_dev.json',
        },
      } satisfies PricingManifest),
      'supplement.json': JSON.stringify(newer),
      'litellm.json': JSON.stringify(emptyCatalog),
      'models_dev.json': JSON.stringify(emptyCatalog),
    });

    process.env.AITRACK_PRICING_URL = 'https://example.test/pricing';
    const store = new PricingStore(dir);
    await store.init();
    const result = await store.refreshIfDue(true);
    expect(result.updated).toBe(true);
    expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(9);
    expect(store.localUpdatedAt()).toBe(local.updatedAt);
  });

  it('keeps local table rates when refresh is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-'));
    process.env.AITRACK_NO_PRICING_REFRESH = '1';
    const store = new PricingStore(dir);
    await store.init();
    const result = await store.refreshIfDue(true);
    expect(result.updated).toBe(false);
    expect(result.reason).toContain('AITRACK_NO_PRICING_REFRESH');
  });

  it('prefers a newer on-disk supplement over local tables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-'));
    const newer: PricingSupplement = structuredClone(supplementFromTables());
    newer.updatedAt = '2099-06-01T00:00:00.000Z';
    newer.cursor.models['composer-2.5'] = {
      inputPerMillion: 99,
      outputPerMillion: 99,
      cacheReadPerMillion: 9.9,
      cacheWritePerMillion: 99,
    };
    await writeFile(join(dir, 'supplement.json'), JSON.stringify(newer), 'utf8');
    const store = new PricingStore(dir);
    const pricing = await store.init();
    expect(pricing.lookupCursorNative('composer-2.5')?.inputPerMillion).toBe(99);
  });

  it('skips network when the cache is still fresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-'));
    const now = new Date().toISOString();
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        sources: {
          manifest: { fetchedAt: now },
          supplement: { fetchedAt: now },
          litellm: { fetchedAt: now },
          modelsDev: { fetchedAt: now },
        },
      }),
      'utf8',
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store = new PricingStore(dir);
    await store.init();
    const result = await store.refreshIfDue(false);
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('cache still fresh');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports refresh failures without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 503 }))),
    );
    process.env.AITRACK_PRICING_URL = 'https://example.test/pricing';
    const store = new PricingStore(dir);
    await store.init();
    const result = await store.refreshIfDue(true);
    expect(result.updated).toBe(false);
    expect(result.reason).toContain('refresh failed');
  });

  it('backs off retries after a recent failure even when the cache is stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-'));
    const failedAt = new Date().toISOString();
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        sources: {
          manifest: { failedAt },
          supplement: { failedAt },
          litellm: { failedAt },
          modelsDev: { failedAt },
        },
      }),
      'utf8',
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.AITRACK_PRICING_URL = 'https://example.test/pricing';
    const store = new PricingStore(dir);
    await store.init();
    const result = await store.refreshIfDue(false);
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('cache still fresh');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects packs with a bad content hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-'));
    const local = supplementFromTables();
    const emptyCatalog = {
      retrievedAt: '2099-01-01T00:00:00.000Z',
      models: { stub: { i: 1, o: 2, cw: 1, cr: 0.1 } },
    };
    const supplementBody = JSON.stringify(local);
    stubPricingFiles({
      'manifest.json': JSON.stringify({
        schemaVersion: 1,
        updatedAt: local.updatedAt,
        files: {
          supplement: 'supplement.json',
          litellm: 'litellm.json',
          modelsDev: 'models_dev.json',
        },
        hashes: {
          supplement: createHash('sha256').update('not-the-body').digest('hex'),
        },
      } satisfies PricingManifest),
      'supplement.json': supplementBody,
      'litellm.json': JSON.stringify(emptyCatalog),
      'models_dev.json': JSON.stringify(emptyCatalog),
    });
    process.env.AITRACK_PRICING_URL = 'https://example.test/pricing';
    const store = new PricingStore(dir);
    await store.init();
    const result = await store.refreshIfDue(true);
    expect(result.updated).toBe(false);
    expect(result.reason).toContain('hash mismatch');
  });

  it('rejects unsupported manifest schema versions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-'));
    stubPricingFiles({
      'manifest.json': JSON.stringify({
        schemaVersion: 99,
        updatedAt: '2099-01-01T00:00:00.000Z',
        files: {
          supplement: 'supplement.json',
          litellm: 'litellm.json',
          modelsDev: 'models_dev.json',
        },
      }),
    });
    process.env.AITRACK_PRICING_URL = 'https://example.test/pricing';
    const store = new PricingStore(dir);
    await store.init();
    const result = await store.refreshIfDue(true);
    expect(result.updated).toBe(false);
    expect(result.reason).toContain('unsupported pricing pack schema');
  });

  it('reuses cached files on HTTP 304', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-'));
    const local = supplementFromTables();
    const emptyCatalog = {
      retrievedAt: '2099-01-01T00:00:00.000Z',
      models: { stub: { i: 1, o: 2, cw: 1, cr: 0.1 } },
    };
    const manifest: PricingManifest = {
      schemaVersion: 1,
      updatedAt: local.updatedAt,
      files: {
        supplement: 'supplement.json',
        litellm: 'litellm.json',
        modelsDev: 'models_dev.json',
      },
    };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    await writeFile(join(dir, 'supplement.json'), JSON.stringify(local), 'utf8');
    await writeFile(join(dir, 'litellm.json'), JSON.stringify(emptyCatalog), 'utf8');
    await writeFile(join(dir, 'models_dev.json'), JSON.stringify(emptyCatalog), 'utf8');
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        sources: {
          manifest: { etag: '"manifest.json"', fetchedAt: '2000-01-01T00:00:00.000Z' },
          supplement: { etag: '"supplement.json"', fetchedAt: '2000-01-01T00:00:00.000Z' },
          litellm: { etag: '"litellm.json"', fetchedAt: '2000-01-01T00:00:00.000Z' },
          modelsDev: { etag: '"models_dev.json"', fetchedAt: '2000-01-01T00:00:00.000Z' },
        },
      }),
      'utf8',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(null, { status: 304, headers: { etag: '"cached"' } })),
      ),
    );
    process.env.AITRACK_PRICING_URL = 'https://example.test/pricing';
    const store = new PricingStore(dir);
    await store.init();
    const result = await store.refreshIfDue(true);
    expect(result.updated).toBe(false);
    expect(result.reason).toContain('unchanged');
  });

  it('shares a process-wide store via ensurePricingStore', async () => {
    const pricing = await ensurePricingStore();
    expect(currentModelPricing().updatedAt).toBe(pricing.updatedAt);
    expect(pricingPackBaseUrl()).toContain('raw.githubusercontent.com');
    process.env.AITRACK_PRICING_URL = 'https://mirror.test/pack/';
    expect(pricingPackBaseUrl()).toBe('https://mirror.test/pack');
  });
});
