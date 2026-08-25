import { describe, expect, it } from 'vitest';

import { findDuplicateMachineDays } from '../duplicateMachines.js';
import type { MachineFile } from '../types.js';

function machine(hostname: string, days: MachineFile['days']): MachineFile {
  return { hostname, lastUpdated: '2026-01-16T00:00:00.000Z', days };
}

const day = {
  claude_code: {
    byModel: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 5 } },
    totals: { inputTokens: 10, outputTokens: 5 },
  },
};

const otherDay = {
  claude_code: {
    byModel: { 'claude-sonnet-5': { inputTokens: 99, outputTokens: 1 } },
    totals: { inputTokens: 99, outputTokens: 1 },
  },
};

describe('findDuplicateMachineDays', () => {
  it('finds a day recorded identically under two machines', () => {
    // The same machine synced under two ids doubles every total it holds.
    const result = findDuplicateMachineDays([
      machine('laptop', { '2026-01-15': day }),
      machine('laptop.local', { '2026-01-15': day }),
    ]);

    expect(result.days).toEqual(['2026-01-15']);
    expect(result.machines).toEqual(['laptop', 'laptop.local']);
  });

  it('ignores the same day when the numbers differ', () => {
    // Two machines genuinely used on one day are not duplicates.
    const result = findDuplicateMachineDays([
      machine('laptop', { '2026-01-15': day }),
      machine('desktop', { '2026-01-15': otherDay }),
    ]);

    expect(result.days).toEqual([]);
    expect(result.machines).toEqual([]);
  });

  it('reports nothing for a single machine or no machines', () => {
    expect(findDuplicateMachineDays([]).days).toEqual([]);
    expect(findDuplicateMachineDays([machine('solo', { '2026-01-15': day })]).days).toEqual([]);
  });

  it('sorts days and machines so the warning reads the same every run', () => {
    const result = findDuplicateMachineDays([
      machine('zeta', { '2026-02-02': day, '2026-01-15': day }),
      machine('alpha', { '2026-02-02': day, '2026-01-15': day }),
    ]);

    expect(result.days).toEqual(['2026-01-15', '2026-02-02']);
    expect(result.machines).toEqual(['alpha', 'zeta']);
  });
});
