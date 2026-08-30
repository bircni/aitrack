import type { Migration } from './types.js';

/**
 * Stand-in for a machine file whose producing timezone was never recorded.
 * Deliberately not a valid IANA zone so it cannot be mistaken for one.
 */
export const UNKNOWN_TIMEZONE = 'unknown';

/**
 * Migration to schema v2. Named for the version it produces, so the chain reads
 * `v2`, `v3`, … and adding a step is an obvious new file.
 *
 * v1 files have no `schemaVersion` and bucket day keys in the writing machine's
 * local time with no record of which zone. This step stamps the version and
 * records `dayBucket: 'local'` — the keys cannot be re-bucketed without the
 * original timestamps, so the ambiguity is made explicit rather than hidden.
 *
 * `timezone` becomes `'unknown'`, not a real zone: the producing machine's zone
 * is unrecoverable after the fact, and writing a plausible-looking `'UTC'`
 * would be indistinguishable from a machine that genuinely ran in UTC and would
 * mislead any later normalization that trusts the field.
 *
 * Day contents are left untouched, so an already-synced file whose usage has
 * not changed still serialises to the same `days` and does not force a spurious
 * commit.
 */
export const v2: Migration = {
  from: 1,
  to: 2,
  describe: 'add schemaVersion and mark day keys as local-time',
  migrate(file) {
    return {
      ...file,
      schemaVersion: 2,
      timezone:
        typeof file.timezone === 'string' && file.timezone !== ''
          ? file.timezone
          : UNKNOWN_TIMEZONE,
      dayBucket: 'local',
    };
  },
};
