import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';

import {
  parseDateOption,
  parsePositiveIntArgument,
  parseProviders,
  parseUsageReportOptions,
  parseYearArgument,
} from '../parse.js';

describe('cli parse helpers', () => {
  it('validates YYYY-MM-DD date options', () => {
    expect(parseDateOption('2024-06-01')).toBe('2024-06-01');
    expect(() => parseDateOption('2024-6-01')).toThrow(InvalidArgumentError);
    expect(() => parseDateOption('bad')).toThrow('Invalid date: "bad". Expected YYYY-MM-DD.');
  });

  it('parses integer CLI arguments', () => {
    expect(parsePositiveIntArgument('42')).toBe(42);
    expect(() => parsePositiveIntArgument('nope')).toThrow(
      'Expected a positive integer, got: nope',
    );
    expect(() => parsePositiveIntArgument('1.5')).toThrow(InvalidArgumentError);
    expect(() => parsePositiveIntArgument('0')).toThrow('Expected a positive integer');
    expect(() => parsePositiveIntArgument('-1')).toThrow(InvalidArgumentError);
    expect(() => parseYearArgument('10000')).toThrow('Expected a year up to 9999, got: 10000');
  });

  it('parses the --providers list into canonical keys', () => {
    expect(parseProviders('claude,codex')).toEqual(['claude_code', 'codex']);
    expect(parseProviders('CURSOR')).toEqual(['cursor']);
    expect(parseProviders('claude_code, claude , cursor')).toEqual(['claude_code', 'cursor']);
    expect(() => parseProviders('gemini')).toThrow('Invalid provider: "gemini"');
    expect(() => parseProviders(' , ')).toThrow('No valid providers given');
  });

  it('parses usage report options from period and args', () => {
    expect(parseUsageReportOptions({ period: 'month' })).toEqual({ period: 'month' });
    expect(parseUsageReportOptions({ period: 'date', args: ['2026-06-01'] })).toEqual({
      period: 'date',
      from: '2026-06-01',
    });
    expect(
      parseUsageReportOptions({ period: 'range', args: ['2026-06-01', '2026-06-02'] }),
    ).toEqual({
      period: 'range',
      from: '2026-06-01',
      to: '2026-06-02',
    });
    expect(parseUsageReportOptions({ period: 'last', args: ['14'] })).toEqual({
      period: 'last',
      n: 14,
    });
  });
});
