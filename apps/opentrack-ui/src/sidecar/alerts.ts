import { projectPace } from 'aitrack-lib/quota/pacing';

import { formatWhen } from '../shared/pace.js';
import type { QuotaSnapshot } from '../shared/types.js';

export interface Alert {
  /** Stable per window, so each alert fires once until its window resets. */
  key: string;
  resetsAt: string;
  title: string;
  body: string;
}

/** Alert key → the reset it belongs to, persisted so restarts do not re-alert. */
export type FiredAlerts = Record<string, string>;

const ALMOST_OUT_LEFT_PERCENT = 10;
const RESET_GRACE_MS = 5 * 60_000; // The old window can still be reported just after its reset.

function isLive(resetsAt: string | undefined, now: number): boolean {
  return resetsAt !== undefined && Date.parse(resetsAt) + RESET_GRACE_MS > now;
}

export function dueAlerts(
  label: string,
  snapshot: QuotaSnapshot,
  fired: FiredAlerts,
  now: number,
): Alert[] {
  const alerts: Alert[] = [];
  for (const window of snapshot.windows) {
    const { resetsAt } = window;
    if (window.format !== 'percent' || resetsAt === undefined) continue;
    if (!(Date.parse(resetsAt) > now)) continue;
    const scope = `${snapshot.provider}:${window.id}`;
    const left = 100 - window.usedPercent;
    const name = `${label} ${window.label.toLowerCase()}`;
    if (left <= ALMOST_OUT_LEFT_PERCENT) {
      const key = `${scope}:almostOut`;
      if (!isLive(fired[key], now)) {
        alerts.push({
          key,
          resetsAt,
          title: `${name} almost used up`,
          body: `${String(Math.max(0, Math.round(left)))}% left until it resets.`,
        });
      }
      continue;
    }
    const pace = projectPace(window, now);
    const key = `${scope}:willRunOut`;
    if (pace.severity === 'runningOut' && pace.runOutAt !== null && !isLive(fired[key], now)) {
      alerts.push({
        key,
        resetsAt,
        title: `${name} on pace to run out`,
        body: `At this rate it runs out around ${formatWhen(pace.runOutAt, now)}, before it resets.`,
      });
    }
  }
  return alerts;
}

export function pruneFired(fired: FiredAlerts, now: number): FiredAlerts {
  return Object.fromEntries(Object.entries(fired).filter(([, resetsAt]) => isLive(resetsAt, now)));
}
