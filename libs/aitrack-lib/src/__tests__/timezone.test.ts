import { describe, expect, it, vi } from 'vitest';

import { calendarDateInTimeZone, machineTimezone } from '../timezone.js';

describe('calendarDateInTimeZone', () => {
  const instant = new Date('2026-06-15T03:00:00Z');

  it('returns the civil date in that zone', () => {
    expect(calendarDateInTimeZone('UTC', instant)).toBe('2026-06-15');
    expect(calendarDateInTimeZone('America/Los_Angeles', instant)).toBe('2026-06-14');
  });

  it('returns null for a missing or invalid zone', () => {
    expect(calendarDateInTimeZone('unknown', instant)).toBeNull();
    expect(calendarDateInTimeZone('Not/AZone', instant)).toBeNull();
  });
});

it('falls back to UTC when Intl cannot report a zone', () => {
  const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(() => {
    throw new Error('unsupported');
  });
  expect(machineTimezone()).toBe('UTC');
  spy.mockRestore();
  expect(calendarDateInTimeZone('', new Date())).toBeNull();
});

it('rejects an Intl result that is not a calendar date', () => {
  const original = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'format');
  if (!original) throw new Error('missing Intl formatter');
  Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', {
    configurable: true,
    value: () => 'invalid',
  });
  try {
    expect(calendarDateInTimeZone('UTC')).toBeNull();
  } finally {
    Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', original);
  }
  const options = new Intl.DateTimeFormat().resolvedOptions();
  const resolved = vi
    .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    .mockReturnValue({ ...options, timeZone: '' });
  expect(machineTimezone()).toBe('UTC');
  resolved.mockRestore();
});
