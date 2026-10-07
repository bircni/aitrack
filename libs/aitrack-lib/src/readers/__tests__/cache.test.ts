import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const pricing = vi.hoisted(() => ({ fingerprint: 'initial' }));
vi.mock('../../pricing/store.js', () => ({ currentModelPricing: () => pricing }));

import type { DayMap } from '../../data/types.js';
import { openParseCache } from '../cache.js';

const CACHE_DIR = join(TEST_HOME, '.config', 'aitrack', 'cache');
const SOURCE = join(TEST_HOME, 'a.jsonl');

function days(inputTokens: number): DayMap {
  return new Map([
    [
      '2024-01-15',
      { inputTokens, outputTokens: 1, byModel: { m: { inputTokens, outputTokens: 1 } } },
    ],
  ]);
}

function cacheFilePath(): string {
  return join(CACHE_DIR, readdirSync(CACHE_DIR).find((file) => file.startsWith('claude-')) ?? '');
}

/** Populate the cache for SOURCE and persist it, as one run would; returns the cache file. */
async function seedCache(inputTokens = 10): Promise<string> {
  const cache = openParseCache('claude');
  await cache.record(SOURCE, { days: days(inputTokens), keys: ['k1'] });
  cache.save();
  return cacheFilePath();
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

  it('drops a cache written in a different timezone', async () => {
    const cacheFile = await seedCache();
    const stored: unknown = JSON.parse(readFileSync(cacheFile, 'utf8'));
    writeFileSync(
      cacheFile,
      JSON.stringify({ ...(stored as object), timezone: 'Not/A-Zone' }),
      'utf8',
    );

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('ignores a corrupt cache file instead of throwing', async () => {
    writeFileSync(await seedCache(), '{not json', 'utf8');

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('ignores an entry whose day totals are not finite numbers', async () => {
    const cacheFile = await seedCache();
    writeFileSync(
      cacheFile,
      readFileSync(cacheFile, 'utf8').replace('"inputTokens":10', '"inputTokens":null'),
      'utf8',
    );

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('ignores an entry whose dedup keys are not all strings', async () => {
    const cacheFile = await seedCache();
    writeFileSync(cacheFile, readFileSync(cacheFile, 'utf8').replace('"k1"', '42'), 'utf8');

    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  });

  it('records nothing for a file that vanishes before it can be stat-ed', async () => {
    const gone = join(TEST_HOME, 'never-existed.jsonl');
    const cache = openParseCache('claude');

    await expect(cache.record(gone, { days: days(5), keys: ['k1'] })).resolves.toBeUndefined();
    cache.save();

    await expect(openParseCache('claude').lookup(gone)).resolves.toBeNull();
  });

  it('reuses an unchanged cache in memory and does not rewrite it when nothing changed', async () => {
    await seedCache();
    vi.mocked(readFileSync).mockClear();
    vi.mocked(renameSync).mockClear();

    for (let run = 0; run < 2; run++) {
      const cache = openParseCache('claude');
      const entry = await cache.lookup(SOURCE);
      expect(entry?.keys).toEqual(['k1']);
      cache.save();
    }

    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });

  it('does not throw when the cache file cannot be replaced', async () => {
    // A directory sitting where the cache file goes makes the rename fail; the
    // command it was speeding up must not care.
    const cacheFile = await seedCache();
    rmSync(cacheFile);
    mkdirSync(cacheFile);
    const cache = openParseCache('claude');
    await cache.record(SOURCE, { days: days(10), keys: ['k1'] });

    expect(() => {
      cache.save();
    }).not.toThrow();
    expect(existsSync(`${cacheFile}.${String(process.pid)}.tmp`)).toBe(false);
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

it('keeps a file per pricing key, the newest other key and a fresh unkeyed file', async () => {
  mkdirSync(TEST_HOME, { recursive: true });
  writeFileSync(SOURCE, 'line\n');
  const initialFile = await seedCache();
  expect(await openParseCache('claude').lookup(SOURCE)).not.toBeNull();
  pricing.fingerprint = 'new-rate';
  expect(await openParseCache('claude').lookup(SOURCE)).toBeNull();

  const older = join(CACHE_DIR, 'claude-0123456789ab.json');
  const legacy = join(CACHE_DIR, 'claude.json');
  writeFileSync(older, '{}');
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(older, hourAgo, hourAgo);
  writeFileSync(legacy, '{}');
  await seedCache(20);
  expect(readdirSync(CACHE_DIR).filter((file) => file.startsWith('claude'))).toHaveLength(3);
  expect(existsSync(older)).toBe(false);
  expect(existsSync(legacy)).toBe(true);

  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(legacy, weekAgo, weekAgo);
  utimesSync(initialFile, hourAgo, hourAgo);
  pricing.fingerprint = 'newest-rate'; // A process prunes once per cache file it saves.
  await seedCache(30);
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(initialFile)).toBe(false);

  pricing.fingerprint = 'new-rate';
  const kept = await openParseCache('claude').lookup(SOURCE);
  expect(kept?.days.get('2024-01-15')?.inputTokens).toBe(20);
  pricing.fingerprint = 'initial';
  rmSync(TEST_HOME, { recursive: true, force: true });
});

it('rejects corrupted message contributions and rebuilds only the affected entry', async () => {
  mkdirSync(TEST_HOME, { recursive: true });
  writeFileSync(SOURCE, 'line\n');
  const cache = openParseCache('claude');
  const message = {
    key: 'k',
    date: '2024-01-15',
    model: 'm',
    counts: { inputTokens: 10, outputTokens: 1, costUSD: 2 },
  };
  await cache.record(SOURCE, { days: days(10), keys: ['k'], messages: [message] });
  cache.save();
  const cacheFile = cacheFilePath();
  const raw: unknown = JSON.parse(readFileSync(cacheFile, 'utf8'));
  const stored = raw as { entries: Record<string, unknown> };
  for (const bad of [
    null,
    { mtimeMs: null },
    { mtimeMs: 1, size: 1, keys: 'bad' },
    { mtimeMs: 1, size: 1, keys: [], days: null },
    { mtimeMs: 1, size: 1, keys: [], days: { date: null } },
    {
      mtimeMs: 1,
      size: 1,
      keys: [],
      days: { date: { inputTokens: 1, outputTokens: 2, byModel: { m: null } } },
    },
  ]) {
    writeFileSync(cacheFile, JSON.stringify({ ...stored, entries: { [SOURCE]: bad } }));
    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  }
  for (const bad of [
    null,
    { ...message, key: 1 },
    { ...message, date: null },
    { ...message, model: null },
    { ...message, counts: { inputTokens: 1, outputTokens: 2, hasUnpricedTokens: 'bad' } },
    { ...message, counts: { inputTokens: 1, outputTokens: 2, costUSD: null } },
  ]) {
    writeFileSync(
      cacheFile,
      JSON.stringify({
        ...stored,
        entries: { [SOURCE]: { mtimeMs: 1, size: 1, keys: [], days: {}, messages: [bad] } },
      }),
    );
    await expect(openParseCache('claude').lookup(SOURCE)).resolves.toBeNull();
  }
  rmSync(TEST_HOME, { recursive: true, force: true });
});
