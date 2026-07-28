import { sumDayMap } from '../../data/aggregate.js';
import type { DayMap } from '../../data/types.js';
import { fmt, fmtUSDCost } from '../format.js';
import { costColumnLabel, providerLabel } from '../providers.js';
import { INTENSITY_PERCENTILE } from './constants.js';
import { percentile } from './intensity.js';
import { displayModelName } from './modelNames.js';
import {
  computeModelStats,
  currentStreak,
  formatMonthLabel,
  formatPeakDate,
  longestStreak,
  peakMonth,
} from './stats.js';

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
  const {
    inputTokens: totalIn,
    outputTokens: totalOut,
    costUSD: totalCost,
    hasCost,
  } = sumDayMap(dayMap);

  // Only the per-day spread for the intensity percentile is specific to this
  // view; the totals come from the same helper the terminal table uses.
  const dayTotals: number[] = [];
  for (const v of dayMap.values()) {
    const total = v.inputTokens + v.outputTokens;
    if (total > 0) dayTotals.push(total);
  }

  const maxTokens = percentile(dayTotals, INTENSITY_PERCENTILE) || 1;
  const costLabel = costColumnLabel(providerKey, true);
  const costValue = hasCost ? fmtUSDCost(totalCost) : '—';

  const { topAllTime, topRecent, peak } = computeModelStats(dayMap);
  const cs = currentStreak(dayMap);
  const ls = longestStreak(dayMap);
  const peakMo = peakMonth(dayMap);

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
      value: peakMo ? formatMonthLabel(peakMo.month) : '—',
      sub: peakMo ? fmt(peakMo.tokens) : undefined,
    },
    { label: 'CURRENT STREAK', value: `${String(cs)} day${cs === 1 ? '' : 's'}` },
    { label: 'LONGEST STREAK', value: `${String(ls)} day${ls === 1 ? '' : 's'}` },
  ];

  const headerStats: StatCell[] = [
    { label: 'INPUT TOKENS', value: fmt(totalIn) },
    { label: 'OUTPUT TOKENS', value: fmt(totalOut) },
    { label: 'TOTAL TOKENS', value: fmt(totalIn + totalOut) },
    { label: costLabel, value: costValue },
  ];

  return {
    name: providerLabel(providerKey),
    maxTokens,
    headerStats,
    bottomStats,
  };
}
