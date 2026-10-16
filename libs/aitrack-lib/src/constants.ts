import type { TokenCounts } from './data/types.js';

/** Calendar-day key format used for every date in the data files. */
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function isDayKey(value: string): boolean {
  if (!DAY_KEY_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`); // rolls 02-30 over to March, hence the round trip
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
}

/**
 * Cache reads bill at a tenth of the base input rate. Holds for every Codex
 * model and every Claude model but Fable 5.1 / Mythos 5.1, which price their
 * own cache reads in `pricing/tables/claude.json`.
 */
export const CACHE_READ_RATE_MULTIPLIER = 0.1;

/** The optional split of `inputTokens`, in the key order machine files are written with. */
export const TOKEN_BREAKDOWN_FIELDS = [
  'rawInputTokens',
  'cachedInputTokens',
  'cacheCreationInputTokens',
  'cacheCreation1hInputTokens',
] as const satisfies ReadonlyArray<keyof TokenCounts>;

export const OPTIONAL_TOKEN_NUMBER_FIELDS = [...TOKEN_BREAKDOWN_FIELDS, 'costUSD'] as const;
