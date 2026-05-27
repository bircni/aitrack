import { describe, expect, it, vi } from 'vitest';
import { parseMachineFile, validateMachineFile } from './validate.js';

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
    const invalid = structuredClone(validMachine) as Record<string, unknown>;
    const days = invalid.days as Record<string, Record<string, Record<string, unknown>>>;
    const model = days['2026-01-15'].claude_code.byModel['claude-sonnet-4'] as Record<
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
