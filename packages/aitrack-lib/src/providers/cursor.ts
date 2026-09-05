import type { CheckResult } from '../display/checkResult.js';
import { errorMessage } from '../errors.js';
import { getCursorStateDatabasePath, readCursorAuthState } from '../readers/cursor/auth.js';
import { cursorCacheTtlSeconds } from '../readers/cursor/cache.js';
import { readCursorData } from '../readers/cursor/index.js';
import type { LiveProvider } from './types.js';

async function cursorCheck(): Promise<CheckResult> {
  const stateDb = getCursorStateDatabasePath();
  if (!stateDb) {
    return {
      status: 'warn',
      label: 'Cursor source',
      detail: 'state.vscdb not found; Cursor usage will be skipped unless configured',
    };
  }

  try {
    const auth = await readCursorAuthState(stateDb);
    return auth.accessToken
      ? { status: 'ok', label: 'Cursor source', detail: `auth token found in ${stateDb}` }
      : {
          status: 'warn',
          label: 'Cursor source',
          detail: `state DB found but no access token was present: ${stateDb}`,
        };
  } catch (error) {
    return { status: 'warn', label: 'Cursor source', detail: errorMessage(error) };
  }
}

export const cursorProvider: LiveProvider = {
  descriptor: {
    key: 'cursor',
    label: 'Cursor',
    aliases: ['cursor'],
    synced: false,
    costLabel: 'Cost',
  },
  heatmap: {
    light: ['#ebedf0', '#fde8c8', '#f8a855', '#e56b10', '#8b2e00'],
    dark: ['#1e1e24', '#3a1800', '#7a3200', '#c45a00', '#f08820'],
  },
  pricing: {
    // Cursor rows are priced when the CSV is aggregated (a costUSD is baked into
    // the DayMap right there), so nothing routes a Cursor model through here.
    modelCount: 0,
    priceModelCost: () => undefined,
  },
  live: {
    // A caller that passes no age gets Cursor's own TTL; `0` still forces a
    // refresh (`0 ?? x` is `0`).
    liveFetch: (options) =>
      readCursorData({ maxAgeSeconds: options?.maxAgeSeconds ?? cursorCacheTtlSeconds() }),
  },
  doctorCheck: cursorCheck,
};
