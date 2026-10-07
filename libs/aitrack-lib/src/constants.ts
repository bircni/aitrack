/** Values that more than one layer has to agree on. */

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
