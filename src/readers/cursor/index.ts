import type { DayMap } from '../../data/types.js';
import { errorMessage } from '../../errors.js';
import { log } from '../../output.js';
import { fetchCursorUsageCsv, getCursorStateDatabasePath, readCursorAuthState } from './auth.js';
import { cursorCacheAgeSeconds, readCursorCache, writeCursorCache } from './cache.js';
import { aggregateCursorCsvToDayMap } from './csv.js';

export { getCursorStateDatabasePath } from './auth.js';
export { aggregateCursorCsvToDayMap, parseCursorDateString } from './csv.js';

export interface ReadCursorDataOptions {
  /**
   * Serve a cached CSV export up to this many seconds old without a network
   * round-trip. `0` forces a refresh; omitted also forces a refresh (a caller
   * that wants caching opts in with an explicit age).
   */
  maxAgeSeconds?: number;
}

/**
 * Load Cursor usage from the local IDE auth DB + dashboard CSV export.
 *
 * Returns an empty map if the DB is missing, there is no access token, or the
 * request fails with no cache to fall back on. A fresh-enough cached CSV is
 * served without touching the database or the network; a failed refresh falls
 * back to a stale cache when one exists.
 */
export async function readCursorData(options: ReadCursorDataOptions = {}): Promise<DayMap> {
  const cached = readCursorCache();
  const { maxAgeSeconds } = options;

  if (cached && maxAgeSeconds !== undefined && cursorCacheAgeSeconds(cached) <= maxAgeSeconds) {
    return aggregateCursorCsvToDayMap(cached.csv);
  }

  const databasePath = getCursorStateDatabasePath();
  if (!databasePath) {
    return cached ? aggregateCursorCsvToDayMap(cached.csv) : new Map();
  }

  let authState: Awaited<ReturnType<typeof readCursorAuthState>>;
  try {
    authState = await readCursorAuthState(databasePath);
  } catch (error) {
    log.warn(`aitrack: Cursor skipped — could not read ${databasePath}: ${errorMessage(error)}`);
    return cached ? aggregateCursorCsvToDayMap(cached.csv) : new Map();
  }

  if (!authState.accessToken) {
    log.warn('aitrack: Cursor skipped — no cursorAuth/accessToken in state.vscdb.');
    return cached ? aggregateCursorCsvToDayMap(cached.csv) : new Map();
  }

  // Reading the body is part of the request: the stream can still fail after a
  // 200, and an escaping rejection would take down the whole usage run rather
  // than degrading like every other Cursor failure here.
  let text: string;
  let shape: string;
  try {
    const result = await fetchCursorUsageCsv(authState.accessToken, cached?.workingAuthShape);
    text = await result.response.text();
    shape = result.shape;
  } catch (error) {
    if (cached) {
      log.warn(
        `aitrack: Cursor — using cached export from ${cached.fetchedAt} (refresh failed: ${errorMessage(error)}).`,
      );
      return aggregateCursorCsvToDayMap(cached.csv);
    }
    log.warn(`aitrack: Cursor skipped — ${errorMessage(error)}`);
    return new Map();
  }

  const map = aggregateCursorCsvToDayMap(text);
  if (map.size === 0) {
    // A 200 carrying no usable rows — an interstitial page, a renamed column, a
    // momentary backend hiccup. Caching it would hide Cursor for the whole TTL
    // and suppress the retry that fixes it, so keep whatever cache we have and
    // let the next command fetch again.
    log.warn('aitrack: Cursor — no usage rows in CSV export.');
    return cached ? aggregateCursorCsvToDayMap(cached.csv) : map;
  }

  writeCursorCache({ fetchedAt: new Date().toISOString(), csv: text, workingAuthShape: shape });
  return map;
}
