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

const runtime = vi.hoisted(() => ({ version: '1.0.0', timezone: 'Europe/Berlin' }));
vi.mock('../../version.js', () => ({ packageVersion: () => runtime.version }));
vi.mock('../../timezone.js', () => ({ machineTimezone: () => runtime.timezone }));

import type { DayMap } from '../../data/types.js';
import { fileStamp, openMergedSnapshot, openParseCache } from '../cache.js';

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
function seedCache(inputTokens = 10): string {
  const cache = openParseCache('claude');
  cache.record(SOURCE, { days: days(inputTokens), keys: ['k1'] });
  cache.save();
  return cacheFilePath();
}

function rewrite(file: string, search: string, replacement: string): void {
  writeFileSync(file, readFileSync(file, 'utf8').replace(search, replacement));
}

function open(): ReturnType<typeof openMergedSnapshot> {
  return openMergedSnapshot('claude', [SOURCE], [fileStamp(SOURCE)]);
}

describe('openParseCache', () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
    writeFileSync(SOURCE, 'line\n');
    delete process.env.AITRACK_NO_CACHE;
    pricing.fingerprint = 'initial';
    runtime.version = '1.0.0';
    runtime.timezone = 'Europe/Berlin';
  });

  afterEach(() => {
    delete process.env.AITRACK_NO_CACHE;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('misses when nothing has been cached yet', () => {
    expect(openParseCache('claude').lookup(SOURCE)).toBeNull();
  });

  it('returns a recorded parse on the next run', () => {
    seedCache();

    const hit = openParseCache('claude').lookup(SOURCE);

    expect(hit?.keys).toEqual(['k1']);
    expect(hit?.days.get('2024-01-15')?.inputTokens).toBe(10);
  });

  it.each<[string, (cacheFile: string) => void]>([
    [
      'the file size changes',
      () => {
        writeFileSync(SOURCE, 'line\nline2\n');
      },
    ],
    [
      'the file mtime changes without a size change',
      () => {
        const later = new Date(Date.now() + 60_000);
        utimesSync(SOURCE, later, later);
      },
    ],
    [
      'the file is gone',
      () => {
        rmSync(SOURCE);
      },
    ],
    [
      'the cache was written in another timezone',
      (cacheFile) => {
        const stored: unknown = JSON.parse(readFileSync(cacheFile, 'utf8'));
        writeFileSync(cacheFile, JSON.stringify({ ...(stored as object), timezone: 'Not/A-Zone' }));
      },
    ],
    [
      'the cache file is corrupt',
      (cacheFile) => {
        writeFileSync(cacheFile, '{not json');
      },
    ],
    [
      'an entry has non-finite day totals',
      (cacheFile) => {
        rewrite(cacheFile, '"inputTokens":10', '"inputTokens":null');
      },
    ],
    [
      'an entry has non-string dedup keys',
      (cacheFile) => {
        rewrite(cacheFile, '"k1"', '42');
      },
    ],
  ])('misses when %s', (_label, mutate) => {
    mutate(seedCache());

    expect(openParseCache('claude').lookup(SOURCE)).toBeNull();
  });

  it.each<[string, () => void]>([
    [
      'the app was upgraded',
      () => {
        runtime.version = '1.0.1';
      },
    ],
    [
      'the time zone changed in a running process',
      () => {
        runtime.timezone = 'Asia/Tokyo';
      },
    ],
  ])('misses in memory too when %s', (_label, change) => {
    seedCache();
    expect(openParseCache('claude').lookup(SOURCE)).not.toBeNull();
    change();
    expect(openParseCache('claude').lookup(SOURCE)).toBeNull();
  });

  it('re-parses a file that grew while it was being parsed', () => {
    const cache = openParseCache('claude');
    expect(cache.lookup(SOURCE)).toBeNull();
    writeFileSync(SOURCE, 'line\nappended\n');
    cache.record(SOURCE, { days: days(10), keys: ['k1'] });
    cache.save();

    expect(openParseCache('claude').lookup(SOURCE)).toBeNull();
  });

  it('records nothing for a file that vanishes before it can be stat-ed', () => {
    const gone = join(TEST_HOME, 'never-existed.jsonl');
    const cache = openParseCache('claude');

    cache.record(gone, { days: days(5), keys: ['k1'] });
    cache.save();

    expect(openParseCache('claude').lookup(gone)).toBeNull();
  });

  it('reuses an unchanged cache in memory and does not rewrite it when nothing changed', () => {
    seedCache();
    vi.mocked(readFileSync).mockClear();
    vi.mocked(renameSync).mockClear();

    for (let run = 0; run < 2; run++) {
      const cache = openParseCache('claude');
      const entry = cache.lookup(SOURCE);
      expect(entry?.keys).toEqual(['k1']);
      cache.save();
    }

    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });

  it('does not throw when the cache file cannot be replaced', () => {
    // A directory sitting where the cache file goes makes the rename fail; the
    // command it was speeding up must not care.
    const cacheFile = seedCache();
    rmSync(cacheFile);
    mkdirSync(cacheFile);
    const cache = openParseCache('claude');
    cache.record(SOURCE, { days: days(10), keys: ['k1'] });

    expect(() => {
      cache.save();
    }).not.toThrow();
    expect(existsSync(`${cacheFile}.${String(process.pid)}.tmp`)).toBe(false);
  });

  it('forgets files that were not looked up, so deleted logs age out', () => {
    seedCache();

    // A run that never touches SOURCE must not carry its entry forward.
    openParseCache('claude').save();

    expect(openParseCache('claude').lookup(SOURCE)).toBeNull();
  });

  it('keeps providers in separate files so concurrent readers do not clobber', () => {
    seedCache();
    const codex = openParseCache('codex');
    codex.record(SOURCE, { days: days(99), keys: [] });
    codex.save();

    const claudeHit = openParseCache('claude').lookup(SOURCE);
    const codexHit = openParseCache('codex').lookup(SOURCE);

    expect(claudeHit?.days.get('2024-01-15')?.inputTokens).toBe(10);
    expect(codexHit?.days.get('2024-01-15')?.inputTokens).toBe(99);
  });

  it('stores nothing when AITRACK_NO_CACHE is set', () => {
    process.env.AITRACK_NO_CACHE = '1';

    const cache = openParseCache('claude');
    expect(cache.lookup(SOURCE)).toBeNull();
    cache.record(SOURCE, { days: days(10), keys: ['k1'] });
    cache.save();

    delete process.env.AITRACK_NO_CACHE;
    expect(openParseCache('claude').lookup(SOURCE)).toBeNull();
  });

  it('keeps a file per pricing key, the newest other key and a fresh unkeyed file', () => {
    const initialFile = seedCache();
    expect(openParseCache('claude').lookup(SOURCE)).not.toBeNull();
    pricing.fingerprint = 'new-rate';
    expect(openParseCache('claude').lookup(SOURCE)).toBeNull();

    const older = join(CACHE_DIR, 'claude-0123456789ab.json');
    const legacy = join(CACHE_DIR, 'claude.json');
    writeFileSync(older, '{}');
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(older, hourAgo, hourAgo);
    writeFileSync(legacy, '{}');
    seedCache(20);
    expect(readdirSync(CACHE_DIR).filter((file) => file.startsWith('claude'))).toHaveLength(3);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(legacy)).toBe(true);

    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(legacy, weekAgo, weekAgo);
    utimesSync(initialFile, hourAgo, hourAgo);
    pricing.fingerprint = 'newest-rate'; // A process prunes once per cache file it saves.
    seedCache(30);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(initialFile)).toBe(false);

    pricing.fingerprint = 'new-rate';
    const kept = openParseCache('claude').lookup(SOURCE);
    expect(kept?.days.get('2024-01-15')?.inputTokens).toBe(20);
  });

  it('rejects corrupted entries and reads a corrupted message blob as absent', () => {
    const cache = openParseCache('claude');
    const messages = [
      {
        key: 'k',
        date: '2024-01-15',
        model: 'm',
        counts: { inputTokens: 10, outputTokens: 1, costUSD: 2 },
        project: 'o/r',
      },
      {
        key: 'not-in-keys',
        date: '2024-01-16',
        model: 'm',
        counts: { inputTokens: 3, outputTokens: 0, rawInputTokens: 3, hasUnpricedTokens: true },
        project: '(no remote)',
        cwd: '/work',
      },
      {
        date: '2024-01-16',
        model: 'n',
        counts: { inputTokens: 1, outputTokens: 1 },
        project: 'o/r',
      },
    ];
    cache.record(SOURCE, { days: days(10), keys: ['k'], messages });
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
        days: { date: { inputTokens: 1, outputTokens: 2, byModel: {}, byProject: { p: null } } },
      },
      {
        mtimeMs: 1,
        size: 1,
        keys: [],
        days: { date: { inputTokens: 1, outputTokens: 2, byModel: {}, byCwd: 'bad' } },
      },
      {
        mtimeMs: 1,
        size: 1,
        keys: [],
        days: { date: { inputTokens: 1, outputTokens: 2, byModel: { m: null } } },
      },
    ]) {
      writeFileSync(cacheFile, JSON.stringify({ ...stored, entries: { [SOURCE]: bad } }));
      expect(openParseCache('claude').lookup(SOURCE)).toBeNull();
    }
    const entry = (stored.entries[SOURCE] ?? {}) as Record<string, unknown>;
    writeFileSync(cacheFile, JSON.stringify(stored));
    const intact = openParseCache('claude').lookup(SOURCE);
    expect(intact?.messages).toEqual(messages);
    const encoded = JSON.parse(String(entry.messages)) as { strings: string[]; rows: unknown[] };
    const blobs = [
      '{not json',
      ...(
        [
          [0, 9],
          [1, 'date'],
          [4, -1],
          [5, null],
          [6, 'tokens'],
          [7, 'raw'],
          [12, 2],
        ] as const
      ).map(([slot, value]) =>
        JSON.stringify({ ...encoded, rows: encoded.rows.with(slot, value) }),
      ),
    ];
    for (const blob of blobs) {
      writeFileSync(
        cacheFile,
        JSON.stringify({ ...stored, entries: { [SOURCE]: { ...entry, messages: blob } } }),
      );
      const hit = openParseCache('claude').lookup(SOURCE);
      expect(hit?.days.get('2024-01-15')?.inputTokens).toBe(10);
      expect(hit?.messages).toBeUndefined();
    }
  });

  describe('saving after only a live transcript changed', () => {
    const OTHER = join(TEST_HOME, 'b.jsonl');

    function appendAndSave(): number {
      vi.mocked(renameSync).mockClear();
      writeFileSync(SOURCE, `${readFileSync(SOURCE, 'utf8')}more\n`);
      const cache = openParseCache('claude');
      expect(cache.lookup(SOURCE)).toBeNull();
      expect(cache.lookup(OTHER)).not.toBeNull();
      cache.record(SOURCE, { days: days(50), keys: ['k1'] });
      cache.save();
      return vi.mocked(renameSync).mock.calls.length;
    }

    beforeEach(() => {
      writeFileSync(OTHER, 'line\n');
      const cache = openParseCache('claude');
      cache.record(SOURCE, { days: days(10), keys: ['k1'] });
      cache.record(OTHER, { days: days(10), keys: ['k2'] });
      cache.save();
    });

    it('skips the rewrite, and a long-lived process keeps the scan', () => {
      const before = readFileSync(cacheFilePath(), 'utf8');
      expect(appendAndSave()).toBe(0);
      expect(readFileSync(cacheFilePath(), 'utf8')).toBe(before);

      expect(openParseCache('claude').lookup(SOURCE)?.days.get('2024-01-15')?.inputTokens).toBe(50);
    });

    it('still rewrites once the transcript has gone quiet', () => {
      writeFileSync(SOURCE, 'grown\n');
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(SOURCE, hourAgo, hourAgo);
      vi.mocked(renameSync).mockClear();
      const cache = openParseCache('claude');
      expect(cache.lookup(SOURCE)).toBeNull();
      expect(cache.lookup(OTHER)).not.toBeNull();
      cache.record(SOURCE, { days: days(50), keys: ['k1'] });
      cache.save();
      expect(renameSync).toHaveBeenCalledTimes(1);
    });

    it('still rewrites when the scan would cost more than the write', () => {
      writeFileSync(SOURCE, 'x'.repeat(1024 * 1024));
      vi.mocked(renameSync).mockClear();
      const cache = openParseCache('claude');
      expect(cache.lookup(SOURCE)).toBeNull();
      expect(cache.lookup(OTHER)).not.toBeNull();
      cache.record(SOURCE, { days: days(50), keys: ['k1'] });
      cache.save();
      expect(renameSync).toHaveBeenCalledTimes(1);
    });

    it('still rewrites when a log was deleted', () => {
      writeFileSync(SOURCE, 'grown\n');
      vi.mocked(renameSync).mockClear();
      const cache = openParseCache('claude');
      expect(cache.lookup(SOURCE)).toBeNull();
      cache.record(SOURCE, { days: days(50), keys: ['k1'] });
      cache.save();
      expect(renameSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('openMergedSnapshot', () => {
    it('reads back the very days written, as new objects', () => {
      expect(open().read()).toBeNull();
      const written = days(10);
      open().write(written);

      const read = open().read();
      expect([...(read ?? [])]).toEqual([...written]);
      expect(read?.get('2024-01-15')).not.toBe(open().read()?.get('2024-01-15'));
    });

    it.each<[string, () => void]>([
      [
        'a source changes',
        () => {
          writeFileSync(SOURCE, 'line\nline2\n');
        },
      ],
      [
        'pricing changes',
        () => {
          pricing.fingerprint = 'new-rate';
        },
      ],
      [
        'the app is upgraded',
        () => {
          runtime.version = '1.0.1';
        },
      ],
      [
        'the time zone changes',
        () => {
          runtime.timezone = 'Asia/Tokyo';
        },
      ],
      [
        'the snapshot is corrupt',
        () => {
          const file = readdirSync(CACHE_DIR).find((name) => name.startsWith('claude-merged-'));
          writeFileSync(join(CACHE_DIR, file ?? ''), '{not json');
        },
      ],
      [
        'its days do not validate',
        () => {
          const file = join(
            CACHE_DIR,
            readdirSync(CACHE_DIR).find((name) => name.startsWith('claude-merged-')) ?? '',
          );
          rewrite(file, '"inputTokens":10', '"inputTokens":null');
        },
      ],
    ])('misses when %s', (_label, change) => {
      open().write(days(10));
      change();
      expect(open().read()).toBeNull();
    });

    it('misses when the file list changes', () => {
      open().write(days(10));
      const other = join(TEST_HOME, 'b.jsonl');
      writeFileSync(other, 'line\n');
      const files = [SOURCE, other];
      expect(
        openMergedSnapshot(
          'claude',
          files,
          files.map((file) => fileStamp(file)),
        ).read(),
      ).toBeNull();
    });

    it('stores nothing when AITRACK_NO_CACHE is set or there is no source', () => {
      openMergedSnapshot('claude', [], []).write(days(10));
      expect(existsSync(CACHE_DIR)).toBe(false);
      process.env.AITRACK_NO_CACHE = '1';
      open().write(days(10));
      expect(open().read()).toBeNull();
      expect(existsSync(CACHE_DIR)).toBe(false);
    });

    it('keeps one other keyed snapshot, for a CLI and app on different versions', () => {
      open().write(days(10));
      const older = join(CACHE_DIR, 'claude-merged-0123456789ab.json');
      writeFileSync(older, '{}');
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(older, hourAgo, hourAgo);
      pricing.fingerprint = 'snapshot-prune';
      open().write(days(20));
      expect(existsSync(older)).toBe(false);
      expect(
        readdirSync(CACHE_DIR).filter((name) => name.startsWith('claude-merged-')),
      ).toHaveLength(2);
    });
  });
});
