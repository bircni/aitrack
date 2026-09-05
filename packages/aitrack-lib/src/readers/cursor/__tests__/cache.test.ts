import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => {
  const temporary = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return `${temporary}/aitrack-cursor-cache-test`;
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { packageVersion } from '../../../version.js';
import {
  cursorCacheAgeSeconds,
  cursorCacheTtlSeconds,
  DEFAULT_CURSOR_CACHE_TTL_SECONDS,
  readCursorCache,
  writeCursorCache,
} from '../cache.js';
import { readCursorData } from '../index.js';

const CSV = ['Date,Model,Total Tokens,Output Tokens', '2026-02-02,gpt-4,100,10'].join('\n');

const CACHE_FILE = join(TEST_HOME, '.config', 'aitrack', 'cache', 'cursor.json');

describe('cursor CSV cache', () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env.AITRACK_NO_CACHE;
    delete process.env.AITRACK_CURSOR_CACHE_TTL;
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env.AITRACK_NO_CACHE;
    delete process.env.AITRACK_CURSOR_CACHE_TTL;
  });

  it('returns null when nothing is cached', () => {
    expect(readCursorCache()).toBeNull();
  });

  it('round-trips the CSV body and the working auth shape', () => {
    writeCursorCache({
      fetchedAt: '2026-01-01T00:00:00.000Z',
      csv: 'Date,Model\n',
      workingAuthShape: 'cookie',
    });

    expect(readCursorCache()).toEqual({
      fetchedAt: '2026-01-01T00:00:00.000Z',
      csv: 'Date,Model\n',
      workingAuthShape: 'cookie',
    });
  });

  it('ignores an entry written by another app version', () => {
    mkdirSync(join(TEST_HOME, '.config', 'aitrack', 'cache'), { recursive: true });
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({ format: 1, appVersion: '0.0.0-other', fetchedAt: 'x', csv: 'y' }),
      'utf8',
    );

    expect(readCursorCache()).toBeNull();
  });

  it('does not read or write when AITRACK_NO_CACHE is set', () => {
    writeCursorCache({ fetchedAt: new Date().toISOString(), csv: 'a' });
    process.env.AITRACK_NO_CACHE = '1';

    expect(readCursorCache()).toBeNull();
    writeCursorCache({ fetchedAt: new Date().toISOString(), csv: 'blocked' });

    delete process.env.AITRACK_NO_CACHE;
    expect(readCursorCache()?.csv).toBe('a');
  });

  it('embeds the current app version so a pricing bump invalidates it', () => {
    writeCursorCache({ fetchedAt: new Date().toISOString(), csv: 'a' });
    const raw: unknown = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    expect((raw as { appVersion: string }).appVersion).toBe(packageVersion());
  });

  describe('readCursorData with a cache', () => {
    const originalFetch = globalThis.fetch;
    // In afterEach, not inline: a failing assertion would otherwise leak the
    // env var and the console spy into every test below.
    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env.CURSOR_STATE_DB_PATH;
      vi.restoreAllMocks();
    });

    it('serves a fresh cache without a database read or network call', async () => {
      let fetchCalls = 0;
      globalThis.fetch = () => {
        fetchCalls++;
        return Promise.reject(new Error('should not fetch'));
      };
      writeCursorCache({ fetchedAt: new Date().toISOString(), csv: CSV });

      const map = await readCursorData({ maxAgeSeconds: 3600 });

      expect(fetchCalls).toBe(0);
      expect(map.get('2026-02-02')?.outputTokens).toBe(10);
    });

    it('re-fetches when the cache is older than maxAgeSeconds', async () => {
      globalThis.fetch = () => Promise.reject(new Error('offline'));
      writeCursorCache({ fetchedAt: '2000-01-01T00:00:00.000Z', csv: CSV });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      // No state DB configured, so the stale-cache fallback path returns the
      // cached rows rather than an empty map.
      process.env.CURSOR_STATE_DB_PATH = join(TEST_HOME, 'missing.vscdb');
      const map = await readCursorData({ maxAgeSeconds: 60 });

      expect(map.get('2026-02-02')?.outputTokens).toBe(10);
    });

    it('keeps the previous cache when a refresh returns no usable rows', async () => {
      const stateDb = join(TEST_HOME, 'state.vscdb');
      mkdirSync(TEST_HOME, { recursive: true });
      const database = new DatabaseSync(stateDb);
      database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
      database
        .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
        .run('cursorAuth/accessToken', 'token');
      database.close();
      process.env.CURSOR_STATE_DB_PATH = stateDb;

      writeCursorCache({ fetchedAt: '2000-01-01T00:00:00.000Z', csv: CSV });
      let fetchCalls = 0;
      globalThis.fetch = () => {
        fetchCalls++;
        return Promise.resolve(new Response('<html>sign in</html>', { status: 200 }));
      };
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const map = await readCursorData({ maxAgeSeconds: 60 });

      expect(fetchCalls).toBeGreaterThan(0);

      // The empty export must not overwrite the cache, or Cursor would stay
      // dark for the whole TTL instead of retrying on the next command.
      expect(readCursorCache()?.csv).toBe(CSV);
      expect(map.get('2026-02-02')?.outputTokens).toBe(10);
    });
  });

  describe('cursorCacheAgeSeconds', () => {
    it('measures age from fetchedAt', () => {
      const now = Date.parse('2026-01-01T01:00:00.000Z');
      expect(cursorCacheAgeSeconds({ fetchedAt: '2026-01-01T00:00:00.000Z', csv: '' }, now)).toBe(
        3600,
      );
    });

    it('is Infinity for an unparseable timestamp', () => {
      expect(cursorCacheAgeSeconds({ fetchedAt: 'not-a-date', csv: '' })).toBe(Infinity);
    });
  });

  describe('cursorCacheTtlSeconds', () => {
    it('defaults to six hours', () => {
      expect(cursorCacheTtlSeconds()).toBe(DEFAULT_CURSOR_CACHE_TTL_SECONDS);
    });

    it('honours AITRACK_CURSOR_CACHE_TTL', () => {
      process.env.AITRACK_CURSOR_CACHE_TTL = '30';
      expect(cursorCacheTtlSeconds()).toBe(30);
    });

    it('falls back to the default for a non-numeric override', () => {
      process.env.AITRACK_CURSOR_CACHE_TTL = 'soon';
      expect(cursorCacheTtlSeconds()).toBe(DEFAULT_CURSOR_CACHE_TTL_SECONDS);
    });
  });
});
