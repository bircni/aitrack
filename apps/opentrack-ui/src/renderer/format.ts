import { mondayOfWeek } from 'aitrack-lib/data/calendar';
import { isStaleSync } from 'aitrack-lib/data/staleSync';
import { fmt } from 'aitrack-lib/display/format';
import { clampPercent, type PaceProjection } from 'aitrack-lib/quota/pacing';

import { formatWhen } from '../shared/pace.js';
import type {
  DailyUsage,
  MachineUsage,
  PeriodUsage,
  ProjectUsageEntry,
  ProjectUsages,
  ProviderState,
  ProviderUsage,
  QuotaError,
  QuotaProviderKey,
  QuotaWindow,
  Settings,
  Spend,
} from '../shared/types.js';
import { EMPTY_PERIOD } from '../shared/types.js';

export { fmt as formatTokens };

const locale = (): string => navigator.language;

export function formatCost(value: number): string {
  if (value > 0 && value < 0.01) return `<${formatCost(0.01)}`;
  return new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD' }).format(value);
}

/** Zero under `prefers-reduced-motion`, so expanding a section just appears. */
export function slideDuration(): number {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(locale()).format(value);
}

/** `fraction` is 0–1. */
export function formatPercent(fraction: number): string {
  return new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 }).format(
    fraction,
  );
}

export type Period = 'today' | 'week' | 'month' | 'all';

export const PERIOD_LABELS: Record<Period, string> = {
  today: 'Today',
  week: '7 days',
  month: '30 days',
  all: 'All time',
};

export function periodSpend(usage: ProviderUsage | undefined, period: Period): PeriodUsage {
  if (!usage) return EMPTY_PERIOD;
  if (period === 'today') return usage.today;
  if (period === 'month') return usage.last30Days;
  if (period === 'all') return usage.allTime;
  return usage.last7Days;
}

export function periodProjects(
  projects: ProjectUsages | undefined,
  period: Period,
): ProjectUsageEntry[] {
  if (!projects) return [];
  if (period === 'today') return projects.today;
  if (period === 'month') return projects.last30Days;
  if (period === 'all') return projects.allTime;
  return projects.last7Days;
}

/** Unpriced tokens are not free, so their cost is a dash rather than $0.00. */
export function isPriced(spend: Spend): boolean {
  return spend.hasCost || spend.tokens === 0;
}

export function spendLabel(spend: Spend): string {
  return isPriced(spend)
    ? `${formatCost(spend.costUSD)}${spend.hasCost && spend.hasUnpricedTokens ? ' (partial)' : ''}`
    : '—';
}

export function spendReading(spend: Spend): string {
  const tokens = `${fmt(spend.tokens)} tokens`;
  return spend.hasCost ? `${spendLabel(spend)} · ${tokens}` : tokens;
}

export function totalSpend(usages: Array<ProviderUsage | undefined>, period: Period): Spend {
  return usages.reduce<Spend>((total, usage) => {
    const spend = periodSpend(usage, period);
    return {
      costUSD: total.costUSD + spend.costUSD,
      tokens: total.tokens + spend.tokens,
      hasCost: total.hasCost || spend.hasCost,
      ...(total.hasUnpricedTokens || spend.hasUnpricedTokens || (spend.tokens > 0 && !spend.hasCost)
        ? { hasUnpricedTokens: true }
        : {}),
    };
  }, EMPTY_PERIOD);
}

/** The sidecar keeps 90 days; the sparkline and machine strips show the latest `days`. */
export function combinedDaily(usages: Array<ProviderUsage | undefined>, days = 30): DailyUsage[] {
  const byDate = new Map<string, number>();
  for (const usage of usages) {
    for (const day of usage?.daily ?? []) {
      byDate.set(day.date, (byDate.get(day.date) ?? 0) + day.costUSD);
    }
  }
  return [...byDate]
    .map(([date, costUSD]) => ({ date, costUSD }))
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .slice(-days);
}

export type HistoryRange = 30 | 90;
export type HistoryBucket = 'day' | 'week';

interface HistoryBar {
  /** First day the bar covers; weeks start on Monday. */
  start: string;
  totalUSD: number;
  parts: Array<{ key: QuotaProviderKey; costUSD: number }>;
}

export interface History {
  bars: HistoryBar[];
  totalUSD: number;
  /** Per calendar day in the range, empty days included. */
  averageUSD: number;
  /** First and last day covered; empty without data. */
  from: string;
  to: string;
  peakUSD: number;
  /** Start of the busiest bar; empty without data. */
  busiest: string;
  byProvider: Array<{ key: QuotaProviderKey; label: string; costUSD: number }>;
}

/** Stacked cost per day (or week) over the last `range` days, split by provider. */
export function buildHistory(
  providers: Array<Pick<ProviderState, 'key' | 'label' | 'usage'>>,
  range: number,
  bucket: HistoryBucket,
): History {
  const dates = [...new Set(providers.flatMap((p) => p.usage?.daily.map((d) => d.date) ?? []))]
    .toSorted()
    .slice(-range);
  const inRange = new Set(dates);
  const bars = new Map<string, HistoryBar>();
  for (const provider of providers) {
    for (const day of provider.usage?.daily ?? []) {
      if (!inRange.has(day.date)) continue;
      const start = bucket === 'day' ? day.date : mondayOfWeek(day.date);
      const bar = bars.get(start) ?? { start, totalUSD: 0, parts: [] };
      bars.set(start, bar);
      bar.totalUSD += day.costUSD;
      const part = bar.parts.find((entry) => entry.key === provider.key);
      if (part) part.costUSD += day.costUSD;
      else bar.parts.push({ key: provider.key, costUSD: day.costUSD });
    }
  }
  const list = [...bars.values()].toSorted((a, b) => a.start.localeCompare(b.start));
  const totalUSD = list.reduce((sum, bar) => sum + bar.totalUSD, 0);
  const peak = list.reduce<HistoryBar | undefined>(
    (best, bar) => (bar.totalUSD > (best?.totalUSD ?? 0) ? bar : best),
    undefined,
  );
  return {
    bars: list,
    totalUSD,
    averageUSD: dates.length > 0 ? totalUSD / dates.length : 0,
    from: dates[0] ?? '',
    to: dates.at(-1) ?? '',
    peakUSD: peak?.totalUSD ?? 0,
    busiest: peak?.start ?? '',
    byProvider: providers
      .map(({ key, label, usage }) => ({
        key,
        label,
        costUSD: (usage?.daily ?? [])
          .filter((day) => inRange.has(day.date))
          .reduce((sum, day) => sum + day.costUSD, 0),
      }))
      .filter((part) => part.costUSD > 0)
      .toSorted((a, b) => b.costUSD - a.costUSD),
  };
}

/** "$115", ".70" and "", so the cents can be set quieter; currencies written after the number fill `tail`. */
export function splitAmount(value: number): { whole: string; cents: string; tail: string } {
  const parts = new Intl.NumberFormat(locale(), {
    style: 'currency',
    currency: 'USD',
  }).formatToParts(value);
  const first = parts.findIndex(({ type }) => type === 'decimal');
  const end = parts.findLastIndex(({ type }) => type === 'fraction');
  const text = (from: number, to: number): string =>
    parts
      .slice(from, to)
      .map(({ value: part }) => part)
      .join('');
  return { whole: text(0, first), cents: text(first, end + 1), tail: text(end + 1, parts.length) };
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
    : `Resets ${formatWhen(at, now, locale())}`;
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
      return pace.runOutAt === null
        ? 'Will run out'
        : `Runs out ${formatWhen(pace.runOutAt, now, locale())}`;
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
    return `${formatCost(shown)} / ${formatCost(limitValue)}${suffix}`;
  }
  return `${formatPercent(fillPercent(window, display) / 100)}${suffix}`;
}

export interface ProblemLine {
  text: string;
  /** Offer a retry: the problem may clear on its own. */
  retry: boolean;
}

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
  if (updatedAt === undefined) return 'Not updated yet';
  const age = now - Date.parse(updatedAt);
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

/** How current a machine's numbers are: this one reads its logs live, others are as of their last sync. */
export function syncStatus(
  machine: Pick<MachineUsage, 'lastUpdated' | 'current'>,
  now: number,
): { text: string; stale: boolean } {
  const at = Date.parse(machine.lastUpdated);
  if (Number.isNaN(at)) {
    return machine.current
      ? { text: 'Live · not synced yet', stale: false }
      : { text: 'Never synced', stale: true };
  }
  const age = Math.max(0, now - at);
  const ago = age < 60_000 ? 'just now' : `${formatDuration(age)} ago`;
  return machine.current
    ? { text: `Live · synced ${ago}`, stale: false }
    : { text: `Synced ${ago}`, stale: isStaleSync(machine.lastUpdated, now) };
}

/** "07:42" on that machine's clock, or nothing when it shares this one's zone. */
export function zoneClock(timezone: string, now: number): string | undefined {
  try {
    const here = Intl.DateTimeFormat(locale()).resolvedOptions().timeZone;
    if (timezone === '' || timezone === here) return undefined;
    return new Intl.DateTimeFormat(locale(), {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(now);
  } catch {
    return undefined; // Not an IANA zone, e.g. a file from a machine that recorded none.
  }
}

/** 0 for an idle day, then 1–4 by quartile of `max`, like the aitrack heatmap. */
export function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((value / max) * 4));
}
