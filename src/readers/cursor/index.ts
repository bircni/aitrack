import type { DayMap } from '../../data/types.js';
import {
  errorMessage,
  fetchCursorUsageCsv,
  getCursorStateDbPath as getCursorStateDatabasePath,
  readCursorAuthState,
} from './auth.js';
import { aggregateCursorCsvToDayMap } from './csv.js';

export { getCursorStateDbPath } from './auth.js';
export { aggregateCursorCsvToDayMap, parseCursorDateString } from './csv.js';

/**
 * Load Cursor usage from the local IDE auth DB + dashboard CSV export.
 * Returns an empty map if the DB is missing, there is no access token, or the request fails.
 */
export async function readCursorData(): Promise<DayMap> {
  const databasePath = getCursorStateDatabasePath();
  if (!databasePath) {
    return new Map();
  }

  let authState: Awaited<ReturnType<typeof readCursorAuthState>>;
  try {
    authState = await readCursorAuthState(databasePath);
  } catch (error) {
    console.warn(
      `aitrack: Cursor skipped — could not read ${databasePath}: ${errorMessage(error)}`,
    );
    return new Map();
  }

  if (!authState.accessToken) {
    console.warn('aitrack: Cursor skipped — no cursorAuth/accessToken in state.vscdb.');
    return new Map();
  }

  let response: Response;
  try {
    response = await fetchCursorUsageCsv(authState.accessToken);
  } catch (error) {
    console.warn(`aitrack: Cursor skipped — ${errorMessage(error)}`);
    return new Map();
  }

  const text = await response.text();
  const map = aggregateCursorCsvToDayMap(text);
  if (map.size === 0) {
    console.warn('aitrack: Cursor — no usage rows in CSV export.');
  }
  return map;
}
