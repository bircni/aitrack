import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, type Stats, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomicWrite.js';
import { isFiniteNumber, isOptionalString, isRecord } from '../data/guards.js';
import type { DayEntry, DayMap, TokenCounts } from '../data/types.js';
import { isTokenCounts } from '../data/validate.js';
import { environmentValue } from '../env.js';
import { CACHE_DIR } from '../paths.js';
import { currentModelPricing } from '../pricing/store.js';
import { machineTimezone } from '../timezone.js';
import { packageVersion } from '../version.js';

/** Bump when the cached shape or baked-in cost changes; old caches are rebuilt, not migrated. */
const CACHE_FORMAT = 5;

const STALE_SIBLING_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedMessage {
  key?: string;
  date: string;
  model: string;
  counts: TokenCounts;
  project: string;
  /** Set for work without a remote, to match `--dir` on this machine. */
  cwd?: string;
}

/** One transcript file's contribution, as cached. */
export interface CachedParse {
  days: DayMap;
  /**
   * The dedup keys this file holds. A cached file still has to be checked
   * against the keys already counted, because a resumed session can copy
   * another transcript's messages into itself.
   */
  keys: string[];
  messages?: CachedMessage[];
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  days: Record<string, DayEntry>;
  keys: string[];
  messages?: CachedMessage[];
}

function isCountsRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((counts) => isTokenCounts(counts));
}

function isDayEntry(value: unknown): value is DayEntry {
  if (!isTokenCounts(value) || !isRecord(value) || !isCountsRecord(value.byModel)) return false;
  return (
    (value.byProject === undefined || isCountsRecord(value.byProject)) &&
    (value.byCwd === undefined || isCountsRecord(value.byCwd))
  );
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.mtimeMs) || !isFiniteNumber(value.size)) return false;
  if (!Array.isArray(value.keys) || !value.keys.every((key) => typeof key === 'string')) {
    return false;
  }
  if (
    value.messages !== undefined &&
    (!Array.isArray(value.messages) ||
      !value.messages.every(
        (message) =>
          isRecord(message) &&
          isOptionalString(message.key) &&
          typeof message.date === 'string' &&
          typeof message.model === 'string' &&
          typeof message.project === 'string' &&
          isOptionalString(message.cwd) &&
          isTokenCounts(message.counts),
      ))
  )
    return false;
  return isRecord(value.days) && Object.values(value.days).every((day) => isDayEntry(day));
}

interface MemoizedCache {
  path: string;
  mtimeMs: number;
  size: number;
  timezone: string;
  entries: Record<string, CacheEntry>;
}

/** Last validated contents per provider, so a long-lived process skips re-reading an unchanged file. */
const memoized = new Map<string, MemoizedCache>();

/** Pruned once per file per process: whoever writes a new sibling prunes on its own first save. */
const prunedPaths = new Set<string>();

interface FileStamp {
  mtimeMs: number;
  size: number;
}

function toStamp({ mtimeMs, size }: Stats): FileStamp {
  return { mtimeMs, size };
}

function fileStamp(filePath: string): FileStamp | null {
  try {
    return toStamp(statSync(filePath));
  } catch {
    return null;
  }
}

function statStamp(filePath: string): Promise<FileStamp | null> {
  return stat(filePath).then(toStamp, () => null);
}

function remember(name: string, path: string, entries: Record<string, CacheEntry>): void {
  const stamp = fileStamp(path);
  if (stamp) memoized.set(name, { path, ...stamp, timezone: machineTimezone(), entries });
  else memoized.delete(name);
}

function loadCacheFile(name: string, path: string): Record<string, CacheEntry> {
  const stamp = fileStamp(path);
  const memo = memoized.get(name);
  if (
    stamp &&
    memo?.path === path &&
    memo.mtimeMs === stamp.mtimeMs &&
    memo.size === stamp.size &&
    memo.timezone === machineTimezone()
  ) {
    return memo.entries;
  }
  const entries = readCacheFile(path);
  remember(name, path, entries);
  return entries;
}

function readCacheFile(filePath: string): Record<string, CacheEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return {}; // Missing or unreadable only costs a full parse.
  }

  if (!isRecord(parsed) || parsed.timezone !== machineTimezone() || !isRecord(parsed.entries)) {
    return {};
  }

  const entries: Record<string, CacheEntry> = {};
  for (const [path, entry] of Object.entries(parsed.entries)) {
    if (isCacheEntry(entry)) entries[path] = entry;
  }
  return entries;
}

/** Costs are baked in at parse time, so format, version and pricing pack all key the file; the CLI and sidecar may differ. */
function cacheFileName(name: string, pricingFingerprint: string): string {
  const key = createHash('sha256')
    .update(`${String(CACHE_FORMAT)}\0${packageVersion()}\0${pricingFingerprint}`)
    .digest('hex')
    .slice(0, 12);
  return `${name}-${key}.json`;
}

/** Keeps the newest other keyed file, which another live writer (CLI or app) refreshes on each save. */
function pruneSiblings(name: string, current: string): void {
  const keyed = new RegExp(`^${name}-[0-9a-f]+\\.json$`, 'u');
  try {
    const others = readdirSync(CACHE_DIR)
      .filter((file) => file !== current && keyed.test(file))
      .map((file) => ({
        path: join(CACHE_DIR, file),
        mtimeMs: fileStamp(join(CACHE_DIR, file))?.mtimeMs ?? 0,
      }))
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { path } of others.slice(1)) rmSync(path, { force: true });
    const legacy = join(CACHE_DIR, `${name}.json`); // Still read by a not-yet-updated CLI or app.
    const legacyStamp = fileStamp(legacy);
    if (legacyStamp && Date.now() - legacyStamp.mtimeMs > STALE_SIBLING_MS)
      rmSync(legacy, { force: true });
  } catch {
    // Pruning is housekeeping; a failure must not fail the command.
  }
}

export interface ParseCache {
  /** The cached parse for `filePath`, or null when absent or stale. */
  lookup: (filePath: string) => Promise<CachedParse | null>;
  record: (filePath: string, parse: CachedParse) => Promise<void>;
  /** Persist. Entries never looked up this run are dropped, so deleted logs age out. */
  save: () => void;
}

/** A cache that stores nothing, used when AITRACK_NO_CACHE is set. */
function disabledCache(): ParseCache {
  return {
    lookup: () => Promise.resolve(null),
    record: () => Promise.resolve(),
    save: () => undefined,
  };
}

/** Per-file parse cache validated by mtime and size; one file per provider because readers run concurrently. */
export function openParseCache(name: string): ParseCache {
  if (environmentValue('AITRACK_NO_CACHE')) return disabledCache();

  const pricingFingerprint = currentModelPricing().fingerprint;
  const fileName = cacheFileName(name, pricingFingerprint);
  const cachePath = join(CACHE_DIR, fileName);
  const previous = loadCacheFile(name, cachePath);
  const next: Record<string, CacheEntry> = {};
  const missed = new Map<string, FileStamp>();
  let isRecorded = false;

  return {
    async lookup(filePath) {
      const stamp = await statStamp(filePath);
      if (!stamp) return null;
      const entry = previous[filePath];
      if (entry?.mtimeMs !== stamp.mtimeMs || entry.size !== stamp.size) {
        missed.set(filePath, stamp); // Before the parse, so a write during it reads as a change next run.
        return null;
      }
      next[filePath] = entry;
      return {
        days: new Map(Object.entries(entry.days)),
        keys: entry.keys,
        ...(entry.messages && { messages: entry.messages }),
      };
    },

    async record(filePath, parse) {
      const stamp = missed.get(filePath) ?? (await statStamp(filePath));
      if (!stamp) return; // Vanished mid-run; nothing to key the entry on.
      isRecorded = true;
      next[filePath] = {
        ...stamp,
        days: Object.fromEntries(parse.days),
        keys: parse.keys,
        ...(parse.messages && { messages: parse.messages }),
      };
    },

    save() {
      const isEvicted = Object.keys(previous).some((filePath) => !(filePath in next));
      if (!isRecorded && !isEvicted) return;
      try {
        writeFileAtomic(cachePath, JSON.stringify({ timezone: machineTimezone(), entries: next }));
      } catch {
        return; // A read-only home or full disk must not fail the command the cache only speeds up.
      }
      remember(name, cachePath, next);
      if (prunedPaths.has(cachePath)) return;
      prunedPaths.add(cachePath);
      pruneSiblings(name, fileName);
    },
  };
}
