import { describe, expect, it } from 'vitest';

import {
  cliErrorMessage,
  dateRangeValidationError,
  invalidDateMessage,
  isValidDateString,
  parseIntArg as parseIntArgument,
  parsePositiveInt,
  parseTopKind,
  topKindValidationError,
  topLimitValidationError,
  topSortValidationError,
  usageLastDaysValidationError,
} from '../parse.js';

describe('cli parse helpers', () => {
  it('formats errors from Error and non-Error values', () => {
    expect(cliErrorMessage(new Error('boom'))).toBe('boom');
    expect(cliErrorMessage('plain')).toBe('plain');
  });

  it('validates YYYY-MM-DD date strings', () => {
    expect(isValidDateString('2024-06-01')).toBe(true);
    expect(isValidDateString('2024-6-01')).toBe(false);
    expect(isValidDateString('not-a-date')).toBe(false);
    expect(invalidDateMessage('bad')).toBe('Invalid date: "bad". Expected YYYY-MM-DD.');
  });

  it('parses integer CLI arguments', () => {
    expect(parseIntArgument('42')).toBe(42);
    expect(() => parseIntArgument('nope')).toThrow('Expected an integer, got: nope');
  });

  it('parses positive integers for usage last N', () => {
    expect(parsePositiveInt('14')).toBe(14);
    expect(parsePositiveInt('0')).toBeUndefined();
    expect(parsePositiveInt('1.5')).toBeUndefined();
    expect(usageLastDaysValidationError('0')).toContain('positive integer');
  });

  it('validates top kind, sort, and limit', () => {
    expect(parseTopKind(undefined)).toBe('days');
    expect(parseTopKind('models')).toBe('models');
    expect(topKindValidationError('weeks')).toContain('days" or "models');
    expect(topSortValidationError('price')).toContain('tokens" or "cost');
    expect(topLimitValidationError(0)).toContain('positive integer');
  });

  it('validates date range order', () => {
    expect(dateRangeValidationError('2024-01-01', '2024-01-02')).toBeNull();
    expect(dateRangeValidationError('2024-02-01', '2024-01-01')).toContain('must not be after');
  });
});
