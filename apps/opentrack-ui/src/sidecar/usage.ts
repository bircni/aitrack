import { shiftDate } from 'aitrack-lib/data/calendar';
import { toLocalDateString } from 'aitrack-lib/data/dayMap';
import {
  type LoadedUsageData,
  providerDataForWindows,
  type ZonedUsageSource,
} from 'aitrack-lib/data/usageData';
import { buildUsageReportsFromLoaded, type UsageReport } from 'aitrack-lib/data/usageReport';
import { QUOTA_PROVIDERS } from 'aitrack-lib/quota/index';

import type { DailyUsage, MachineUsage, PeriodUsage, ProviderUsages } from '../shared/types.js';
import { EMPTY_PERIOD } from '../shared/types.js';

const TREND_DAYS = 30;
const EVERY_DAY = { start: '0000-01-01', end: '9999-12-31' };

export interface UsageSummary {
  providers: ProviderUsages;
  machineCount: number;
  machines?: MachineUsage[];
  /** Providers read live from the account (Cursor), which no machine's logs hold. */
  account?: ProviderUsages;
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

function providerUsages(loaded: LoadedUsageData, now: Date): ProviderUsages {
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
  const dates = trailingDates(now, TREND_DAYS);

  const providers: ProviderUsages = {};
  for (const key of QUOTA_PROVIDERS) {
    const days = loaded.providerData[key];
    if (!days) continue;
    const daily: DailyUsage[] = dates.map((date) => ({
      date,
      costUSD: days.get(date)?.costUSD ?? 0,
    }));
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

/** Just these machines' days, plus the live providers when asked; priced like the whole. */
function sliceLoaded(
  loaded: LoadedUsageData,
  zonedSources: ZonedUsageSource[],
  live: boolean,
): LoadedUsageData {
  const part: LoadedUsageData = {
    providerData: {},
    machineData: [],
    zonedSources,
    ...(live && loaded.liveProviderData && { liveProviderData: loaded.liveProviderData }),
  };
  return { ...part, providerData: providerDataForWindows(part, () => EVERY_DAY) };
}

/**
 * Today / yesterday / rolling 7 and 30 days / all-time per provider, plus a
 * daily series for the chart, in total and per machine.
 *
 * The windows go through the same report builder as `aitrack usage`, so the
 * numbers here always match the CLI's.
 */
export function summarizeUsage(loaded: LoadedUsageData | null, now = new Date()): UsageSummary {
  if (!loaded) return { providers: {}, machineCount: 1 };
  const machines = (loaded.zonedSources ?? []).map((source): MachineUsage => ({
    name: source.hostname,
    timezone: source.timezone,
    lastUpdated: source.lastUpdated,
    current: source.current,
    providers: providerUsages(sliceLoaded(loaded, [source], false), now),
  }));
  const live = Object.keys(loaded.liveProviderData ?? {}).length > 0;
  return {
    providers: providerUsages(loaded, now),
    machineCount: Math.max(1, loaded.zonedSources?.length ?? loaded.machineData.length),
    machines,
    ...(live && { account: providerUsages(sliceLoaded(loaded, [], true), now) }),
  };
}
