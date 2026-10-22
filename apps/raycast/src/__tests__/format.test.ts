import type { PaceProjection } from 'aitrack-lib/quota/pacing';
import type { QuotaWindow } from 'aitrack-lib/quota/types';
import { describe, expect, it } from 'vitest';

import {
  formatDuration,
  formatLimitValue,
  formatReset,
  paceLabel,
  problemText,
  windowTone,
} from '../format.js';

const NOW = Date.UTC(2026, 5, 1, 12);
const HOUR = 3_600_000;
const level: PaceProjection = {
  severity: 'level',
  projectedUsedPercent: null,
  evenPacePercent: null,
  runOutAt: null,
};
const window: QuotaWindow = {
  id: 'session',
  label: 'Session',
  usedPercent: 42.4,
  periodSeconds: 18_000,
  format: 'percent',
};

describe('format', () => {
  it('formats durations and resets', () => {
    expect(formatDuration(30_000)).toBe('1m');
    expect(formatDuration(2 * HOUR)).toBe('2h');
    expect(formatDuration(2 * HOUR + 90_000)).toBe('2h 2m');
    expect(formatDuration(26 * HOUR)).toBe('1d 2h');
    expect(formatReset(undefined, NOW)).toBeUndefined();
    expect(formatReset(new Date(NOW + 30_000).toISOString(), NOW)).toBe('Resets soon');
    expect(formatReset(new Date(NOW + 3 * HOUR).toISOString(), NOW)).toBe('Resets in 3h');
  });

  it('tones a window by pace, or by fill without one', () => {
    expect(windowTone(window, level)).toBe('calm');
    expect(windowTone({ ...window, usedPercent: 85 }, level)).toBe('warn');
    expect(windowTone({ ...window, usedPercent: 95 }, level)).toBe('crit');
    expect(windowTone(window, { ...level, severity: 'close' })).toBe('warn');
    expect(windowTone(window, { ...level, severity: 'runningOut' })).toBe('crit');
  });

  it('labels pace, values and problems', () => {
    expect(paceLabel(level, NOW)).toBeUndefined();
    expect(paceLabel({ ...level, severity: 'runningOut', runOutAt: NOW + HOUR }, NOW)).toBe(
      'Runs out in 1h',
    );
    expect(formatLimitValue(window)).toBe('42% used');
    expect(
      formatLimitValue({ ...window, format: 'dollars', usedValue: 12.5, limitValue: 50 }),
    ).toBe('$12.50 / $50.00');
    expect(problemText({ kind: 'rateLimited', message: '', retryAfterSeconds: 120 })).toBe(
      'Limits paused, back in 2m',
    );
  });
});
