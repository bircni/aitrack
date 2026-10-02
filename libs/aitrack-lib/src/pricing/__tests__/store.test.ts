import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PricingManifest, PricingSupplement } from '../packMeta.js';
import { PricingStore, resetSharedPricingStore } from '../store.js';
import { supplementFromTables } from '../supplementFromTables.js';

afterEach(() => {
  resetSharedPricingStore();
  vi.unstubAllGlobals();
  delete process.env.AITRACK_PRICING_URL;
  delete process.env.AITRACK_NO_PRICING_REFRESH;
});

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
    const files: Record<string, string> = {
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
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const name = url.slice(url.lastIndexOf('/') + 1);
        const body = files[name];
        if (!body) return new Response('missing', { status: 404 });
        return new Response(body, { status: 200, headers: { etag: `"${name}"` } });
      }),
    );

    process.env.AITRACK_PRICING_URL = 'https://example.test/pricing';
    const store = new PricingStore(dir);
    await store.init();
    const result = await store.refreshIfDue(true);
    expect(result.updated).toBe(true);
    expect(store.current().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(9);
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
    const newer = structuredClone(supplementFromTables()) as PricingSupplement;
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
});
