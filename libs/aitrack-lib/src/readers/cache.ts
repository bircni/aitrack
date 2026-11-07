import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomicWrite.js';
import { OPTIONAL_TOKEN_NUMBER_FIELDS } from '../constants.js';
import { isFiniteNumber, isRecord } from '../data/guards.js';
import type { DayEntry, DayMap, TokenCounts } from '../data/types.js';
import { isTokenCounts } from '../data/validate.js';
import { environmentValue } from '../env.js';
import { CACHE_DIR } from '../paths.js';
import { currentModelPricing } from '../pricing/store.js';
import { machineTimezone } from '../timezone.js';
import { packageVersion } from '../version.js';

/** Bump when the cached shape or baked-in cost changes; old caches are rebuilt, not migrated. */
const CACHE_FORMAT = 7;

const STALE_SIBLING_MS = 7 * 24 * 60 * 60 * 1000;

/** A transcript written this recently is likely to be appended to again. */
const ACTIVE_FILE_MS = 10 * 60 * 1000;

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

/**
 * Messages as one flat row per message over a string table, a fraction of the
 * size of objects to parse. A key slot indexes `keys`, or the table as -(i+1).
 */
interface EncodedMessages {
  strings: string[];
  rows: Array<number | null>;
}

const COUNT_FIELDS = [
  'inputTokens',
  'outputTokens',
  ...OPTIONAL_TOKEN_NUMBER_FIELDS,
] as const satisfies ReadonlyArray<keyof TokenCounts>;
const KEY = 0;
const DATE = 1;
const MODEL = 2;
const PROJECT = 3;
const CWD = 4;
const COUNTS = 5;
const UNPRICED = COUNTS + COUNT_FIELDS.length;
const STRIDE = UNPRICED + 1;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  days: Record<string, DayEntry>;
  keys: string[];
  /** JSON of `EncodedMessages`, left unparsed until a merge needs it. */
  messages?: string;
}

function encodeMessages(messages: CachedMessage[], keys: string[]): EncodedMessages {
  const strings: string[] = [];
  const indexes = new Map<string, number>();
  const intern = (value: string): number => {
    let index = indexes.get(value);
    if (index === undefined) {
      index = strings.push(value) - 1;
      indexes.set(value, index);
    }
    return index;
  };
  const keyIndexes = new Map(keys.map((key, index) => [key, index]));
  const rows: Array<number | null> = [];
  for (const { key, date, model, project, cwd, counts } of messages) {
    rows.push(
      key === undefined ? null : (keyIndexes.get(key) ?? -intern(key) - 1),
      intern(date),
      intern(model),
      intern(project),
      cwd === undefined ? null : intern(cwd),
    );
    for (const field of COUNT_FIELDS) rows.push(counts[field] ?? null);
    rows.push(counts.hasUnpricedTokens ? 1 : null);
  }
  return { strings, rows };
}

function decodeMessages({ strings, rows }: EncodedMessages, keys: string[]): CachedMessage[] {
  const text = (index: number | null | undefined): string => strings[index ?? -1] ?? '';
  const messages: CachedMessage[] = [];
  for (let at = 0; at < rows.length; at += STRIDE) {
    const counts: TokenCounts = { inputTokens: 0, outputTokens: 0 };
    let slot = at + COUNTS; // Per message and field, so nothing here allocates per field.
    for (const field of COUNT_FIELDS) {
      const value = rows[slot++];
      if (value !== null && value !== undefined) counts[field] = value;
    }
    if (rows[at + UNPRICED] === 1) counts.hasUnpricedTokens = true;
    const message: CachedMessage = {
      date: text(rows[at + DATE]),
      model: text(rows[at + MODEL]),
      counts,
      project: text(rows[at + PROJECT]),
    };
    const key = rows[at + KEY] ?? null;
    if (key !== null) message.key = key >= 0 ? (keys[key] ?? '') : text(-key - 1);
    const cwd = rows[at + CWD] ?? null;
    if (cwd !== null) message.cwd = text(cwd);
    messages.push(message);
  }
  return messages;
}

function isIndex(value: unknown, length: number): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < length;
}

function isEncodedMessages(value: unknown, keyCount: number): value is EncodedMessages {
  if (!isRecord(value) || !Array.isArray(value.strings) || !Array.isArray(value.rows)) return false;
  const { strings, rows } = value as { strings: unknown[]; rows: unknown[] };
  if (!strings.every((text) => typeof text === 'string') || rows.length % STRIDE !== 0) {
    return false;
  }
  for (let at = 0; at < rows.length; at += STRIDE) {
    const key = rows[at + KEY];
    const isKey =
      key === null || isIndex(key, keyCount) || isIndex(-(key as number) - 1, strings.length);
    const isText =
      isIndex(rows[at + DATE], strings.length) &&
      isIndex(rows[at + MODEL], strings.length) &&
      isIndex(rows[at + PROJECT], strings.length);
    const cwd = rows[at + CWD];
    if (!isKey || !isText || (cwd !== null && !isIndex(cwd, strings.length))) return false;
    for (let slot = COUNTS; slot < UNPRICED; slot++) {
      const count = rows[at + slot];
      if (!isFiniteNumber(count) && (slot < COUNTS + 2 || count !== null)) return false;
    }
    if (rows[at + UNPRICED] !== null && rows[at + UNPRICED] !== 1) return false;
  }
  return true;
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
  if (value.messages !== undefined && typeof value.messages !== 'string') return false;
  return isRecord(value.days) && Object.values(value.days).every((day) => isDayEntry(day));
}

function parseMessages(json: string, keys: string[]): CachedMessage[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return isEncodedMessages(parsed, keys.length) ? decodeMessages(parsed, keys) : undefined;
}

/** Decoded per stored entry, so a long-lived process decodes a file's messages once. */
const decodedMessages = new WeakMap<CacheEntry, CachedMessage[] | undefined>();

/**
 * Messages are decoded on first use: only a file sharing keys with an earlier
 * one needs them. A corrupt blob reads as absent, so the file's days count as a whole.
 */
function toParse(entry: CacheEntry): CachedParse {
  const { days, keys, messages } = entry;
  const parse = { days: new Map(Object.entries(days)), keys };
  if (messages === undefined) return parse;
  return {
    ...parse,
    get messages() {
      if (!decodedMessages.has(entry)) decodedMessages.set(entry, parseMessages(messages, keys));
      return decodedMessages.get(entry);
    },
  };
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

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export function fileStamp(filePath: string): FileStamp | null {
  try {
    const { mtimeMs, size } = statSync(filePath);
    return { mtimeMs, size };
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

function pruneOnce(name: string, fileName: string): void {
  const path = join(CACHE_DIR, fileName);
  if (prunedPaths.has(path)) return;
  prunedPaths.add(path);
  pruneSiblings(name, fileName);
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
  lookup: (filePath: string, stamp?: FileStamp | null) => CachedParse | null;
  record: (filePath: string, parse: CachedParse) => void;
  /** Total size of the files looked up and missed so far. */
  missedBytes: () => number;
  /** Persist. Entries never looked up this run are dropped, so deleted logs age out. */
  save: () => void;
}

/** A cache that stores nothing, used when AITRACK_NO_CACHE is set. */
function disabledCache(): ParseCache {
  let missedBytes = 0;
  return {
    lookup(filePath, stamp = fileStamp(filePath)) {
      missedBytes += stamp?.size ?? 0;
      return null;
    },
    record: () => undefined,
    missedBytes: () => missedBytes,
    save: () => undefined,
  };
}

/**
 * Only live transcripts changed, and rescanning them next run costs less than
 * rewriting all of history for entries their next append invalidates.
 */
function isCheaperToRescan(recorded: readonly FileStamp[], cacheFile: FileStamp | null): boolean {
  if (!cacheFile) return false;
  const activeSince = Date.now() - ACTIVE_FILE_MS;
  let recordedBytes = 0;
  for (const { mtimeMs, size } of recorded) {
    if (mtimeMs < activeSince) return false;
    recordedBytes += size;
  }
  return recordedBytes < cacheFile.size;
}

/** Per-file parse cache validated by mtime and size; one file per provider because readers run concurrently. */
export function openParseCache(name: string): ParseCache {
  if (environmentValue('AITRACK_NO_CACHE')) return disabledCache();

  const fileName = cacheFileName(name, currentModelPricing().fingerprint);
  const cachePath = join(CACHE_DIR, fileName);
  const previous = loadCacheFile(name, cachePath);
  const next: Record<string, CacheEntry> = {};
  const missed = new Map<string, FileStamp>();
  const recorded: FileStamp[] = [];

  return {
    lookup(filePath, stamp = fileStamp(filePath)) {
      if (!stamp) return null;
      const entry = previous[filePath];
      if (entry?.mtimeMs !== stamp.mtimeMs || entry.size !== stamp.size) {
        missed.set(filePath, stamp); // Before the parse, so a write during it reads as a change next run.
        return null;
      }
      next[filePath] = entry;
      return toParse(entry);
    },

    record(filePath, parse) {
      const stamp = missed.get(filePath) ?? fileStamp(filePath);
      if (!stamp) return; // Vanished mid-run; nothing to key the entry on.
      recorded.push(stamp);
      next[filePath] = {
        ...stamp,
        days: Object.fromEntries(parse.days),
        keys: parse.keys,
        ...(parse.messages && {
          messages: JSON.stringify(encodeMessages(parse.messages, parse.keys)),
        }),
      };
    },

    missedBytes() {
      let total = 0;
      for (const { size } of missed.values()) total += size;
      return total;
    },

    save() {
      const isEvicted = Object.keys(previous).some((filePath) => !(filePath in next));
      if (recorded.length === 0 && !isEvicted) return;
      const isUpdate = !isEvicted && Object.keys(previous).length > 0;
      if (isUpdate && isCheaperToRescan(recorded, fileStamp(cachePath))) {
        remember(name, cachePath, next); // A long-lived process keeps what it scanned.
        return;
      }
      try {
        writeFileAtomic(cachePath, JSON.stringify({ timezone: machineTimezone(), entries: next }));
      } catch {
        return; // A read-only home or full disk must not fail the command the cache only speeds up.
      }
      remember(name, cachePath, next);
      pruneOnce(name, fileName);
    },
  };
}

export interface MergedSnapshot {
  read: () => DayMap | null;
  write: (days: DayMap) => void;
}

const NO_SNAPSHOT: MergedSnapshot = { read: () => null, write: () => undefined };

/**
 * One provider's merged result for an exact list of source files, so an
 * unchanged corpus costs a stat per file rather than re-parsing the parse cache
 * and re-deduping every message. Read fresh each time: callers own what they get.
 */
export function openMergedSnapshot(
  name: string,
  files: readonly string[],
  stamps: ReadonlyArray<FileStamp | null>,
): MergedSnapshot {
  if (environmentValue('AITRACK_NO_CACHE')) return NO_SNAPSHOT;

  const snapshotName = `${name}-merged`;
  const fileName = cacheFileName(snapshotName, currentModelPricing().fingerprint);
  const path = join(CACHE_DIR, fileName);
  const hash = createHash('sha256').update(machineTimezone());
  for (const [index, file] of files.entries()) {
    const stamp = stamps[index];
    hash.update(`\0${file}\0${String(stamp?.mtimeMs)}\0${String(stamp?.size)}`);
  }
  const sources = hash.digest('hex');

  return {
    read() {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return null; // Missing or unreadable only costs a merge.
      }
      if (!isRecord(parsed) || parsed.sources !== sources || !isRecord(parsed.days)) return null;
      const days = Object.entries(parsed.days);
      return days.every(([, day]) => isDayEntry(day))
        ? new Map(days as Array<[string, DayEntry]>)
        : null;
    },

    write(days) {
      if (files.length === 0) return;
      try {
        writeFileAtomic(path, JSON.stringify({ sources, days: Object.fromEntries(days) }));
      } catch {
        return; // As with the parse cache, only ever a speed-up.
      }
      pruneOnce(snapshotName, fileName);
    },
  };
}
