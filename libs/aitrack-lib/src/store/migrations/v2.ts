import { UNKNOWN_TIMEZONE } from '../../timezone.js';
import type { Migration } from './types.js';

/**
 * v1 files have no `schemaVersion` and local-time day keys with no record of
 * the zone; the keys cannot be re-bucketed, so `dayBucket: 'local'` makes that
 * explicit. A missing zone becomes `'unknown'`, not `'UTC'`, so it cannot pass
 * for a machine that really ran in UTC. Days stay untouched to avoid commit churn.
 */
export const v2: Migration = {
  from: 1,
  to: 2,
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
