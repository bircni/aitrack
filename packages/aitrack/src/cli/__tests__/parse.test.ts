import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';

import {
  invalidDateMessage,
  isValidDateString,
  parseIntArgument,
  parsePositiveInt,
  parsePositiveIntArgument,
  parseProviders,
  parseTopKind,
  parseTopLimit,
  parseTopSort,
  parseUsageReportOptions,
} from '../parse.js';

describe('cli parse helpers', () => {
  it('validates YYYY-MM-DD date strings', () => {
    expect(isValidDateString('2024-06-01')).toBe(true);
    expect(isValidDateString('2024-6-01')).toBe(false);
    expect(isValidDateString('not-a-date')).toBe(false);
    expect(invalidDateMessage('bad')).toBe('Invalid date: "bad". Expected YYYY-MM-DD.');
  });

  it('parses integer CLI arguments', () => {
    expect(parseIntArgument('42')).toBe(42);
    expect(() => parseIntArgument('nope')).toThrow('Expected an integer, got: nope');
    expect(() => parseIntArgument('nope')).toThrow(InvalidArgumentError);
    expect(() => parseIntArgument('123abc')).toThrow('Expected an integer, got: 123abc');
    expect(() => parseIntArgument('1.5')).toThrow('Expected an integer, got: 1.5');
    expect(parsePositiveIntArgument('42')).toBe(42);
    expect(() => parsePositiveIntArgument('0')).toThrow('Expected a positive integer');
    expect(() => parsePositiveIntArgument('-1')).toThrow(InvalidArgumentError);
  });

  it('parses positive integers for usage last N', () => {
    expect(parsePositiveInt('14')).toBe(14);
    expect(parsePositiveInt('0')).toBeUndefined();
    expect(parsePositiveInt('1.5')).toBeUndefined();
    expect(() => parseUsageReportOptions({ period: 'last', args: ['0'] })).toThrow(
      'positive integer',
    );
  });

  it('parses and validates top kind, sort, and limit', () => {
    expect(parseTopKind(undefined)).toBe('days');
    expect(parseTopKind('models')).toBe('models');
    expect(() => parseTopKind('weeks')).toThrow('days" or "models');
    expect(parseTopSort('cost')).toBe('cost');
    expect(() => parseTopSort('price')).toThrow('tokens" or "cost');
    expect(parseTopLimit(5)).toBe(5);
    expect(() => parseTopLimit(0)).toThrow('positive integer');
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
    expect(() => parseUsageReportOptions({ period: 'month', args: ['extra'] })).toThrow(
      'does not accept extra arguments',
    );
    expect(() =>
      parseUsageReportOptions({ period: 'range', args: ['2026-06-02', '2026-06-01'] }),
    ).toThrow('must not be after');
  });
});
