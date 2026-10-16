import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../../atomicWrite.js';
import { isFiniteNumber, isRecord } from '../../data/guards.js';
import { environmentValue } from '../../env.js';
import { CACHE_DIR } from '../../paths.js';
import { machineTimezone } from '../../timezone.js';
import { packageVersion } from '../../version.js';

// Caches the raw CSV, not the DayMap, so csv.ts stays the only parser.
const CACHE_FORMAT = 2;
const CACHE_FILE = 'cursor.json';

/** Default max age for a served cache entry, in seconds (6 hours). */
export const DEFAULT_CURSOR_CACHE_TTL_SECONDS = 21_600;

export interface CursorCacheEntry {
  fetchedAt: string;
  csv: string;
  accountId: string;
  /** Label of the credential shape that produced this CSV, for the next fetch. */
  workingAuthShape?: string;
}

/** TTL for a served Cursor cache entry: `AITRACK_CURSOR_CACHE_TTL` or the default. */
export function cursorCacheTtlSeconds(): number {
  const raw = environmentValue('AITRACK_CURSOR_CACHE_TTL');
  if (raw === undefined) return DEFAULT_CURSOR_CACHE_TTL_SECONDS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CURSOR_CACHE_TTL_SECONDS;
}

function cachePath(): string {
  return join(CACHE_DIR, CACHE_FILE);
}

/**
 * The cached CSV export, or null when there is none, it is unreadable, it was
 * written by another format/version, or caching is disabled.
 */
export function readCursorCache(): CursorCacheEntry | null {
  if (environmentValue('AITRACK_NO_CACHE')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cachePath(), 'utf8'));
  } catch {
    return null;
  }

  if (
    !isRecord(parsed) ||
    parsed.format !== CACHE_FORMAT ||
    // A parser/app change must not keep serving a CSV read under old rules.
    parsed.appVersion !== packageVersion() ||
    parsed.timezone !== machineTimezone() ||
    typeof parsed.csv !== 'string' ||
    typeof parsed.fetchedAt !== 'string' ||
    typeof parsed.accountId !== 'string'
  ) {
    return null;
  }

  return {
    fetchedAt: parsed.fetchedAt,
    accountId: parsed.accountId,
    csv: parsed.csv,
    workingAuthShape:
      typeof parsed.workingAuthShape === 'string' ? parsed.workingAuthShape : undefined,
  };
}

/** Age of a cache entry in seconds, or Infinity when its timestamp is unparseable. */
export function cursorCacheAgeSeconds(
  entry: Pick<CursorCacheEntry, 'fetchedAt'>,
  now = Date.now(),
): number {
  const fetchedAtMs = Date.parse(entry.fetchedAt);
  if (!isFiniteNumber(fetchedAtMs)) return Infinity;
  return (now - fetchedAtMs) / 1000;
}

/** A write failure is swallowed: the cache only ever speeds a command up. */
export function writeCursorCache(entry: CursorCacheEntry): void {
  if (environmentValue('AITRACK_NO_CACHE')) return;

  const payload = JSON.stringify({
    format: CACHE_FORMAT,
    appVersion: packageVersion(),
    timezone: machineTimezone(),
    fetchedAt: entry.fetchedAt,
    accountId: entry.accountId,
    csv: entry.csv,
    ...(entry.workingAuthShape !== undefined && { workingAuthShape: entry.workingAuthShape }),
  });
  try {
    writeFileAtomic(cachePath(), payload);
  } catch {}
}
