import type { DayMap } from '../../data/types.js';
import { fmt, fmtUSDCost } from '../format.js';
import { costColumnLabel, providerLabel } from '../providers.js';
import { INTENSITY_PERCENTILE } from './constants.js';
import { percentile } from './intensity.js';
import { displayModelName } from './modelNames.js';
import { providerStats } from './providerStats.js';
import { computeModelStats, formatMonthLabel, formatPeakDate } from './stats.js';

export interface StatCell {
  label: string;
  value: string;
  /** Optional secondary line (e.g. token amount) rendered under the value in a lighter font. */
  sub?: string;
}

export interface ProviderSectionViewModel {
  name: string;
  maxTokens: number;
  headerStats: StatCell[];
  bottomStats: StatCell[];
}

export function buildProviderSectionViewModel(
  providerKey: string,
  dayMap: DayMap,
): ProviderSectionViewModel {
  const stats = providerStats(dayMap);

  // Only the per-day spread for the intensity percentile is specific to this
  // view; the headline figures come from the same helper the terminal table uses.
  const dayTotals: number[] = [];
  for (const v of dayMap.values()) {
    const total = v.inputTokens + v.outputTokens;
    if (total > 0) dayTotals.push(total);
  }

  const maxTokens = percentile(dayTotals, INTENSITY_PERCENTILE) || 1;
  const costLabel = costColumnLabel(providerKey, true);
  const costValue = stats.hasCost ? fmtUSDCost(stats.costUSD) : '—';

  const { topAllTime, topRecent, peak } = computeModelStats(dayMap);
  const { currentStreak, longestStreak, peakMonth } = stats;

  const bottomStats: StatCell[] = [
    {
      label: 'MOST USED MODEL',
      value: topAllTime ? displayModelName(topAllTime.model) : '—',
      sub: topAllTime ? fmt(topAllTime.tokens) : undefined,
    },
    {
      label: 'LAST 30 DAYS',
      value: topRecent ? displayModelName(topRecent.model) : '—',
      sub: topRecent ? fmt(topRecent.tokens) : undefined,
    },
    {
      label: 'PEAK DAY',
      value: peak ? formatPeakDate(peak.date) : '—',
      sub: peak ? fmt(peak.tokens) : undefined,
    },
    {
      label: 'PEAK MONTH',
      value: peakMonth ? formatMonthLabel(peakMonth.month) : '—',
      sub: peakMonth ? fmt(peakMonth.tokens) : undefined,
    },
    {
      label: 'CURRENT STREAK',
      value: `${String(currentStreak)} day${currentStreak === 1 ? '' : 's'}`,
    },
    {
      label: 'LONGEST STREAK',
      value: `${String(longestStreak)} day${longestStreak === 1 ? '' : 's'}`,
    },
  ];

  const headerStats: StatCell[] = [
    { label: 'INPUT TOKENS', value: fmt(stats.inputTokens) },
    { label: 'OUTPUT TOKENS', value: fmt(stats.outputTokens) },
    { label: 'TOTAL TOKENS', value: fmt(stats.totalTokens) },
    { label: costLabel, value: costValue },
  ];

  return {
    name: providerLabel(providerKey),
    maxTokens,
    headerStats,
    bottomStats,
  };
}
