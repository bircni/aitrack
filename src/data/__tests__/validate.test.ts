import { describe, expect, it, vi } from 'vitest';

import { parseMachineFile, validateMachineFile } from '../validate.js';

const validMachine = {
  hostname: 'laptop',
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
    // otherwise print this on every command and every daemon refresh tick.
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

  it('warns and returns null for invalid cache breakdown fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid = structuredClone(validMachine);
    const model = invalid.days['2026-01-15'].claude_code.byModel['claude-sonnet-4'] as Record<
      string,
      unknown
    >;
    model.rawInputTokens = 'nope';
    const result = validateMachineFile(invalid, 'data/bad.json');
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('days.2026-01-15.claude_code.byModel.claude-sonnet-4.rawInputTokens'),
    );
    warn.mockRestore();
  });

  it('warns and returns null for missing hostname', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = validateMachineFile({ ...validMachine, hostname: '' }, 'data/bad.json');
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('data/bad.json'));
    warn.mockRestore();
  });

  it('warns and returns null for invalid provider totals', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid = structuredClone(validMachine);
    invalid.days['2026-01-15'].claude_code.totals.inputTokens = 'nope' as unknown as number;
    const result = validateMachineFile(invalid, 'data/bad.json');
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('days.2026-01-15.claude_code.totals.inputTokens'),
    );
    warn.mockRestore();
  });

  it('rejects provider totals that do not equal the by-model token sum', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid = structuredClone(validMachine);
    invalid.days['2026-01-15'].claude_code.totals.inputTokens = 101;

    expect(validateMachineFile(invalid, 'data/bad.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('totals.inputTokens must equal the sum of byModel.inputTokens'),
    );
    warn.mockRestore();
  });

  it('rejects cache-breakdown totals that do not equal the by-model sum', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid = structuredClone(validMachine);
    const provider = invalid.days['2026-01-15'].claude_code;
    (provider.totals as Record<string, unknown>).cachedInputTokens = 10;
    (provider.byModel['claude-sonnet-4'] as Record<string, unknown>).cachedInputTokens = 9;

    expect(validateMachineFile(invalid, 'data/bad.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'totals.cachedInputTokens must equal the sum of byModel.cachedInputTokens',
      ),
    );
    warn.mockRestore();
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

  it('warns and returns null when root is not an object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(validateMachineFile(null, 'data/bad.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('root must be an object'));
    warn.mockRestore();
  });

  it('warns and returns null when lastUpdated is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid = { ...validMachine, lastUpdated: '' };
    expect(validateMachineFile(invalid, 'data/bad.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lastUpdated'));
    warn.mockRestore();
  });

  it('warns and returns null when days is not an object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid = { ...validMachine, days: [] };
    expect(validateMachineFile(invalid, 'data/bad.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('days must be an object'));
    warn.mockRestore();
  });

  it('warns and returns null when a day entry is not an object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid = { ...validMachine, days: { '2026-01-15': 'nope' } };
    expect(validateMachineFile(invalid, 'data/bad.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('days.2026-01-15'));
    warn.mockRestore();
  });

  it('warns and returns null when byModel is not an object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid = structuredClone(validMachine);
    const provider = invalid.days['2026-01-15'].claude_code as { byModel: unknown };
    provider.byModel = [];
    expect(validateMachineFile(invalid, 'data/bad.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('byModel must be an object'));
    warn.mockRestore();
  });

  it('warns and returns null for invalid cachedInputTokens on totals', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid = structuredClone(validMachine);
    (invalid.days['2026-01-15'].claude_code.totals as Record<string, unknown>).cachedInputTokens =
      'bad';
    expect(validateMachineFile(invalid, 'data/bad.json')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('days.2026-01-15.claude_code.totals.cachedInputTokens'),
    );
    warn.mockRestore();
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
