import { fmtUSDCost } from 'aitrack-lib/display/format';
import { clampPercent, type PaceProjection } from 'aitrack-lib/quota/pacing';
import type { QuotaError, QuotaWindow } from 'aitrack-lib/quota/types';

export type Tone = 'calm' | 'warn' | 'crit';

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return rest > 0 ? `${String(hours)}h ${String(rest)}m` : `${String(hours)}h`;
  return `${String(rest)}m`;
}

export function formatReset(resetsAt: string | undefined, now: number): string | undefined {
  const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  if (Number.isNaN(at)) return undefined;
  return at - now <= 60_000 ? 'Resets soon' : `Resets in ${formatDuration(at - now)}`;
}

/** Same thresholds as opentrack's meters: pace when there is one, otherwise how full it is. */
export function windowTone(window: QuotaWindow, pace: PaceProjection): Tone {
  if (pace.severity === 'level') {
    const used = Math.round(window.usedPercent);
    if (used >= 90) return 'crit';
    return used >= 80 ? 'warn' : 'calm';
  }
  if (pace.severity === 'close') return 'warn';
  return pace.severity === 'healthy' ? 'calm' : 'crit';
}

export function paceLabel(pace: PaceProjection, now: number): string | undefined {
  switch (pace.severity) {
    case 'level': {
      return undefined;
    }
    case 'healthy': {
      return 'On pace';
    }
    case 'close': {
      return 'Tight';
    }
    case 'runningOut': {
      return pace.runOutAt === null
        ? 'Will run out'
        : `Runs out in ${formatDuration(pace.runOutAt - now)}`;
    }
    case 'spent': {
      return 'Limit reached';
    }
  }
}

/** "13% used", or "$12.50 / $50.00" for money windows. */
export function formatLimitValue(window: QuotaWindow): string {
  const { usedValue, limitValue } = window;
  if (window.format === 'dollars' && usedValue !== undefined && limitValue !== undefined) {
    return `${fmtUSDCost(usedValue)} / ${fmtUSDCost(limitValue)}`;
  }
  return `${String(Math.round(clampPercent(window.usedPercent)))}% used`;
}

export function problemText(error: QuotaError): string {
  switch (error.kind) {
    case 'noCredentials': {
      return 'Not signed in on this Mac';
    }
    case 'expired':
    case 'auth': {
      return 'Sign-in expired, open the app to renew it';
    }
    case 'rateLimited': {
      return error.retryAfterSeconds === undefined
        ? 'Limits paused'
        : `Limits paused, back in ${formatDuration(error.retryAfterSeconds * 1000)}`;
    }
    case 'network': {
      return 'Could not reach the service';
    }
    case 'invalidResponse': {
      return 'Limits unavailable right now';
    }
  }
}
