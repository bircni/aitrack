import { mondayOfWeek } from 'aitrack-lib/data/calendar';
import { INIT_HINT } from 'aitrack-lib/data/messages';
import { isStaleSync } from 'aitrack-lib/data/staleSync';
import { fmt } from 'aitrack-lib/display/format';
import { clampPercent, type PaceProjection } from 'aitrack-lib/quota/pacing';

import { formatWhen } from '../shared/pace.js';
import type {
  AppState,
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

const locale = (): string => navigator.language;

export function formatCost(value: number): string {
  if (value > 0 && value < 0.01) return `<${formatCost(0.01)}`;
  return new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD' }).format(value);
}

/** Zero under `prefers-reduced-motion`, so expanding a section just appears. */
export function slideDuration(): number {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160;
}

/** The CLI's K/M/B shape, with the decimal separator of the system language. */
export function formatTokens(value: number): string {
  const text = fmt(value);
  const number = /^[\d.]+/u.exec(text)?.[0] ?? text;
  const digits = number.split('.')[1]?.length ?? 0;
  const mantissa = new Intl.NumberFormat(locale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(number));
  return `${mantissa}${text.slice(number.length)}`;
}

/** "May 11" for a `YYYY-MM-DD` calendar day; noon, so no zone or DST change can move the day. */
export function formatDay(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(locale(), {
    month: 'short',
    day: 'numeric',
  });
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

const PERIOD_FIELD = {
  today: 'today',
  week: 'last7Days',
  month: 'last30Days',
  all: 'allTime',
} as const satisfies Record<Period, keyof ProjectUsages>;

export function periodSpend(usage: ProviderUsage | undefined, period: Period): PeriodUsage {
  return usage ? usage[PERIOD_FIELD[period]] : EMPTY_PERIOD;
}

export function periodProjects(
  projects: ProjectUsages | undefined,
  period: Period,
): ProjectUsageEntry[] {
  return projects ? projects[PERIOD_FIELD[period]] : [];
}

/** Whether there are usage numbers to show at all; zero is only a fact once they exist. */
export type UsageAvailability = 'ready' | 'loading' | 'failed' | 'empty' | 'off';

export function usageAvailability(
  state: Pick<AppState, 'providers' | 'refreshing' | 'usageError' | 'usageEmpty'>,
): UsageAvailability {
  if (state.providers.length === 0) return 'off';
  if (state.usageEmpty && !state.usageError) return 'empty';
  if (state.providers.some((provider) => provider.usage)) return 'ready';
  if (state.refreshing) return 'loading';
  return state.usageError ? 'failed' : 'loading';
}

export const USAGE_NOTES: Record<Exclude<UsageAvailability, 'ready'>, string> = {
  loading: 'Reading usage…',
  failed: 'Usage could not be read',
  empty: 'No usage found yet',
  off: 'No providers are turned on',
};

/** The next step when a load found nothing to read. */
export function emptyUsageGuidance(providers: Array<Pick<ProviderState, 'label'>>): string {
  const tools = new Intl.ListFormat('en', { type: 'disjunction' }).format(
    providers.map((provider) => provider.label),
  );
  return `Use ${tools}, then refresh. To add your other machines, run \`${INIT_HINT}\`.`;
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
  const tokens = `${formatTokens(spend.tokens)} tokens`;
  return spend.hasCost ? `${spendLabel(spend)} · ${tokens}` : tokens;
}

export function totalSpend(usages: Array<ProviderUsage | undefined>, period: Period): Spend {
  return usages.reduce<Spend>((total, usage) => {
    const spend = periodSpend(usage, period);
    return {
      costUSD: total.costUSD + spend.costUSD,
      tokens: total.tokens + spend.tokens,
      hasCost: total.hasCost || spend.hasCost,
      ...(total.hasUnpricedTokens || spend.hasUnpricedTokens ? { hasUnpricedTokens: true } : {}),
    };
  }, EMPTY_PERIOD);
}

/** Shares follow cost while anything is priced, so an unpriced row does not look free. */
export function shareBasis(spends: Spend[]): {
  byCost: boolean;
  measure: (spend: Spend) => number;
  total: number;
} {
  const byCost = spends.some((spend) => spend.costUSD > 0);
  const measure = (spend: Spend): number => (byCost ? spend.costUSD : spend.tokens);
  return { byCost, measure, total: spends.reduce((sum, spend) => sum + measure(spend), 0) };
}

/** The shell keeps 90 days; the sparkline and machine strips show the latest `days`. */
export function combinedDaily(usages: Array<ProviderUsage | undefined>, days = 30): DailyUsage[] {
  const byDate = new Map<string, DailyUsage>();
  for (const usage of usages) {
    for (const day of usage?.daily ?? []) {
      const total = byDate.get(day.date);
      byDate.set(day.date, {
        date: day.date,
        costUSD: (total?.costUSD ?? 0) + day.costUSD,
        ...([total, day].some((entry) => entry?.hasUnpricedTokens) && { hasUnpricedTokens: true }),
      });
    }
  }
  return [...byDate.values()].toSorted((a, b) => a.date.localeCompare(b.date)).slice(-days);
}

/** A day's cost, marked when part or all of its tokens have no price. */
export function dayCostLabel(day: DailyUsage): string {
  if (!day.hasUnpricedTokens) return formatCost(day.costUSD);
  return day.costUSD > 0 ? `${formatCost(day.costUSD)} (partial)` : 'Not priced';
}

export type HistoryRange = 30 | 90;
export type HistoryBucket = 'day' | 'week';

interface HistoryBar {
  /** First day the bar covers; weeks start on Monday. */
  start: string;
  totalUSD: number;
  parts: Array<{ key: QuotaProviderKey; label: string; costUSD: number }>;
}

interface HistoryProvider {
  key: QuotaProviderKey;
  label: string;
  costUSD: number;
  hasUnpricedTokens: boolean;
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
  byProvider: HistoryProvider[];
  /** Some day in range has tokens without a price, so the totals are partial. */
  hasUnpricedTokens: boolean;
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
      else bar.parts.push({ key: provider.key, label: provider.label, costUSD: day.costUSD });
    }
  }
  const list = [...bars.values()].toSorted((a, b) => a.start.localeCompare(b.start));
  const totalUSD = list.reduce((sum, bar) => sum + bar.totalUSD, 0);
  const peak = list.reduce<HistoryBar | undefined>(
    (best, bar) => (bar.totalUSD > (best?.totalUSD ?? 0) ? bar : best),
    undefined,
  );
  const byProvider = providers
    .map(({ key, label, usage }) => {
      const days = (usage?.daily ?? []).filter((day) => inRange.has(day.date));
      return {
        key,
        label,
        costUSD: days.reduce((sum, day) => sum + day.costUSD, 0),
        hasUnpricedTokens: days.some((day) => day.hasUnpricedTokens),
      };
    })
    .filter((part) => part.costUSD > 0 || part.hasUnpricedTokens)
    .toSorted((a, b) => b.costUSD - a.costUSD);
  return {
    bars: list,
    totalUSD,
    averageUSD: dates.length > 0 ? totalUSD / dates.length : 0,
    from: dates[0] ?? '',
    to: dates.at(-1) ?? '',
    peakUSD: peak?.totalUSD ?? 0,
    busiest: peak?.start ?? '',
    byProvider,
    hasUnpricedTokens: byProvider.some((part) => part.hasUnpricedTokens),
  };
}

/** "$115", ".70" and "", so the cents can be set quieter; currencies written after the number fill `tail`. */
export function splitAmount(value: number): { whole: string; cents: string; tail: string } {
  if (value > 0 && value < 0.01) return { whole: formatCost(value), cents: '', tail: '' };
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

export function toggledDisplay({ display }: Settings): Pick<Settings, 'display'> {
  return { display: display === 'used' ? 'left' : 'used' };
}

export function toggledResetDisplay({ resetDisplay }: Settings): Pick<Settings, 'resetDisplay'> {
  return { resetDisplay: resetDisplay === 'relative' ? 'absolute' : 'relative' };
}

export function formatReset(
  resetsAt: string | undefined,
  now: number,
  mode: Settings['resetDisplay'],
): string | undefined {
  const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  if (Number.isNaN(at)) return undefined;
  if (at <= now) return 'Reset passed, waiting for new data';
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
  /** `dashboard` while a retry could not help: the provider's site still shows the limits. */
  action: 'retry' | 'dashboard';
}

export function problemLine(error: QuotaError, now: number, retryAt?: number): ProblemLine {
  switch (error.kind) {
    // The library's wording names the command or app that fixes it; opentrack only reads those logins.
    case 'noCredentials':
    case 'expired': {
      return { text: error.message, action: 'retry' };
    }
    case 'auth': {
      return { text: `${error.message}. Sign in again with that tool.`, action: 'retry' };
    }
    case 'rateLimited': {
      // The service skips a rate-limited provider until then, whatever a refresh asks.
      return retryAt !== undefined && retryAt > now
        ? {
            text: `Rate limited by the provider, retrying in ${formatDuration(retryAt - now)}`,
            action: 'dashboard',
          }
        : { text: 'Rate limited by the provider', action: 'retry' };
    }
    case 'network': {
      return { text: 'Could not reach the service', action: 'retry' };
    }
    case 'invalidResponse': {
      return { text: 'Limits unavailable right now', action: 'retry' };
    }
  }
}

/** Floored, unlike a countdown: 61 s ago is "1m ago", not "2m". */
function formatAgo(age: number): string {
  return age < 60_000 ? 'just now' : `${formatDuration(Math.floor(age / 60_000) * 60_000)} ago`;
}

export function formatUpdated(updatedAt: string | undefined, now: number): string {
  if (updatedAt === undefined) return 'Not updated yet';
  return `Updated ${formatAgo(now - Date.parse(updatedAt))}`;
}

/**
 * The footer's freshness: how old the oldest limits are, because `updatedAt` also advances on local
 * usage reads, which work offline. Signed-out providers hold no limits, so they cannot age this.
 */
export function freshnessLine(
  state: Pick<AppState, 'providers' | 'quotaUpdatedAt' | 'updatedAt'>,
  now: number,
): string {
  if (state.quotaUpdatedAt) return formatUpdated(state.quotaUpdatedAt, now);
  const expected = state.providers.filter((p) => p.quotaError?.kind !== 'noCredentials');
  return expected.length > 0 && expected.every((p) => p.quotaError)
    ? 'Limits unavailable'
    : formatUpdated(state.updatedAt, now);
}

/** What a finished refresh achieved, for the screen-reader status line. */
export function refreshOutcome(state: Pick<AppState, 'providers' | 'usageError'>): string {
  const failed = state.providers.filter((p) => p.quotaError).map((p) => p.label);
  const problems = [
    ...(state.usageError ? ['usage could not be read'] : []),
    ...(failed.length > 0 ? [`${failed.join(', ')} limits unavailable`] : []),
  ];
  return problems.length > 0 ? `Refresh finished, ${problems.join(', ')}` : 'Usage updated';
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
  const ago = formatAgo(age);
  if (machine.current) return { text: `Live · synced ${ago}`, stale: false };
  const stale = isStaleSync(machine.lastUpdated, now);
  return { text: `Synced ${ago}${stale ? ' · stale' : ''}`, stale };
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
