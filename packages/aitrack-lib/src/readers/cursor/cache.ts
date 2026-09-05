import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isFiniteNumber, isRecord } from '../../data/guards.js';
import { environmentValue } from '../../env.js';
import { CACHE_DIR } from '../../paths.js';
import { packageVersion } from '../../version.js';

/**
 * Cursor usage is fetched live on every command that shows it. Caching the raw
 * CSV export lets `show` / `usage` / `top` reuse a recent pull
 * instead of making a network round-trip (and trying the whole credential-shape
 * sequence) every single run.
 *
 * The raw CSV is stored rather than the aggregated DayMap so `csv.ts` stays the
 * one parser and a pricing-table change re-aggregates from cache without the
 * network.
 */
const CACHE_FORMAT = 1;
const CACHE_FILE = 'cursor.json';

/** Default max age for a served cache entry, in seconds (6 hours). */
export const DEFAULT_CURSOR_CACHE_TTL_SECONDS = 21_600;

export interface CursorCacheEntry {
  fetchedAt: string;
  csv: string;
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
    // Costs are baked in when the CSV is aggregated, so a pricing/app change
    // must not serve stale dollars.
    parsed.appVersion !== packageVersion() ||
    typeof parsed.csv !== 'string' ||
    typeof parsed.fetchedAt !== 'string'
  ) {
    return null;
  }

  return {
    fetchedAt: parsed.fetchedAt,
    csv: parsed.csv,
    workingAuthShape:
      typeof parsed.workingAuthShape === 'string' ? parsed.workingAuthShape : undefined,
  };
}

/** Age of a cache entry in seconds, or Infinity when its timestamp is unparseable. */
export function cursorCacheAgeSeconds(entry: CursorCacheEntry, now = Date.now()): number {
  const fetchedAtMs = Date.parse(entry.fetchedAt);
  if (!isFiniteNumber(fetchedAtMs)) return Infinity;
  return (now - fetchedAtMs) / 1000;
}

/** Persist a freshly fetched CSV export. A write failure is swallowed — the
 * cache only ever speeds a command up. */
export function writeCursorCache(entry: CursorCacheEntry): void {
  if (environmentValue('AITRACK_NO_CACHE')) return;

  const payload = JSON.stringify({
    format: CACHE_FORMAT,
    appVersion: packageVersion(),
    fetchedAt: entry.fetchedAt,
    csv: entry.csv,
    ...(entry.workingAuthShape !== undefined && { workingAuthShape: entry.workingAuthShape }),
  });
  const target = cachePath();
  const temporaryPath = `${target}.${String(process.pid)}.tmp`;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(temporaryPath, payload, 'utf8');
    renameSync(temporaryPath, target);
  } catch {
    rmSync(temporaryPath, { force: true });
  }
}
