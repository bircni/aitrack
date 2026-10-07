import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isFiniteNumber, isOptionalString, isRecord } from '../data/guards.js';
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

const STALE_SIBLING_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedMessage {
  key?: string;
  date: string;
  model: string;
  counts: TokenCounts;
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
  if (
    value.messages !== undefined &&
    (!Array.isArray(value.messages) ||
      !value.messages.every(
        (message) =>
          isRecord(message) &&
          isOptionalString(message.key) &&
          typeof message.date === 'string' &&
          typeof message.model === 'string' &&
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

function fileStamp(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const stats = statSync(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
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
    // Missing or unreadable: the logs are the source of truth, so an absent
    // cache is never an error — it only costs a full parse.
    return {};
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

  const pricingFingerprint = currentModelPricing().fingerprint;
  const fileName = cacheFileName(name, pricingFingerprint);
  const cachePath = join(CACHE_DIR, fileName);
  const previous = loadCacheFile(name, cachePath);
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
      return {
        days: new Map(Object.entries(entry.days)),
        keys: entry.keys,
        ...(entry.messages && { messages: entry.messages }),
      };
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
        ...(parse.messages && { messages: parse.messages }),
      };
    },

    save() {
      const isEvicted = Object.keys(previous).some((filePath) => !(filePath in next));
      if (!isRecorded && !isEvicted) return;
      const payload = JSON.stringify({ timezone: machineTimezone(), entries: next });
      // Write-then-rename so a concurrent reader never sees a half-written
      // file. A lost race just costs the next run a full parse.
      const temporaryPath = `${cachePath}.${String(process.pid)}.tmp`;
      try {
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(temporaryPath, payload, 'utf8');
        renameSync(temporaryPath, cachePath);
        remember(name, cachePath, next);
        if (!prunedPaths.has(cachePath)) {
          prunedPaths.add(cachePath);
          pruneSiblings(name, fileName);
        }
      } catch {
        rmSync(temporaryPath, { force: true });
        // A cache that cannot be written (read-only home, full disk) must not
        // fail the command it was only meant to speed up.
      }
    },
  };
}
