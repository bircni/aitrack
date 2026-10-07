import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../../data/schema.js';
import { applyMigrations, MIGRATIONS, SchemaFromTheFutureError } from '../index.js';

describe('applyMigrations', () => {
  it('returns a current-version file by reference', () => {
    const file = { schemaVersion: CURRENT_SCHEMA_VERSION, hostname: 'a', days: {} };
    expect(applyMigrations(file)).toBe(file);
  });

  it('treats a missing schemaVersion as version 1 and migrates it', () => {
    expect(applyMigrations({ hostname: 'a', days: {} }).schemaVersion).toBe(2);
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
