import { shiftDate } from 'aitrack-lib/data/calendar';
import { toLocalDateString } from 'aitrack-lib/data/dayMap';
import type { LoadedUsageData } from 'aitrack-lib/data/usageData';
import { buildUsageReportsFromLoaded, type UsageReport } from 'aitrack-lib/data/usageReport';
import { QUOTA_PROVIDERS } from 'aitrack-lib/quota/index';

import type { DailyUsage, PeriodUsage, ProviderUsage, QuotaProviderKey } from '../shared/types.js';
import { EMPTY_PERIOD } from '../shared/types.js';

const TREND_DAYS = 30;

export interface UsageSummary {
  providers: Partial<Record<QuotaProviderKey, ProviderUsage>>;
  machineCount: number;
}

function periodFor(report: UsageReport | undefined, key: string): PeriodUsage {
  const provider = report?.providers.find((entry) => entry.key === key);
  if (!provider) return EMPTY_PERIOD;
  return {
    tokens: provider.subtotalTokens,
    costUSD: provider.subtotalCostUSD,
    hasCost: provider.subtotalHasCost,
    models: provider.rows.map(({ model, tokens, costUSD, hasCost }) => ({
      model,
      tokens,
      costUSD,
      hasCost,
    })),
  };
}

function trailingDates(today: Date, days: number): string[] {
  const last = toLocalDateString(today);
  return Array.from({ length: days }, (_, index) => shiftDate(last, index - (days - 1)));
}

/**
 * Today / yesterday / rolling 7 and 30 days / all-time per provider, plus a
 * daily series for the chart.
 *
 * The windows go through the same report builder as `aitrack usage`, so the
 * numbers here always match the CLI's.
 */
export function summarizeUsage(loaded: LoadedUsageData | null, now = new Date()): UsageSummary {
  if (!loaded) return { providers: {}, machineCount: 1 };
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

  const providers: UsageSummary['providers'] = {};
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
  return {
    providers,
    machineCount: Math.max(1, loaded.zonedSources?.length ?? loaded.machineData.length),
  };
}
