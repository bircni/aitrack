import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  catalogFromCompact,
  type CompactCatalog,
} from '../../libs/aitrack-lib/src/pricing/codecs.js';
import { supplementFromTables } from '../../libs/aitrack-lib/src/pricing/supplementFromTables.js';

const mocks = vi.hoisted(() => ({ appDir: '', fetchPricingCatalogs: vi.fn() }));
vi.mock('../../libs/aitrack-lib/src/pricing/catalogs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../libs/aitrack-lib/src/pricing/catalogs.js')>()),
  fetchPricingCatalogs: mocks.fetchPricingCatalogs,
}));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.appDir = await mkdtemp(join(tmpdir(), 'aitrack-pricing-check-'));
  vi.doMock('../../libs/aitrack-lib/src/paths.js', () => ({ APP_DIR: mocks.appDir }));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('../../libs/aitrack-lib/src/paths.js');
  await rm(mocks.appDir, { recursive: true, force: true });
});

describe('checkPricing', () => {
  it('reports catalog fetch failures with a failing status', async () => {
    mocks.fetchPricingCatalogs.mockRejectedValueOnce(new Error('offline'));
    const { checkPricing } = await import('../update-pricing.js');
    expect(await checkPricing()).toBe(1);
    expect(console.error).toHaveBeenCalledWith('Catalog fetch failed:', 'offline');
  });

  it.each(['matching', 'cursor drift'] as const)(
    'accepts verified source rates with %s',
    async (mode) => {
      const source = supplementFromTables();
      const compact: CompactCatalog = {
        retrievedAt: source.updatedAt,
        models: Object.fromEntries(
          (
            [
              ['anthropic', source.claude.models],
              ['openai', source.codex.current],
              ['cursor', source.cursor.models],
            ] as const
          ).flatMap(([provider, models]) =>
            Object.entries(models).map(
              ([id, rates]) =>
                [
                  `${provider}/${id}`,
                  { i: rates.inputPerMillion, o: rates.outputPerMillion, cr: 0, cw: 0 },
                ] as const,
            ),
          ),
        ),
      };
      if (mode === 'cursor drift') compact.models['cursor/auto'] = { i: 99, o: 99, cr: 0, cw: 0 };
      mocks.fetchPricingCatalogs.mockResolvedValue({
        primary: catalogFromCompact(compact),
        secondary: catalogFromCompact(compact),
      });
      const { checkPricing } = await import('../update-pricing.js');
      expect(await checkPricing()).toBe(0);
      expect(console.log).toHaveBeenCalledWith(
        'All verified pricing matches LiteLLM / models.dev catalogs.',
      );
      const report = vi
        .mocked(console.log)
        .mock.calls.map((args) => args.join(' '))
        .join('\n');
      expect(report).toContain(
        mode === 'cursor drift' ? '1 intentional overrides' : '0 intentional overrides',
      );
    },
  );

  it.each(['success', 'fetch failure', 'report failure'] as const)(
    'sets the script exit status for %s',
    async (mode) => {
      const catalog = catalogFromCompact({ retrievedAt: '2026-01-01', models: {} });
      mocks.fetchPricingCatalogs.mockResolvedValue({ primary: catalog, secondary: catalog });
      if (mode === 'fetch failure')
        mocks.fetchPricingCatalogs.mockRejectedValueOnce(new Error('offline'));
      if (mode === 'report failure')
        vi.mocked(console.log).mockImplementationOnce(() => {
          throw new Error('output unavailable');
        });
      const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);
      const previous = process.argv;
      process.argv = [
        process.execPath,
        fileURLToPath(new URL('../update-pricing.ts', import.meta.url)),
      ];
      try {
        await import('../update-pricing.js');
        await vi.waitFor(() => {
          expect(exit).toHaveBeenCalledWith(mode === 'success' ? 0 : 1);
        });
      } finally {
        process.argv = previous;
      }
    },
  );

  it.each([
    ['cached rates match catalogs', 9, 45, 8, 40, 1],
    ['source rates match catalogs', 3, 15, 2.5, 15, 0],
  ] as const)(
    'checks source tables when %s',
    async (_, input, output, codexInput, codexOutput, expected) => {
      const supplement = supplementFromTables();
      supplement.updatedAt = '2099-01-01T00:00:00.000Z';
      Object.assign(supplement.claude.models['claude-sonnet-4-6'] ?? {}, {
        inputPerMillion: 9,
        outputPerMillion: 45,
      });
      supplement.codex.current['gpt-5.4'] = { inputPerMillion: 8, outputPerMillion: 40 };
      Object.assign(supplement.cursor.models['composer-2.5'] ?? {}, {
        inputPerMillion: 10,
        outputPerMillion: 50,
      });
      supplement.codex.current['cache-only-model'] = { inputPerMillion: 8, outputPerMillion: 40 };
      const catalog = {
        retrievedAt: supplement.updatedAt,
        models: {
          'anthropic/claude-sonnet-4-6': { i: input, o: output, cr: 0.3, cw: 3.75 },
          'openai/gpt-5.4': { i: codexInput, o: codexOutput, cr: 0.25, cw: 2.5 },
          'cursor/composer-2.5': { i: 0.5, o: 2.5, cr: 0.2, cw: 0.5 },
        },
      };
      const files = {
        'supplement.json': JSON.stringify(supplement),
        'litellm.json': JSON.stringify(catalog),
        'models_dev.json': JSON.stringify(catalog),
      };
      const manifest = {
        schemaVersion: 1,
        updatedAt: supplement.updatedAt,
        files: {
          supplement: 'supplement.json',
          litellm: 'litellm.json',
          modelsDev: 'models_dev.json',
        },
        hashes: {
          supplement: createHash('sha256').update(files['supplement.json']).digest('hex'),
          litellm: createHash('sha256').update(files['litellm.json']).digest('hex'),
          modelsDev: createHash('sha256').update(files['models_dev.json']).digest('hex'),
        },
      };
      const cacheDir = join(mocks.appDir, 'pricing');
      await mkdir(cacheDir);
      const cacheBody = JSON.stringify({ ...files, 'manifest.json': JSON.stringify(manifest) });
      await writeFile(join(cacheDir, 'pack.json'), cacheBody);
      const { currentModelPricing } = await import('../../libs/aitrack-lib/src/pricing/store.js');
      expect(currentModelPricing().lookupClaude('claude-sonnet-4-6')?.inputPerMillion).toBe(9);
      expect(currentModelPricing().lookupCodex('cache-only-model')?.inputPerMillion).toBe(8);
      mocks.fetchPricingCatalogs.mockResolvedValue({
        primary: catalogFromCompact(catalog),
        secondary: catalogFromCompact(catalog),
      });
      const { checkPricing } = await import('../update-pricing.js');
      expect(await checkPricing()).toBe(expected);
      const report = vi
        .mocked(console.log)
        .mock.calls.map((args) => args.join(' '))
        .join('\n');
      expect(report).toMatch(/claude-sonnet-4-6\s+\$3\/\$15/u);
      expect(report).toMatch(/gpt-5\.4\s+\$2\.5\/\$15/u);
      expect(report).toMatch(/composer-2\.5\s+\$0\.5\/\$2\.5/u);
      expect(report).not.toContain('cache-only-model');
      expect(await readFile(join(cacheDir, 'pack.json'), 'utf8')).toBe(cacheBody);
    },
  );
});
