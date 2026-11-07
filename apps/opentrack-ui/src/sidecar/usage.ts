import { hasUnpricedUsage } from 'aitrack-lib/data/aggregate';
import { shiftDate } from 'aitrack-lib/data/calendar';
import { toLocalDateString } from 'aitrack-lib/data/dayMap';
import { isUsageNotConfigured } from 'aitrack-lib/data/emptyState';
import type { MachineFile } from 'aitrack-lib/data/types';
import {
  loadMergedProviderData,
  mergeUsageSources,
  type ZonedUsageData,
} from 'aitrack-lib/data/usageData';
import {
  buildProjectBreakdownsFromLoaded,
  buildUsageReportsFromLoaded,
  type UsageReport,
} from 'aitrack-lib/data/usageReport';
import { errorMessage } from 'aitrack-lib/errors';
import { pull } from 'aitrack-lib/git';
import { type ProviderKey, providerKeys } from 'aitrack-lib/providers/descriptors';

import type {
  DailyUsage,
  MachineUsage,
  PeriodUsage,
  ProjectUsages,
  ProviderUsages,
} from '../shared/types.js';
import { EMPTY_PERIOD } from '../shared/types.js';

/** The History tab's longest range; the sparkline and strips show the last 30 of these. */
const TREND_DAYS = 90;

export const GIT_TIMEOUT_MS = 60_000;

export interface UsageSummary {
  providers: ProviderUsages;
  machines?: MachineUsage[];
  /** Providers read live from the account (Cursor), which no machine's logs hold. */
  account?: ProviderUsages;
  projects?: ProjectUsages;
}

function periodFor(report: UsageReport | undefined, key: string): PeriodUsage {
  const provider = report?.providers.find((entry) => entry.key === key);
  if (!provider) return EMPTY_PERIOD;
  return {
    tokens: provider.subtotalTokens,
    costUSD: provider.subtotalCostUSD,
    hasCost: provider.subtotalHasCost,
    ...(provider.hasUnpricedTokens && { hasUnpricedTokens: true }),
    models: provider.rows.map(({ model, tokens, costUSD, hasCost, hasUnpricedTokens }) => ({
      model,
      tokens,
      costUSD,
      hasCost,
      ...(hasUnpricedTokens && { hasUnpricedTokens: true }),
    })),
  };
}

function trailingDates(today: Date, days: number): string[] {
  const last = toLocalDateString(today);
  return Array.from({ length: days }, (_, index) => shiftDate(last, index - (days - 1)));
}

function providerUsages(loaded: ZonedUsageData, now: Date, dates: string[]): ProviderUsages {
  const [today, yesterday, week, month, all] = buildUsageReportsFromLoaded(
    loaded,
    [
      { period: 'today' },
      { period: 'yesterday' },
      { period: 'week' },
      { period: 'month' },
      { period: 'all' },
    ],
    now,
  );

  const providers: ProviderUsages = {};
  for (const key of providerKeys()) {
    const days = loaded.providerData[key];
    if (!days) continue;
    const daily = dates.map((date): DailyUsage => {
      const day = days.get(date);
      return {
        date,
        costUSD: day?.costUSD ?? 0,
        ...(day && hasUnpricedUsage(day) && { hasUnpricedTokens: true }),
      };
    });
    providers[key] = {
      today: periodFor(today, key),
      yesterday: periodFor(yesterday, key),
      last7Days: periodFor(week, key),
      last30Days: periodFor(month, key),
      allTime: periodFor(all, key),
      daily,
    };
  }
  return providers;
}

function projectUsages(loaded: ZonedUsageData, now: Date): ProjectUsages {
  const [today, week, month, all] = buildProjectBreakdownsFromLoaded(
    loaded,
    [{ period: 'today' }, { period: 'week' }, { period: 'month' }, { period: 'all' }],
    now,
  ).map(({ projects, unattributed }) => (unattributed ? [...projects, unattributed] : projects));
  return {
    today: today ?? [],
    last7Days: week ?? [],
    last30Days: month ?? [],
    allTime: all ?? [],
  };
}

/** Same report builder as `aitrack usage`, so the numbers match the CLI. */
export function summarizeUsage(loaded: ZonedUsageData | null, now = new Date()): UsageSummary {
  if (!loaded) return { providers: {} };
  const dates = trailingDates(now, TREND_DAYS);
  const machines = loaded.zonedSources.map((source): MachineUsage => ({
    name: source.hostname,
    timezone: source.timezone,
    lastUpdated: source.lastUpdated,
    current: source.current,
    providers: providerUsages(mergeUsageSources([source]), now, dates),
  }));
  const live = Object.keys(loaded.liveProviderData).length > 0;
  return {
    providers: providerUsages(loaded, now, dates),
    projects: projectUsages(loaded, now),
    machines,
    ...(live && {
      account: providerUsages(mergeUsageSources([], loaded.liveProviderData), now, dates),
    }),
  };
}

export interface UsageLoadOptions {
  /** Only enabled providers are read, so a disabled Cursor is never contacted. */
  providers: ProviderKey[];
  pull: boolean;
  refreshLive: boolean;
  /** This machine's logs as a sync just read them, so they are not parsed again. */
  localMachine?: MachineFile;
}

export type UsageLoadResult = ({ summary: UsageSummary } | { error: string }) & {
  warning?: string;
};

export async function loadUsageSummary(options: UsageLoadOptions): Promise<UsageLoadResult> {
  // Pulls while this machine's logs are parsed; only the synced files wait for it.
  const pulled =
    options.pull && !isUsageNotConfigured()
      ? pull({ timeoutMs: GIT_TIMEOUT_MS }).then(
          () => undefined,
          (error: unknown) => `Could not pull synced data: ${errorMessage(error)}`,
        )
      : undefined;
  const result = await loadMergedProviderData({
    providers: options.providers,
    refreshLive: options.refreshLive,
    localMachine: options.localMachine,
    syncedReady: pulled,
  })
    .then((loaded) => ({ summary: summarizeUsage(loaded) }))
    .catch((error: unknown) => ({ error: errorMessage(error) }));
  return { ...result, warning: await pulled };
}
