import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyCatalogRatesToSupplement,
  fetchPricingCatalogs,
  comparePricingTable,
  tallyPricingFindings,
} from '../catalogs.js';
import { catalogFromCompact, catalogFromLiteLLM } from '../codecs.js';
import { supplementFromTables } from '../supplementFromTables.js';

const emptyCatalog = { retrievedAt: '2099-01-01', models: {} };

describe('pricing checker against catalogs', () => {
  const primary = catalogFromLiteLLM({
    'anthropic/claude-sonnet-4-6': {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
      cache_creation_input_token_cost: 3.75e-6,
      cache_read_input_token_cost: 3e-7,
    },
    'openai/gpt-5.6-sol': {
      input_cost_per_token: 4e-6,
      output_cost_per_token: 20e-6,
    },
  });
  const secondary = catalogFromCompact({
    retrievedAt: '2026-10-02T00:00:00Z',
    models: {
      'claude-sonnet-4-6': { i: 3, o: 15, cw: 3.75, cr: 0.3 },
      'composer-1': { i: 1.25, o: 10, cw: 1.25, cr: 0.125 },
    },
  });

  it('matches exact Claude/Codex rates', () => {
    const findings = comparePricingTable({
      table: {
        'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
      },
      providers: ['anthropic'],
      primary,
      secondary,
    });
    expect(findings).toEqual([{ kind: 'ok', modelId: 'claude-sonnet-4-6', summary: '$3/$15' }]);
  });

  it('flags drift when catalog IO differs', () => {
    const findings = comparePricingTable({
      table: {
        'gpt-5.6-sol': { inputPerMillion: 5, outputPerMillion: 30 },
      },
      providers: ['openai'],
      primary,
      secondary,
    });
    expect(findings[0]).toMatchObject({
      kind: 'drift',
      isInOk: false,
      isOutOk: false,
      saw: [4, 20],
    });
  });

  it('marks models missing from catalogs as unverified', () => {
    const findings = comparePricingTable({
      table: {
        'composer-2.5': { inputPerMillion: 0.5, outputPerMillion: 2.5 },
      },
      providers: ['cursor'],
      primary,
      secondary,
    });
    expect(findings[0]?.kind).toBe('unverified');
  });

  it('tallies finding kinds', () => {
    expect(
      tallyPricingFindings([
        { kind: 'ok', modelId: 'a', summary: '$1/$2' },
        { kind: 'drift', modelId: 'b', summary: '$1/$2', isInOk: false, isOutOk: true, saw: [3] },
        { kind: 'unverified', modelId: 'c', summary: '$1/$2', where: 'x' },
      ]),
    ).toEqual({ drift: 1, unverified: 1 });
  });
});

describe('pricing pack catalog merge', () => {
  it.each([
    [false, false, 0.6, 7.5],
    [true, true, 0.8, 8],
    [true, false, 0.8, 7.5],
    [false, true, 0.6, 8],
  ])(
    'preserves implicit Claude cache ratios (read explicit=%s, write explicit=%s)',
    (cre, cwe, read, write) => {
      const supplement = supplementFromTables();
      const catalogs = {
        retrievedAt: '2099-01-01T00:00:00.000Z',
        models: {
          'anthropic/claude-sonnet-4-6': { i: 6, o: 30, cr: 0.8, cw: 8, cre, cwe },
          'openai/gpt-5.6-sol': { i: 8, o: 40, cr: 0.8, cw: 8 },
        },
      };
      const historical = structuredClone(supplement.codex.historical);
      const cursor = structuredClone(supplement.cursor);
      const overrides = structuredClone(supplement.claude.overrides);
      const changed = applyCatalogRatesToSupplement(supplement, {
        primary: catalogFromCompact(catalogs),
        secondary: catalogFromCompact(emptyCatalog),
      });
      expect(changed).toEqual({
        claudeChanged: ['claude-sonnet-4-6'],
        codexChanged: ['gpt-5.6-sol'],
      });
      expect(supplement.claude.models['claude-sonnet-4-6']).toEqual({
        inputPerMillion: 6,
        outputPerMillion: 30,
        cacheReadPerMillion: read,
        cacheCreatePerMillion: write,
      });
      expect(supplement.codex.current['gpt-5.6-sol']).toEqual({
        inputPerMillion: 8,
        outputPerMillion: 40,
      });
      expect(supplement.codex.historical).toEqual(historical);
      expect(supplement.cursor).toEqual(cursor);
      expect(supplement.claude.overrides).toEqual(overrides);
      expect(
        applyCatalogRatesToSupplement(supplement, {
          primary: catalogFromCompact(catalogs),
          secondary: catalogFromCompact(emptyCatalog),
        }),
      ).toEqual({
        claudeChanged: [],
        codexChanged: [],
      });
    },
  );

  it('applies explicit cache corrections even when input/output are unchanged', () => {
    const supplement = supplementFromTables();
    const catalogs = {
      retrievedAt: '2099-01-01',
      models: { 'anthropic/claude-sonnet-4-6': { i: 3, o: 15, cr: 0.9, cw: 9 } },
    };
    expect(
      applyCatalogRatesToSupplement(supplement, {
        primary: catalogFromCompact(catalogs),
        secondary: catalogFromCompact(emptyCatalog),
      }).claudeChanged,
    ).toEqual(['claude-sonnet-4-6']);
    expect(supplement.claude.models['claude-sonnet-4-6']?.cacheReadPerMillion).toBe(0.9);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPricingCatalogs', () => {
  it('fetches both feeds with a deadline and one retrieval timestamp', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes('models.dev')
              ? { openai: { models: { 'gpt-test': { cost: { input: 2, output: 8 } } } } }
              : { 'openai/gpt-test': { input_cost_per_token: 1e-6, output_cost_per_token: 4e-6 } },
          ),
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const catalogs = await fetchPricingCatalogs();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(catalogs.primary.retrievedAt).toBe(catalogs.secondary.retrievedAt);
    expect(catalogs.primary.entries.get('openai/gpt-test')?.inputPerMillion).toBe(1);
    expect(catalogs.secondary.entries.get('openai/gpt-test')?.inputPerMillion).toBe(2);
  });

  it.each([
    ['HTTP error', 503, '{}', 'HTTP 503'],
    ['invalid JSON root', 200, '[]', 'invalid pricing catalog'],
  ])('rejects %s before publishing a catalog', async (_, status, body, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(body, { status }))),
    );
    await expect(fetchPricingCatalogs()).rejects.toThrow(message);
  });
});
