import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PricingSupplement } from '../../libs/aitrack-lib/src/pricing/packMeta.js';
import { supplementFromTables } from '../../libs/aitrack-lib/src/pricing/supplementFromTables.js';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(() => Promise.resolve(undefined)),
  readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
  writeFile: vi.fn<(path: string, body: string, encoding: string) => Promise<void>>(),
}));
vi.mock('node:fs/promises', () => mocks);

import { buildPricingPack } from '../build-pricing-pack.js';

const files = new Map<string, string>();
beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  const baseline = supplementFromTables();
  for (const provider of ['claude', 'codex', 'cursor'] as const) {
    files.set(
      `${provider}.json`,
      JSON.stringify({ ...baseline[provider], updatedAt: '2026-01-01' }),
    );
  }
  const catalog = {
    retrievedAt: '2026-10-02T00:00:00.000Z',
    models: { 'anthropic/claude-sonnet-4-6': { i: 6, o: 30, cr: 0.6, cw: 7.5 } },
  };
  files.set('litellm.json', JSON.stringify(catalog));
  files.set('models_dev.json', JSON.stringify(catalog));
  mocks.readFile.mockImplementation((path) => {
    const body = files.get(basename(path));
    return body === undefined
      ? Promise.reject(new Error(`missing ${path}`))
      : Promise.resolve(body);
  });
  mocks.writeFile.mockImplementation((path, body) => {
    files.set(basename(path), body);
    return Promise.resolve();
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('buildPricingPack', () => {
  it('fetches catalogs and writes table updates without changing history', async () => {
    const original = JSON.parse(files.get('codex.json') ?? '') as Record<string, unknown>;
    const originalClaude = JSON.parse(files.get('claude.json') ?? '') as Record<string, unknown>;
    const cursorBefore = files.get('cursor.json');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              'openai/gpt-5.4': { input_cost_per_token: 0.000008, output_cost_per_token: 0.00004 },
              'anthropic/claude-sonnet-4-6': {
                input_cost_per_token: 0.000006,
                output_cost_per_token: 0.00003,
              },
              openai: { models: { 'gpt-5.4': { cost: { input: 8, output: 40 } } } },
              anthropic: { models: { 'claude-sonnet-4-6': { cost: { input: 6, output: 30 } } } },
            }),
          ),
        ),
      ),
    );
    const result = await buildPricingPack({ writeTablesFromFeeds: true });
    expect(result.tableWrites).toEqual({
      claudeChanged: ['claude-sonnet-4-6'],
      codexChanged: ['gpt-5.4'],
    });
    const updated = JSON.parse(files.get('codex.json') ?? '') as Record<string, unknown>;
    expect(updated.historical).toEqual(original.historical);
    expect(updated.overrides).toEqual(original.overrides);
    const claude = JSON.parse(files.get('claude.json') ?? '') as Record<string, unknown>;
    expect(claude.overrides).toEqual(originalClaude.overrides);
    expect(claude.familyFallback).toEqual(originalClaude.familyFallback);
    expect(files.get('cursor.json')).toBe(cursorBefore);
    const supplement = JSON.parse(files.get('supplement.json') ?? '') as PricingSupplement;
    expect(supplement.claude.models['claude-sonnet-4-6']?.inputPerMillion).toBe(6);
    expect(supplementFromTables().claude.models['claude-sonnet-4-6']?.inputPerMillion).toBe(3);
    expect(result.litellmCount).toBe(2);
  });

  it('leaves matching source tables untouched on write', async () => {
    const catalog = JSON.stringify({
      retrievedAt: '2026-10-02T00:00:00.000Z',
      models: { 'anthropic/claude-sonnet-4-6': { i: 3, o: 15, cr: 0.3, cw: 3.75 } },
    });
    files.set('litellm.json', catalog);
    files.set('models_dev.json', catalog);
    const before = files.get('claude.json');
    const result = await buildPricingPack({ offline: true, writeTablesFromFeeds: true });
    expect(result.tableWrites).toEqual({ claudeChanged: [], codexChanged: [] });
    expect(files.get('claude.json')).toBe(before);
    expect(mocks.writeFile.mock.calls.map(([path]) => basename(path))).not.toContain('claude.json');
  });

  it.each(['success', 'failure'] as const)(
    'sets the pack-builder script exit status on %s',
    async (mode) => {
      vi.resetModules();
      if (mode === 'failure') mocks.readFile.mockRejectedValueOnce(new Error('catalog missing'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);
      const previous = process.argv;
      process.argv = [
        process.execPath,
        fileURLToPath(new URL('../build-pricing-pack.ts', import.meta.url)),
        '--offline',
        '--write',
      ];
      try {
        await import('../build-pricing-pack.js');
        await vi.waitFor(() => {
          expect(exit).toHaveBeenCalledWith(mode === 'success' ? 0 : 1);
        });
      } finally {
        process.argv = previous;
      }
    },
  );

  it('keeps source tables untouched when only publishing a catalog overlay', async () => {
    const source = files.get('claude.json');
    await buildPricingPack({ offline: true });
    expect(files.get('claude.json')).toBe(source);
    const supplement = JSON.parse(files.get('supplement.json') ?? '') as PricingSupplement;
    expect(supplement.claude.models['claude-sonnet-4-6']?.inputPerMillion).toBe(6);
  });
});
