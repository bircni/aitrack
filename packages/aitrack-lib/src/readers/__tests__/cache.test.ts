import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => {
  const temporary = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${temporary}/aitrack-parse-cache-test`;
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import type { DayMap } from '../../data/types.js';
import { openParseCache } from '../cache.js';

const CACHE_FILE = join(TEST_HOME, '.config', 'aitrack', 'cache', 'claude.json');
const SOURCE = join(TEST_HOME, 'a.jsonl');

function days(inputTokens: number): DayMap {
  return new Map([
    [
      '2024-01-15',
      { inputTokens, outputTokens: 1, byModel: { m: { inputTokens, outputTokens: 1 } } },
    ],
  ]);
}

/** Populate the cache for SOURCE and persist it, as one run would. */
async function seedCache(inputTokens = 10): Promise<void> {
  const cache = openParseCache('claude');
  await cache.record(SOURCE, { days: days(inputTokens), keys: ['k1'] });
  cache.save();
}

describe('openParseCache', () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
    writeFileSync(SOURCE, 'line\n');
    delete process.env.AITRACK_NO_CACHE;
  });

  afterEach(() => {
    delete process.env.AITRACK_NO_CACHE;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('misses when nothing has been cached yet', async () => {
    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('returns a recorded parse on the next run', async () => {
    await seedCache();

    const hit = await openParseCache('claude').lookup(SOURCE);

    expect(hit?.keys).toEqual(['k1']);
    expect(hit?.days.get('2024-01-15')?.inputTokens).toBe(10);
  });

  it('misses once the file size changes', async () => {
    await seedCache();
    writeFileSync(SOURCE, 'line\nline2\n');

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('misses once the file mtime changes without a size change', async () => {
    await seedCache();
    const later = new Date(Date.now() + 60_000);
    utimesSync(SOURCE, later, later);

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('misses when the file is gone', async () => {
    await seedCache();
    rmSync(SOURCE);

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('drops a cache written by a different aitrack version', async () => {
    await seedCache();
    const stored: unknown = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({ ...(stored as object), appVersion: '0.0.0-other' }),
      'utf8',
    );

    // Costs are baked in at parse time, so pricing changes must not survive.
    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('drops a cache written in a different format', async () => {
    await seedCache();
    const stored: unknown = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    writeFileSync(CACHE_FILE, JSON.stringify({ ...(stored as object), format: 99 }), 'utf8');

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('ignores a corrupt cache file instead of throwing', async () => {
    mkdirSync(join(TEST_HOME, '.config', 'aitrack', 'cache'), { recursive: true });
    writeFileSync(CACHE_FILE, '{not json', 'utf8');

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('ignores an entry whose day totals are not finite numbers', async () => {
    await seedCache();
    writeFileSync(
      CACHE_FILE,
      readFileSync(CACHE_FILE, 'utf8').replace('"inputTokens":10', '"inputTokens":null'),
      'utf8',
    );

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('ignores an entry whose dedup keys are not all strings', async () => {
    await seedCache();
    writeFileSync(CACHE_FILE, readFileSync(CACHE_FILE, 'utf8').replace('"k1"', '42'), 'utf8');

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('records nothing for a file that vanishes before it can be stat-ed', async () => {
    const gone = join(TEST_HOME, 'never-existed.jsonl');
    const cache = openParseCache('claude');

    await expect(cache.record(gone, { days: days(5), keys: ['k1'] })).resolves.toBeUndefined();
    cache.save();

    await expect(openParseCache('claude').lookup(gone)).resolves.toBeNull();
  });

  it('does not throw when the cache file cannot be replaced', () => {
    // A directory sitting where the cache file goes makes the rename fail; the
    // command it was speeding up must not care.
    mkdirSync(CACHE_FILE, { recursive: true });

    expect(() => {
      openParseCache('claude').save();
    }).not.toThrow();
    expect(existsSync(`${CACHE_FILE}.${String(process.pid)}.tmp`)).toBe(false);
  });

  it('forgets files that were not looked up, so deleted logs age out', async () => {
    await seedCache();

    // A run that never touches SOURCE must not carry its entry forward.
    openParseCache('claude').save();

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('keeps providers in separate files so concurrent readers do not clobber', async () => {
    await seedCache();
    const codex = openParseCache('codex');
    await codex.record(SOURCE, { days: days(99), keys: [] });
    codex.save();

    const claudeHit = await openParseCache('claude').lookup(SOURCE);
    const codexHit = await openParseCache('codex').lookup(SOURCE);

    expect(claudeHit?.days.get('2024-01-15')?.inputTokens).toBe(10);
    expect(codexHit?.days.get('2024-01-15')?.inputTokens).toBe(99);
  });

  it('stores nothing when AITRACK_NO_CACHE is set', async () => {
    process.env.AITRACK_NO_CACHE = '1';

    const cache = openParseCache('claude');
    await expect(cache.lookup(SOURCE)).resolves.toBeNull();
    await cache.record(SOURCE, { days: days(10), keys: ['k1'] });
    cache.save();

    delete process.env.AITRACK_NO_CACHE;
    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });
});
