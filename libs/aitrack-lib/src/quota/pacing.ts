import type { QuotaWindow } from './types.js';

/**
 * Whether a quota will last until it resets, projected from the pace so far.
 *
 * Ported from OpenQuota's `src/lib/pacing.ts` (MIT, deviffyy/OpenQuota).
 */
export type PaceSeverity = 'level' | 'healthy' | 'close' | 'runningOut' | 'spent';

export interface PaceProjection {
  severity: PaceSeverity;
  projectedUsedPercent: number | null;
  evenPacePercent: number | null;
  /** Epoch ms the quota runs out, when that falls before the reset. */
  runOutAt: number | null;
}

const LEVEL: PaceProjection = {
  severity: 'level',
  projectedUsedPercent: null,
  evenPacePercent: null,
  runOutAt: null,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampPercent(value: number): number {
  return clamp(value, 0, 100);
}

export function projectPace(
  window: Pick<QuotaWindow, 'usedPercent' | 'resetsAt' | 'periodSeconds'>,
  now: number,
): PaceProjection {
  const used = clampPercent(window.usedPercent);
  if (Math.round(used) >= 100) {
    return { severity: 'spent', projectedUsedPercent: 100, evenPacePercent: null, runOutAt: now };
  }
  if (used <= 0) return LEVEL;
  const reset = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  if (!Number.isFinite(reset) || reset <= now || window.periodSeconds <= 0) return LEVEL;
  const periodMs = window.periodSeconds * 1000;
  const start = reset - periodMs;
  const elapsed = Math.max(0, now - start);
  // Too early in the window for a projection to mean anything.
  if (elapsed < Math.max(60_000, periodMs * 0.01)) return LEVEL;
  const progress = clamp(elapsed / periodMs, 0, 1);
  const projected = used / progress;
  const evenPacePercent = progress * 100;
  if (projected <= 90) {
    return {
      severity: 'healthy',
      projectedUsedPercent: projected,
      evenPacePercent,
      runOutAt: null,
    };
  }
  if (used < 5) return LEVEL;
  if (projected <= 100) {
    const severity = Math.round(100 - projected) >= 1 ? 'close' : 'runningOut';
    return { severity, projectedUsedPercent: projected, evenPacePercent, runOutAt: null };
  }
  const runOutAt = start + (elapsed * 100) / used;
  return {
    severity: 'runningOut',
    projectedUsedPercent: projected,
    evenPacePercent,
    runOutAt: runOutAt > now && runOutAt < reset ? runOutAt : null,
  };
}
