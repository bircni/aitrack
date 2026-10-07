import { describe, expect, it } from 'vitest';

import { checkMachineFile } from '../../../data/validate.js';
import { v2 } from '../v2.js';

const v1File = {
  hostname: 'laptop',
  lastUpdated: '2026-01-01T00:00:00.000Z',
  days: {
    '2026-01-15': {
      claude_code: {
        byModel: { 'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, costUSD: 1.25 } },
        totals: { inputTokens: 100, outputTokens: 50, costUSD: 1.25 },
      },
    },
  },
};

describe('v1 -> v2 migration', () => {
  it('stamps the version and marks the day keys as local-time', () => {
    const migrated = v2.migrate(structuredClone(v1File));
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      dayBucket: 'local',
      timezone: 'unknown',
      hostname: 'laptop',
    });
  });

  it('keeps a timezone the file already recorded', () => {
    const migrated = v2.migrate({ ...structuredClone(v1File), timezone: 'Europe/Berlin' });
    expect(migrated.timezone).toBe('Europe/Berlin');
  });

  it('leaves the day contents untouched so an unchanged file does not churn', () => {
    const migrated = v2.migrate(structuredClone(v1File));
    expect(migrated.days).toEqual(v1File.days);
  });

  it('produces a file that passes v2 validation', () => {
    const { machine, diagnostics } = checkMachineFile(structuredClone(v1File), 'data/laptop.json');
    expect(machine).not.toBeNull();
    expect(machine?.schemaVersion).toBe(2);
    expect(machine?.dayBucket).toBe('local');
    expect(diagnostics).toEqual([]);
  });
});
