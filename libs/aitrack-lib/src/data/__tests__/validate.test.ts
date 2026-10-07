import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMachineFileDiagnostics } from '../diagnostics.js';
import {
  checkMachineFile,
  checkRawMachineFile,
  parseMachineFile,
  validateMachineFile,
} from '../validate.js';

const validMachine = {
  schemaVersion: 2,
  hostname: 'laptop',
  timezone: 'UTC',
  dayBucket: 'utc',
  lastUpdated: '2026-01-01T00:00:00.000Z',
  days: {
    '2026-01-15': {
      claude_code: {
        totals: { inputTokens: 100, outputTokens: 50, costUSD: 1.25 },
        byModel: {
          'claude-sonnet-4': { inputTokens: 100, outputTokens: 50, costUSD: 1.25 },
        },
      },
    },
  },
};

interface MutableProvider {
  totals: Record<string, unknown>;
  byModel: Record<string, Record<string, unknown>>;
}

function withProvider(edit: (provider: MutableProvider) => void): unknown {
  const copy = structuredClone(validMachine);
  edit(copy.days['2026-01-15'].claude_code);
  return copy;
}

beforeEach(() => {
  resetMachineFileDiagnostics(); // the reporter remembers warned files across tests
});

describe('validateMachineFile', () => {
  it('accepts a valid machine file', () => {
    expect(validateMachineFile(validMachine, 'data/laptop.json')).toEqual(validMachine);
  });

  it('drops a day whose key is not a date and keeps the rest of the file', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const withGarbageDay = {
      ...validMachine,
      days: { 'NaN-NaN-NaN': validMachine.days['2026-01-15'], ...validMachine.days },
    };

    const result = validateMachineFile(withGarbageDay, 'data/laptop.json');

    expect(Object.keys(result?.days ?? {})).toEqual(['2026-01-15']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NaN-NaN-NaN'));
    warn.mockRestore();
  });

  it('warns about bad day keys once per file', () => {
    // Only the current machine self-heals, so another machine's file would
    // otherwise print this on every single command.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const withGarbageDay = {
      ...validMachine,
      days: { 'NaN-NaN-NaN': validMachine.days['2026-01-15'], ...validMachine.days },
    };

    validateMachineFile(withGarbageDay, 'data/other-laptop.json');
    validateMachineFile(withGarbageDay, 'data/other-laptop.json');

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('accepts Claude cache breakdown fields on token counts', () => {
    const withBreakdown = {
      ...validMachine,
      days: {
        '2026-01-15': {
          claude_code: {
            totals: {
              inputTokens: 160,
              outputTokens: 50,
              rawInputTokens: 100,
              cachedInputTokens: 50,
              cacheCreationInputTokens: 10,
              costUSD: 1.25,
            },
            byModel: {
              'claude-sonnet-4': {
                inputTokens: 160,
                outputTokens: 50,
                rawInputTokens: 100,
                cachedInputTokens: 50,
                cacheCreationInputTokens: 10,
                costUSD: 1.25,
              },
            },
          },
        },
      },
    };
    expect(validateMachineFile(withBreakdown, 'data/laptop.json')).toEqual(withBreakdown);
  });

  it('rejects a stale aggregate cost but lets recompute load it for repair', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stale = structuredClone(validMachine);
    stale.days['2026-01-15'].claude_code.totals.costUSD = 99;

    expect(validateMachineFile(stale, 'data/stale.json')).toBeNull();
    expect(
      validateMachineFile(stale, 'data/stale.json', { allowInconsistentCostTotals: true }),
    ).toEqual(stale);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('totals.costUSD must equal the sum of byModel.costUSD'),
    );
    warn.mockRestore();
  });

  it('accepts a legacy aggregate cost when by-model costs are absent', () => {
    const legacy = structuredClone(validMachine);
    delete (
      legacy.days['2026-01-15'].claude_code.byModel['claude-sonnet-4'] as {
        costUSD?: number;
      }
    ).costUSD;

    expect(validateMachineFile(legacy, 'data/legacy.json')).toEqual(legacy);
  });

  it.each<[string, () => unknown, string]>([
    ['root is not an object', () => null, 'root must be an object'],
    ['hostname is missing', () => ({ ...validMachine, hostname: '' }), 'hostname'],
    ['lastUpdated is missing', () => ({ ...validMachine, lastUpdated: '' }), 'lastUpdated'],
    ['days is not an object', () => ({ ...validMachine, days: [] }), 'days must be an object'],
    [
      'a day entry is not an object',
      () => ({ ...validMachine, days: { '2026-01-15': 'nope' } }),
      'days.2026-01-15 must be an object',
    ],
    [
      'byModel is not an object',
      () =>
        withProvider((provider) => {
          Object.assign(provider, { byModel: [] });
        }),
      'byModel must be an object',
    ],
    [
      'a total is not a number',
      () =>
        withProvider((provider) => {
          provider.totals.inputTokens = 'nope';
        }),
      'days.2026-01-15.claude_code.totals.inputTokens',
    ],
    [
      'a cache total is not a number',
      () =>
        withProvider((provider) => {
          provider.totals.cachedInputTokens = 'bad';
        }),
      'days.2026-01-15.claude_code.totals.cachedInputTokens',
    ],
    [
      'a model breakdown field is not a number',
      () =>
        withProvider((provider) => {
          Object.assign(provider.byModel['claude-sonnet-4'] ?? {}, { rawInputTokens: 'nope' });
        }),
      'days.2026-01-15.claude_code.byModel.claude-sonnet-4.rawInputTokens',
    ],
    [
      'totals disagree with the by-model token sum',
      () =>
        withProvider((provider) => {
          provider.totals.inputTokens = 101;
        }),
      'totals.inputTokens must equal the sum of byModel.inputTokens',
    ],
    [
      'cache totals disagree with the by-model sum',
      () =>
        withProvider((provider) => {
          provider.totals.cachedInputTokens = 10;
          Object.assign(provider.byModel['claude-sonnet-4'] ?? {}, { cachedInputTokens: 9 });
        }),
      'totals.cachedInputTokens must equal the sum of byModel.cachedInputTokens',
    ],
  ])('warns and returns null when %s', (_, build, message) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(validateMachineFile(build(), 'data/bad.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(message));
    warn.mockRestore();
  });
});

describe('checkMachineFile', () => {
  it('returns findings instead of printing them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const checked = checkMachineFile({ hostname: '' }, 'data/bad.json');

    expect(checked.machine).toBeNull();
    expect(checked.diagnostics).toEqual([
      {
        kind: 'file-skipped',
        filePath: 'data/bad.json',
        reason: 'hostname must be a non-empty string',
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports a dropped day every time, leaving de-duplication to the reporter', () => {
    const withGarbageDay = {
      ...validMachine,
      days: { 'NaN-NaN-NaN': validMachine.days['2026-01-15'], ...validMachine.days },
    };

    for (const _ of [0, 1]) {
      const checked = checkMachineFile(withGarbageDay, 'data/laptop.json');
      expect(checked.diagnostics).toEqual([
        {
          kind: 'day-dropped',
          filePath: 'data/laptop.json',
          date: 'NaN-NaN-NaN',
          reason: 'not a YYYY-MM-DD date',
        },
      ]);
      expect(Object.keys(checked.machine?.days ?? {})).toEqual(['2026-01-15']);
    }
  });

  it('keeps the objects it was given, so a round-trip is byte-identical', () => {
    // sync writes back what it read; rebuilding these would reorder keys and
    // produce a spurious diff on every already-up-to-date machine.
    const raw = JSON.stringify(validMachine);
    const checked = checkRawMachineFile(raw, 'data/laptop.json');
    expect(JSON.stringify(checked.machine)).toBe(raw);
  });

  it('reports malformed JSON as a skipped file', () => {
    const checked = checkRawMachineFile('{not json', 'data/broken.json');
    expect(checked.machine).toBeNull();
    const [diagnostic] = checked.diagnostics;
    expect(diagnostic?.kind).toBe('file-skipped');
    expect(diagnostic && 'reason' in diagnostic ? diagnostic.reason : '').toContain('invalid JSON');
  });
});

describe('parseMachineFile', () => {
  it('parses valid JSON', () => {
    expect(parseMachineFile(JSON.stringify(validMachine), 'data/laptop.json')).toEqual(
      validMachine,
    );
  });

  it('warns and returns null for malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseMachineFile('{not json', 'data/broken.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
    warn.mockRestore();
  });
});

describe('schema migration on read', () => {
  const v1 = {
    hostname: 'laptop',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    days: {
      '2026-01-15': {
        codex: {
          byModel: { 'gpt-5': { inputTokens: 10, outputTokens: 5 } },
          totals: { inputTokens: 10, outputTokens: 5 },
        },
      },
    },
  };

  it('auto-migrates a v1 file without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const machine = parseMachineFile(JSON.stringify(v1), 'data/laptop.json');
    expect(machine?.schemaVersion).toBe(2);
    expect(machine?.dayBucket).toBe('local');
    expect(machine?.days['2026-01-15']?.codex?.totals.inputTokens).toBe(10);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips a file whose schemaVersion is from the future', () => {
    const checked = checkRawMachineFile(
      JSON.stringify({ ...validMachine, schemaVersion: 999 }),
      'data/laptop.json',
    );
    expect(checked.machine).toBeNull();
    expect(checked.diagnostics[0]?.kind).toBe('file-skipped');
  });

  it('tolerates an unusable header field instead of dropping the machine', () => {
    const checked = checkRawMachineFile(
      JSON.stringify({ ...validMachine, dayBucket: 'sideways', timezone: '' }),
      'data/laptop.json',
    );
    expect(checked.machine?.dayBucket).toBe('local');
    expect(checked.machine?.timezone).toBe('unknown');
    expect(checked.machine?.days).toEqual(validMachine.days);
    expect(checked.diagnostics).toEqual([]);
  });
});
