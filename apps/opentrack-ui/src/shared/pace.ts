import { inclusiveDayCount } from 'aitrack-lib/data/calendar';
import { toLocalDateString } from 'aitrack-lib/data/dayMap';
import type { PaceProjection } from 'aitrack-lib/quota/pacing';

import type { QuotaWindow } from './types.js';

function clock(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "19:20" today, "Sun 21:00" within a week, "Oct 16" beyond. */
export function formatWhen(at: number, now: number): string {
  const date = new Date(at);
  const days = inclusiveDayCount(toLocalDateString(new Date(now)), toLocalDateString(date)) - 1;
  if (days <= 0) return clock(date);
  if (days < 7) return `${date.toLocaleDateString([], { weekday: 'short' })} ${clock(date)}`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export type Tone = 'calm' | 'warn' | 'crit';

/** A window's colour: its pace when there is one, otherwise how full it is. */
export function meterTone(window: QuotaWindow, pace: PaceProjection): Tone {
  if (pace.severity === 'level') {
    const used = Math.round(window.usedPercent);
    if (used >= 90) return 'crit';
    return used >= 80 ? 'warn' : 'calm';
  }
  if (pace.severity === 'close') return 'warn';
  return pace.severity === 'healthy' ? 'calm' : 'crit';
}
