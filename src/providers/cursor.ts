import type { CheckResult } from '../display/checkResult.js';
import { errorMessage } from '../errors.js';
import { getCursorStateDatabasePath, readCursorAuthState } from '../readers/cursor/auth.js';
import { readCursorData } from '../readers/cursor/index.js';
import type { Provider } from './types.js';

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

export const cursorProvider: Provider = {
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
    // maxAgeSeconds is honoured once PR2 lands the CSV cache; today every call
    // is a live fetch, exactly as before.
    liveFetch: () => readCursorData(),
  },
  doctorCheck: cursorCheck,
};
