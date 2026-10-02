import { projectPace } from 'aitrack-lib/quota/pacing';

import { formatWhen } from '../shared/pace.js';
import type { QuotaSnapshot } from '../shared/types.js';

export interface Alert {
  /** Stable per window, so each alert fires once until its reset is pruned. */
  key: string;
  resetsAt: string;
  title: string;
  body: string;
}

/** Alert key → the reset it belongs to, persisted so restarts do not re-alert. */
export type FiredAlerts = Record<string, string>;

const ALMOST_OUT_LEFT_PERCENT = 10;
const RESET_GRACE_MS = 5 * 60_000; // The old window can still be reported just after its reset.

/** Alerts newly due for a snapshot. */
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
      if (!(key in fired)) {
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
    if (pace.severity === 'runningOut' && pace.runOutAt !== null && !(key in fired)) {
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

/** Forget alerts whose window has reset. */
export function pruneFired(fired: FiredAlerts, now: number): FiredAlerts {
  return Object.fromEntries(
    Object.entries(fired).filter(([, resetsAt]) => Date.parse(resetsAt) + RESET_GRACE_MS > now),
  );
}
