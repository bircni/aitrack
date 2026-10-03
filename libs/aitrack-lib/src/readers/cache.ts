import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isFiniteNumber, isRecord } from '../data/guards.js';
import type { DayEntry, DayMap, TokenCounts } from '../data/types.js';
import { environmentValue } from '../env.js';
import { CACHE_DIR } from '../paths.js';
import { currentModelPricing } from '../pricing/store.js';
import { machineTimezone } from '../timezone.js';
import { packageVersion } from '../version.js';

/**
 * Bump when the cached shape or the cost baked into it changes. Entries written
 * by another format are dropped wholesale rather than migrated — they are
 * rebuildable from the logs.
 */
const CACHE_FORMAT = 3;

/** One transcript file's contribution, as cached. */
export interface CachedParse {
  days: DayMap;
  /**
   * The dedup keys this file holds. A cached file still has to be checked
   * against the keys already counted, because a resumed session can copy
   * another transcript's messages into itself.
   */
  keys: string[];
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  days: Record<string, DayEntry>;
  keys: string[];
}

function isTokenCounts(value: unknown): value is TokenCounts {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.inputTokens) || !isFiniteNumber(value.outputTokens)) return false;
  if (value.hasUnpricedTokens !== undefined && typeof value.hasUnpricedTokens !== 'boolean')
    return false;
  return (
    [
      'cachedInputTokens',
      'rawInputTokens',
      'cacheCreationInputTokens',
      'cacheCreation1hInputTokens',
      'costUSD',
    ] as const
  ).every((field) => value[field] === undefined || isFiniteNumber(value[field]));
}

function isDayEntry(value: unknown): value is DayEntry {
  if (!isTokenCounts(value) || !isRecord(value) || !isRecord(value.byModel)) return false;
  return Object.values(value.byModel).every((counts) => isTokenCounts(counts));
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.mtimeMs) || !isFiniteNumber(value.size)) return false;
  if (!Array.isArray(value.keys) || !value.keys.every((key) => typeof key === 'string')) {
    return false;
  }
  return isRecord(value.days) && Object.values(value.days).every((day) => isDayEntry(day));
}

interface MemoizedCache {
  mtimeMs: number;
  size: number;
  timezone: string;
  pricingFingerprint: string;
  entries: Record<string, CacheEntry>;
}

/** Last validated contents per cache file, so a long-lived process skips re-reading an unchanged one. */
const memoized = new Map<string, MemoizedCache>();

function fileStamp(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const stats = statSync(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

function remember(
  filePath: string,
  entries: Record<string, CacheEntry>,
  pricingFingerprint: string,
): void {
  const stamp = fileStamp(filePath);
  if (stamp)
    memoized.set(filePath, { ...stamp, timezone: machineTimezone(), pricingFingerprint, entries });
  else memoized.delete(filePath);
}

function loadCacheFile(filePath: string, pricingFingerprint: string): Record<string, CacheEntry> {
  const stamp = fileStamp(filePath);
  const memo = memoized.get(filePath);
  if (
    stamp &&
    memo?.mtimeMs === stamp.mtimeMs &&
    memo.size === stamp.size &&
    memo.timezone === machineTimezone() &&
    memo.pricingFingerprint === pricingFingerprint
  ) {
    return memo.entries;
  }
  const entries = readCacheFile(filePath, pricingFingerprint);
  remember(filePath, entries, pricingFingerprint);
  return entries;
}

function readCacheFile(filePath: string, pricingFingerprint: string): Record<string, CacheEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    // Missing or unreadable: the logs are the source of truth, so an absent
    // cache is never an error — it only costs a full parse.
    return {};
  }

  if (
    !isRecord(parsed) ||
    parsed.format !== CACHE_FORMAT ||
    // Costs are baked in at parse time, so a release that changes the pricing
    // tables must invalidate everything rather than serve stale dollars.
    parsed.appVersion !== packageVersion() ||
    parsed.timezone !== machineTimezone() ||
    parsed.pricingFingerprint !== pricingFingerprint ||
    !isRecord(parsed.entries)
  ) {
    return {};
  }

  const entries: Record<string, CacheEntry> = {};
  for (const [path, entry] of Object.entries(parsed.entries)) {
    if (isCacheEntry(entry)) entries[path] = entry;
  }
  return entries;
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

/**
 * Per-file parse cache for one provider's transcripts.
 *
 * Every command re-derives usage from the whole local corpus, which is the bulk
 * of its runtime, yet transcript files are append-mostly and the overwhelming
 * majority are byte-identical between runs. Entries are keyed by absolute path
 * and validated against the file's mtime and size.
 *
 * `name` gives each provider its own file: the readers run concurrently, and a
 * shared file would have them clobbering each other's writes.
 */
export function openParseCache(name: string): ParseCache {
  if (environmentValue('AITRACK_NO_CACHE')) return disabledCache();

  const cachePath = join(CACHE_DIR, `${name}.json`);
  const pricingFingerprint = currentModelPricing().fingerprint;
  const previous = loadCacheFile(cachePath, pricingFingerprint);
  const next: Record<string, CacheEntry> = {};
  let isRecorded = false;

  return {
    async lookup(filePath) {
      const entry = previous[filePath];
      if (!entry) return null;
      try {
        const stats = await stat(filePath);
        if (stats.mtimeMs !== entry.mtimeMs || stats.size !== entry.size) return null;
      } catch {
        return null;
      }
      next[filePath] = entry;
      return { days: new Map(Object.entries(entry.days)), keys: entry.keys };
    },

    async record(filePath, parse) {
      let stats;
      try {
        stats = await stat(filePath);
      } catch {
        // The file vanished mid-run; nothing to key the entry on.
        return;
      }
      isRecorded = true;
      next[filePath] = {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        days: Object.fromEntries(parse.days),
        keys: parse.keys,
      };
    },

    save() {
      const isEvicted = Object.keys(previous).some((filePath) => !(filePath in next));
      if (!isRecorded && !isEvicted) return;
      const payload = JSON.stringify({
        format: CACHE_FORMAT,
        appVersion: packageVersion(),
        timezone: machineTimezone(),
        pricingFingerprint,
        entries: next,
      });
      // Write-then-rename so a concurrent reader never sees a half-written
      // file. A lost race just costs the next run a full parse.
      const temporaryPath = `${cachePath}.${String(process.pid)}.tmp`;
      try {
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(temporaryPath, payload, 'utf8');
        renameSync(temporaryPath, cachePath);
        remember(cachePath, next, pricingFingerprint);
      } catch {
        rmSync(temporaryPath, { force: true });
        // A cache that cannot be written (read-only home, full disk) must not
        // fail the command it was only meant to speed up.
      }
    },
  };
}
