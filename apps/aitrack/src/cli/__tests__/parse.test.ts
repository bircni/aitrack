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

  it('defaults the usage report period to month', () => {
    expect(parseUsageReportOptions({})).toEqual({ period: 'month' });
    expect(() => parseUsageReportOptions({ period: 'decade' })).toThrow('Invalid period');
  });
});
