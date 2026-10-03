import { describe, expect, it } from 'vitest';

import { supplementFromTables, type PricingTables } from '../supplementFromTables.js';

function sourceTables(): PricingTables {
  const baseline = supplementFromTables();
  return {
    claude: { ...baseline.claude, updatedAt: '2026-01-01' },
    codex: { ...baseline.codex, updatedAt: '2026-02-01T12:00:00Z' },
    cursor: { ...baseline.cursor, updatedAt: '2026-01-15' },
  };
}

describe('supplementFromTables', () => {
  it('uses the newest table timestamp, including time-of-day', () => {
    expect(supplementFromTables(sourceTables()).updatedAt).toBe('2026-02-01T12:00:00.000Z');
  });

  it('uses supplied table data after changes instead of imported JSON snapshots', () => {
    const tables = sourceTables();
    tables.codex.current['gpt-5.6-sol'] = { inputPerMillion: 8, outputPerMillion: 40 };
    const supplement = supplementFromTables(tables);
    expect(supplement.codex.current['gpt-5.6-sol']?.inputPerMillion).toBe(8);
    expect(supplementFromTables().codex.current['gpt-5.6-sol']?.inputPerMillion).toBe(4);
  });

  it('isolates models, overrides, fallbacks, and aliases from source mutations', () => {
    const tables = sourceTables();
    const before = structuredClone(tables);
    const supplement = supplementFromTables(tables);
    supplement.claude.models['test-model'] = {
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 0.1,
      cacheCreatePerMillion: 1.25,
    };
    supplement.claude.overrides['test-model'] = [];
    supplement.claude.familyFallback.sonnet.inputPerMillion = 99;
    supplement.codex.familyFallback.length = 0;
    supplement.codex.historical['test-model'] = { inputPerMillion: 1, outputPerMillion: 2 };
    supplement.cursor.aliases.push({ pattern: 'test', canonical: 'test-model' });
    supplement.cursor.fastMultipliers['test-model'] = 4;
    expect(tables).toEqual(before);
  });
});
