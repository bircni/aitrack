/**
 * The on-disk schema version aitrack writes and expects after migration.
 *
 * A machine file without a `schemaVersion` is treated as version 1 (every file
 * written before 2.0). `src/store/migrations/` upgrades anything older than this
 * on read; `src/data/validate.ts` then validates against the current shape.
 */
export const CURRENT_SCHEMA_VERSION = 2;
