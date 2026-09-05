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

/**
 * Cache reads bill at a tenth of the base input rate. Holds for every Codex
 * model and every Claude model but Fable 5.1 / Mythos 5.1, which price their
 * own cache reads in `pricing/claude.ts`.
 */
export const CACHE_READ_RATE_MULTIPLIER = 0.1;
