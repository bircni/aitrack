import { basename } from 'node:path';

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
});

describe('buildPricingPack', () => {
  it('publishes newly written table rates even when a separate catalog overlay is disabled', async () => {
    const codexBefore = files.get('codex.json');
    const cursorBefore = files.get('cursor.json');
    const original = JSON.parse(files.get('claude.json') ?? '') as Record<string, unknown>;
    const built = await buildPricingPack({
      offline: true,
      writeTablesFromFeeds: true,
      applyCatalogRatesToSupplement: false,
    });
    const supplement = JSON.parse(files.get('supplement.json') ?? '') as PricingSupplement;
    const claude = JSON.parse(files.get('claude.json') ?? '') as Record<string, unknown>;
    expect(built.tableWrites).toEqual({ claudeChanged: ['claude-sonnet-4-6'], codexChanged: [] });
    expect(supplement.claude.models['claude-sonnet-4-6']?.inputPerMillion).toBe(6);
    expect(claude.overrides).toEqual(original.overrides);
    expect(claude.familyFallback).toEqual(original.familyFallback);
    expect(files.get('codex.json')).toBe(codexBefore);
    expect(files.get('cursor.json')).toBe(cursorBefore);
    expect(supplementFromTables().claude.models['claude-sonnet-4-6']?.inputPerMillion).toBe(3);
  });

  it('keeps source tables untouched when only publishing a catalog overlay', async () => {
    const source = files.get('claude.json');
    await buildPricingPack({ offline: true });
    expect(files.get('claude.json')).toBe(source);
    const supplement = JSON.parse(files.get('supplement.json') ?? '') as PricingSupplement;
    expect(supplement.claude.models['claude-sonnet-4-6']?.inputPerMillion).toBe(6);
  });
});
