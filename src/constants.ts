/**
 * Values that more than one layer has to agree on.
 *
 * Each of these was previously restated in three places; a change to one copy
 * that missed the others produced a validator and a parser that disagreed about
 * what the same input meant.
 */

/** Calendar-day key format used for every date in the data files. */
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function isDayKey(value: string): boolean {
  return DAY_KEY_PATTERN.test(value);
}

/** Highest bindable TCP port. */
export const MAX_PORT = 65_535;

/** Cache reads bill at a tenth of the base input rate for every provider. */
export const CACHE_READ_RATE_MULTIPLIER = 0.1;
