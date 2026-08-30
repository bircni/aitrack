/** A JSON object being migrated between schema versions. */
export type MigratableFile = Record<string, unknown>;

/**
 * One step in the migration chain. Steps compose on `from`/`to`: a file three
 * versions behind runs each step in order with no special-casing.
 */
export interface Migration {
  /** Schema version this step consumes. */
  from: number;
  /** Schema version it produces. */
  to: number;
  /** One line, shown to the user when a file is migrated. */
  describe: string;
  migrate: (file: MigratableFile) => MigratableFile;
}

export interface AppliedMigration {
  from: number;
  to: number;
  describe: string;
}
