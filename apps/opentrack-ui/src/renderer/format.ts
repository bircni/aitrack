import { fmt, fmtUSDCost } from 'aitrack-lib/display/format';
import { clampPercent, type PaceProjection } from 'aitrack-lib/quota/pacing';

import { formatWhen } from '../shared/pace.js';
import type {
  DailyUsage,
  ProviderUsage,
  QuotaError,
  QuotaWindow,
  Settings,
  Spend,
} from '../shared/types.js';

export { fmt as formatTokens, fmtUSDCost as formatCost };

export type Period = 'today' | 'week' | 'month' | 'all';

export const PERIOD_LABELS: Record<Period, string> = {
  today: 'Today',
  week: '7 days',
  month: '30 days',
  all: 'all',
};

const NO_SPEND: Spend = { costUSD: 0, tokens: 0, hasCost: false };

export function periodSpend(usage: ProviderUsage | undefined, period: Period): Spend {
  if (!usage) return NO_SPEND;
  if (period === 'today') return usage.today;
  if (period === 'month') return usage.last30Days;
  if (period === 'all') return usage.allTime;
  return usage.last7Days;
}

/** Unpriced tokens are not free, so their cost is a dash rather than $0.00. */
export function isPriced(spend: Spend): boolean {
  return spend.hasCost || spend.tokens === 0;
}

export function spendLabel(spend: Spend): string {
  return isPriced(spend) ? fmtUSDCost(spend.costUSD) : '—';
}

export function totalSpend(usages: Array<ProviderUsage | undefined>, period: Period): Spend {
  return usages.reduce<Spend>((total, usage) => {
    const spend = periodSpend(usage, period);
    return {
      costUSD: total.costUSD + spend.costUSD,
      tokens: total.tokens + spend.tokens,
      hasCost: total.hasCost || spend.hasCost,
    };
  }, NO_SPEND);
}

/** Daily cost summed across providers, aligned on date. */
export function combinedDaily(usages: Array<ProviderUsage | undefined>): DailyUsage[] {
  const byDate = new Map<string, number>();
  for (const usage of usages) {
    for (const day of usage?.daily ?? []) {
      byDate.set(day.date, (byDate.get(day.date) ?? 0) + day.costUSD);
    }
  }
  return [...byDate]
    .map(([date, costUSD]) => ({ date, costUSD }))
    .toSorted((a, b) => a.date.localeCompare(b.date));
}

/** "$115" and ".70", so the cents can be set quieter than the dollars. */
export function splitAmount(value: number): { whole: string; cents: string } {
  const [whole = '0', cents = '00'] = value.toFixed(2).split('.');
  return { whole: `$${Number(whole).toLocaleString('en-US')}`, cents: `.${cents}` };
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return rest > 0 ? `${String(hours)}h ${String(rest)}m` : `${String(hours)}h`;
  return `${String(rest)}m`;
}

export function formatReset(
  resetsAt: string | undefined,
  now: number,
  mode: Settings['resetDisplay'],
): string | undefined {
  const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  if (Number.isNaN(at)) return undefined;
  if (at - now <= 60_000) return 'Resets soon';
  return mode === 'relative'
    ? `Resets in ${formatDuration(at - now)}`
    : `Resets ${formatWhen(at, now)}`;
}

/** The right-hand note under a meter, coloured by the meter's tone; nothing when there is too little to judge. */
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
      return pace.runOutAt === null ? 'Will run out' : `Runs out ${formatWhen(pace.runOutAt, now)}`;
    }
    case 'spent': {
      return 'Limit reached';
    }
  }
}

export function fillPercent(window: QuotaWindow, display: Settings['display']): number {
  const used = clampPercent(window.usedPercent);
  return display === 'used' ? used : 100 - used;
}

/** "13%" or "87% left"; "$12.50 / $50.00" for money windows. */
export function formatLimitValue(window: QuotaWindow, display: Settings['display']): string {
  const { usedValue, limitValue } = window;
  const suffix = display === 'left' ? ' left' : '';
  if (window.format === 'dollars' && usedValue !== undefined && limitValue !== undefined) {
    const shown = display === 'used' ? usedValue : Math.max(0, limitValue - usedValue);
    return `${fmtUSDCost(shown)} / ${fmtUSDCost(limitValue)}${suffix}`;
  }
  return `${fillPercent(window, display).toFixed(0)}%${suffix}`;
}

export interface ProblemLine {
  text: string;
  /** Offer a retry: the problem may clear on its own. */
  retry: boolean;
}

/** A one-line version of a quota error for the provider row. */
export function problemLine(error: QuotaError, now: number, retryAt?: number): ProblemLine {
  switch (error.kind) {
    case 'noCredentials': {
      return { text: 'Not signed in on this PC', retry: false };
    }
    case 'expired':
    case 'auth': {
      return { text: 'Sign-in expired, open the app to renew it', retry: true };
    }
    case 'rateLimited': {
      return {
        text:
          retryAt !== undefined && retryAt > now
            ? `Limits paused, back in ${formatDuration(retryAt - now)}`
            : 'Limits paused',
        retry: true,
      };
    }
    case 'network': {
      return { text: 'Could not reach the service', retry: true };
    }
    case 'invalidResponse': {
      return { text: 'Limits unavailable right now', retry: true };
    }
  }
}

/** "Updated just now" / "Updated 3m ago" for the footer. */
export function formatUpdated(updatedAt: string | undefined, now: number): string {
  if (updatedAt === undefined) return 'Updating…';
  const age = now - Date.parse(updatedAt);
  if (Number.isNaN(age)) return 'Updating…';
  // Floored, unlike a countdown: 61 s ago is "1m ago", not "2m".
  return age < 60_000
    ? 'Updated just now'
    : `Updated ${formatDuration(Math.floor(age / 60_000) * 60_000)} ago`;
}

export interface Sparkline {
  line: string;
  area: string;
  end: { x: number; y: number };
}

/** Path data for a small spend curve in a `width` × `height` box. */
export function sparkline(
  values: number[],
  width: number,
  height: number,
  pad = 3,
): Sparkline | undefined {
  const max = Math.max(0, ...values);
  if (values.length < 2 || max <= 0) return undefined;
  const points = values.map((value, index) => ({
    x: pad + (index * (width - pad * 2)) / (values.length - 1),
    y: height - pad - (value / max) * (height - pad * 2),
  }));
  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ');
  const last = points.at(-1) ?? { x: pad, y: height - pad };
  const baseline = (height - pad).toFixed(1);
  return {
    line,
    area: `${line} L${last.x.toFixed(1)} ${baseline} L${pad.toFixed(1)} ${baseline} Z`,
    end: last,
  };
}
