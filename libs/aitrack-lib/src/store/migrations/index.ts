import { CURRENT_SCHEMA_VERSION } from '../../data/schema.js';
import type { AppliedMigration, MigratableFile, Migration } from './types.js';
import { v2 } from './v2.js';

export type { Migration } from './types.js';
export { UNKNOWN_TIMEZONE } from './v2.js';

/**
 * Ordered migration chain. Each entry consumes `from` and produces `to`; the
 * runner walks them until the file reaches {@link CURRENT_SCHEMA_VERSION}.
 * Adding a 2→3 step later is one line here plus bumping the constant.
 */
export const MIGRATIONS: readonly Migration[] = [v2];

/** A file whose `schemaVersion` is newer than this build understands. */
export class SchemaFromTheFutureError extends Error {
  constructor(readonly version: number) {
    super(
      `machine file schemaVersion ${String(version)} is newer than this aitrack understands ` +
        `(supports up to ${String(CURRENT_SCHEMA_VERSION)}); upgrade aitrack`,
    );
    this.name = 'SchemaFromTheFutureError';
  }
}

function schemaVersionOf(file: MigratableFile): number {
  const raw = file.schemaVersion;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 1;
}

export interface MigrationResult {
  file: MigratableFile;
  applied: AppliedMigration[];
}

/**
 * Bring a parsed machine file up to the current schema version.
 *
 * A file already at the current version is returned by reference with an empty
 * `applied` list — that identity is what keeps an up-to-date file's git
 * round-trip byte-identical. Throws {@link SchemaFromTheFutureError} for a
 * newer version, and a plain error if the chain has a gap (a bug).
 */
export function applyMigrations(file: MigratableFile): MigrationResult {
  let version = schemaVersionOf(file);
  if (version === CURRENT_SCHEMA_VERSION) return { file, applied: [] };
  if (version > CURRENT_SCHEMA_VERSION) throw new SchemaFromTheFutureError(version);

  let current = file;
  const applied: AppliedMigration[] = [];
  while (version < CURRENT_SCHEMA_VERSION) {
    const from = version;
    const step = MIGRATIONS.find((migration) => migration.from === from);
    if (!step) {
      throw new Error(`no migration registered from schema version ${String(from)}`);
    }
    current = step.migrate(current);
    applied.push({ from: step.from, to: step.to, describe: step.describe });
    version = step.to;
  }
  return { file: current, applied };
}
