import { describe, expect, it } from 'vitest';

import { projectPace } from '../pacing.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

/** A five-hour window with `elapsedHours` gone. */
function window(usedPercent: number, elapsedHours: number) {
  return {
    usedPercent,
    periodSeconds: 5 * 3600,
    resetsAt: new Date(NOW + (5 - elapsedHours) * HOUR).toISOString(),
  };
}

describe('projectPace', () => {
  it('is spent at 100%', () => {
    expect(projectPace(window(99.6, 1), NOW)).toMatchObject({ severity: 'spent', runOutAt: NOW });
  });

  it('stays level without enough signal', () => {
    expect(projectPace(window(0, 2), NOW).severity).toBe('level');
    expect(projectPace({ usedPercent: 10, periodSeconds: 60 }, NOW).severity).toBe('level');
    expect(projectPace({ ...window(10, 2), periodSeconds: 0 }, NOW).severity).toBe('level');
    expect(projectPace(window(10, 0.01), NOW).severity).toBe('level');
    expect(projectPace(window(4, 0.2), NOW).severity).toBe('level');
  });

  it('projects healthy, close and running out', () => {
    expect(projectPace(window(20, 2.5), NOW)).toMatchObject({
      severity: 'healthy',
      projectedUsedPercent: 40,
      evenPacePercent: 50,
    });
    expect(projectPace(window(48, 2.5), NOW).severity).toBe('close');
    expect(projectPace(window(49.9, 2.5), NOW).severity).toBe('runningOut');
    const over = projectPace(window(80, 2.5), NOW);
    expect(over.severity).toBe('runningOut');
    expect(over.runOutAt).toBe(NOW - 2.5 * HOUR + (2.5 * HOUR * 100) / 80);
  });
});
