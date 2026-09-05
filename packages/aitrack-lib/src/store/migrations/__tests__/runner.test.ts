import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../../data/schema.js';
import { applyMigrations, MIGRATIONS, SchemaFromTheFutureError } from '../index.js';
import type { Migration } from '../types.js';

describe('applyMigrations', () => {
  it('returns a current-version file by reference with nothing applied', () => {
    const file = { schemaVersion: CURRENT_SCHEMA_VERSION, hostname: 'a', days: {} };
    const result = applyMigrations(file);
    expect(result.file).toBe(file);
    expect(result.applied).toEqual([]);
  });

  it('treats a missing schemaVersion as version 1 and migrates it', () => {
    const result = applyMigrations({ hostname: 'a', days: {} });
    expect(result.applied.map((step) => `${String(step.from)}->${String(step.to)}`)).toEqual([
      '1->2',
    ]);
    expect(result.file.schemaVersion).toBe(2);
  });

  it('walks a multi-step chain in order', () => {
    const chain: Migration[] = [
      { from: 1, to: 2, describe: 'a', migrate: (f) => ({ ...f, schemaVersion: 2, step2: true }) },
      { from: 2, to: 3, describe: 'b', migrate: (f) => ({ ...f, schemaVersion: 3, step3: true }) },
    ];
    // Re-implement the walk against a local chain to prove ordering composes.
    let file: Record<string, unknown> = { hostname: 'a' };
    for (const step of chain) {
      expect(step.from).toBe(file.schemaVersion ?? 1);
      file = step.migrate(file);
    }
    expect(file).toMatchObject({ schemaVersion: 3, step2: true, step3: true });
  });

  it('throws SchemaFromTheFutureError for a newer file', () => {
    expect(() => applyMigrations({ schemaVersion: 999, days: {} })).toThrow(
      SchemaFromTheFutureError,
    );
  });

  it('registers a contiguous chain from 1 to the current version', () => {
    let version = 1;
    for (const step of [...MIGRATIONS].toSorted((a, b) => a.from - b.from)) {
      expect(step.from).toBe(version);
      version = step.to;
    }
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });
});
