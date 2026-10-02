import { describe, expect, it } from 'vitest';

import { formatWhen, meterTone } from '../../shared/pace.js';
import type { PeriodUsage, ProviderUsage, QuotaWindow } from '../../shared/types.js';
import {
  combinedDaily,
  fillPercent,
  formatDuration,
  formatLimitValue,
  formatReset,
  formatUpdated,
  paceLabel,
  periodSpend,
  spendLabel,
  problemLine,
  sparkline,
  splitAmount,
  totalSpend,
} from '../format.js';

const NOW = new Date(2026, 5, 1, 12).getTime();
const HOUR = 3_600_000;
const base = { projectedUsedPercent: null, evenPacePercent: null, runOutAt: null };
const percent: QuotaWindow = {
  id: 'w',
  label: 'W',
  usedPercent: 30.4,
  periodSeconds: 0,
  format: 'percent',
};

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function period(costUSD: number): PeriodUsage {
  return { tokens: costUSD * 1000, costUSD, hasCost: costUSD > 0, models: [] };
}

function usage(daily: number[], today = 1): ProviderUsage {
  return {
    today: period(today),
    yesterday: period(0),
    last7Days: period(7.5),
    last30Days: period(daily.reduce((sum, value) => sum + value, 0)),
    allTime: period(daily.reduce((sum, value) => sum + value, 0) + 10),
    daily: daily.map((costUSD, index) => ({
      date: `2026-05-${String(index + 1).padStart(2, '0')}`,
      costUSD,
    })),
  };
}

describe('spend', () => {
  it('reads each period from its report', () => {
    const claude = usage([1, 1, 1, 1, 1, 1, 1, 1, 2, 3], 3);
    expect(periodSpend(claude, 'today').costUSD).toBe(3);
    expect(periodSpend(claude, 'month').costUSD).toBe(13);
    expect(periodSpend(claude, 'all').costUSD).toBe(23);
    expect(periodSpend(claude, 'week')).toBe(claude.last7Days);
    expect(periodSpend(undefined, 'week')).toEqual({ costUSD: 0, tokens: 0, hasCost: false });
    expect(spendLabel({ costUSD: 0, tokens: 0, hasCost: false })).toBe('$0.00');
    expect(spendLabel({ costUSD: 0, tokens: 500, hasCost: false })).toBe('—');
    expect(totalSpend([claude, undefined, usage([0], 0)], 'today')).toEqual({
      costUSD: 3,
      tokens: 3000,
      hasCost: true,
    });
  });

  it('combines daily series by date', () => {
    expect(combinedDaily([usage([1, 2]), usage([3]), undefined])).toEqual([
      { date: '2026-05-01', costUSD: 4 },
      { date: '2026-05-02', costUSD: 2 },
    ]);
  });

  it('splits dollars from cents', () => {
    expect(splitAmount(115.7)).toEqual({ whole: '$115', cents: '.70' });
    expect(splitAmount(4246.62)).toEqual({ whole: '$4,246', cents: '.62' });
  });

  it('draws a sparkline, or nothing without data', () => {
    const curve = sparkline([0, 5, 10], 112, 36);
    expect(curve?.line).toBe('M3.0 33.0 L56.0 18.0 L109.0 3.0');
    expect(curve?.area).toBe('M3.0 33.0 L56.0 18.0 L109.0 3.0 L109.0 33.0 L3.0 33.0 Z');
    expect(curve?.end).toEqual({ x: 109, y: 3 });
    expect(sparkline([0, 0], 112, 36)).toBeUndefined();
    expect(sparkline([4], 112, 36)).toBeUndefined();
  });
});

describe('limits', () => {
  it('formats durations and reset times', () => {
    expect(formatDuration(30_000)).toBe('1m');
    expect(formatDuration(2 * HOUR + 14 * 60_000)).toBe('2h 14m');
    expect(formatDuration(2 * HOUR)).toBe('2h');
    expect(formatDuration(3 * 24 * HOUR + 5 * HOUR)).toBe('3d 5h');
    const later = NOW + 2 * HOUR;
    expect(formatWhen(later, NOW)).toBe(clock(later));
    const sunday = new Date(2026, 5, 3, 21).getTime();
    expect(formatWhen(sunday, NOW)).toBe(
      `${new Date(sunday).toLocaleDateString([], { weekday: 'short' })} ${clock(sunday)}`,
    );
    const far = new Date(2026, 5, 16, 12);
    expect(formatWhen(far.getTime(), NOW)).toBe(
      far.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    );
    expect(formatReset(new Date(later).toISOString(), NOW, 'absolute')).toBe(
      `Resets ${clock(later)}`,
    );
    expect(formatReset(new Date(later).toISOString(), NOW, 'relative')).toBe('Resets in 2h');
    expect(formatReset(new Date(NOW + 30_000).toISOString(), NOW, 'relative')).toBe('Resets soon');
    expect(formatReset(undefined, NOW, 'relative')).toBeUndefined();
  });

  it('labels the pace in plain words', () => {
    expect(paceLabel({ ...base, severity: 'level' }, NOW)).toBeUndefined();
    expect(paceLabel({ ...base, severity: 'healthy' }, NOW)).toBe('On pace');
    expect(paceLabel({ ...base, severity: 'close' }, NOW)).toBe('Tight');
    expect(paceLabel({ ...base, severity: 'runningOut' }, NOW)).toBe('Will run out');
    expect(paceLabel({ ...base, severity: 'runningOut', runOutAt: NOW + HOUR }, NOW)).toBe(
      `Runs out ${clock(NOW + HOUR)}`,
    );
    expect(paceLabel({ ...base, severity: 'spent' }, NOW)).toBe('Limit reached');
  });

  it('colours the meter by pace, or by fill without one', () => {
    const level = { ...base, severity: 'level' as const };
    expect(meterTone({ ...percent, usedPercent: 91 }, level)).toBe('crit');
    expect(meterTone({ ...percent, usedPercent: 82 }, level)).toBe('warn');
    expect(meterTone(percent, level)).toBe('calm');
    expect(meterTone(percent, { ...base, severity: 'healthy' })).toBe('calm');
    expect(meterTone(percent, { ...base, severity: 'close' })).toBe('warn');
    expect(meterTone(percent, { ...base, severity: 'spent' })).toBe('crit');
  });

  it('shows the value as used or left', () => {
    expect(formatLimitValue(percent, 'used')).toBe('30%');
    expect(formatLimitValue(percent, 'left')).toBe('70% left');
    expect(fillPercent(percent, 'left')).toBeCloseTo(69.6);
    const dollars: QuotaWindow = { ...percent, format: 'dollars', usedValue: 12.5, limitValue: 50 };
    expect(formatLimitValue(dollars, 'used')).toBe('$12.50 / $50.00');
    expect(formatLimitValue(dollars, 'left')).toBe('$37.50 / $50.00 left');
    expect(formatLimitValue({ ...dollars, usedValue: 0 }, 'used')).toBe('$0.00 / $50.00');
  });

  it('turns errors into one line', () => {
    expect(problemLine({ kind: 'noCredentials', message: 'x' }, NOW)).toEqual({
      text: 'Not signed in on this PC',
      retry: false,
    });
    expect(problemLine({ kind: 'expired', message: 'x' }, NOW).retry).toBe(true);
    expect(problemLine({ kind: 'rateLimited', message: 'x' }, NOW, NOW + 3120 * 1000).text).toBe(
      'Limits paused, back in 52m',
    );
    expect(problemLine({ kind: 'rateLimited', message: 'x' }, NOW).text).toBe('Limits paused');
    expect(problemLine({ kind: 'network', message: 'x' }, NOW).text).toBe(
      'Could not reach the service',
    );
    expect(problemLine({ kind: 'invalidResponse', message: 'x' }, NOW).retry).toBe(true);
  });

  it('formats the footer age', () => {
    expect(formatUpdated(new Date(NOW - 5000).toISOString(), NOW)).toBe('Updated just now');
    expect(formatUpdated(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe('Updated 3m ago');
    expect(formatUpdated(undefined, NOW)).toBe('Updating…');
    expect(formatUpdated('bad', NOW)).toBe('Updating…');
    expect(formatUpdated(new Date(NOW - 61_000).toISOString(), NOW)).toBe('Updated 1m ago');
  });
});
