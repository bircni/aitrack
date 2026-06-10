import type { DayMap } from '../../data/types.js';
import { fmt, fmtUSDCost } from '../format.js';
import { costColumnLabel } from '../providers.js';
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
import { getProviderTheme } from './themes.js';

export interface StatCell {
  label: string;
  value: string;
}

export interface ProviderSectionViewModel {
  providerKey: string;
  name: string;
  totalIn: number;
  totalOut: number;
  totalCost: number;
  hasCost: boolean;
  costLabel: string;
  maxTokens: number;
  headerStats: StatCell[];
  bottomStats: StatCell[];
}

export function buildProviderSectionViewModel(
  providerKey: string,
  dayMap: DayMap,
  dark = false,
): ProviderSectionViewModel {
  const theme = getProviderTheme(providerKey, dark);
  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let hasCost = false;
  const dayTotals: number[] = [];

  for (const v of dayMap.values()) {
    const total = v.inputTokens + v.outputTokens;
    if (total > 0) dayTotals.push(total);
    totalIn += v.inputTokens;
    totalOut += v.outputTokens;
    if (v.costUSD !== undefined) {
      totalCost += v.costUSD;
      hasCost = true;
    }
  }

  const maxTokens = percentile(dayTotals, 0.9) || 1;
  const costLabel = costColumnLabel(providerKey, true);
  const costValue = hasCost ? fmtUSDCost(totalCost) : '—';

  const { topAllTime, topRecent, peak } = computeModelStats(dayMap);
  const cs = currentStreak(dayMap);
  const ls = longestStreak(dayMap);
  const peakMo = peakMonth(dayMap);

  const bottomStats: StatCell[] = [
    {
      label: 'MOST USED MODEL',
      value: topAllTime ? `${displayModelName(topAllTime.model)} (${fmt(topAllTime.tokens)})` : '—',
    },
    {
      label: 'RECENT USE (LAST 30 DAYS)',
      value: topRecent ? `${displayModelName(topRecent.model)} (${fmt(topRecent.tokens)})` : '—',
    },
    {
      label: 'PEAK DAY',
      value: peak ? `${formatPeakDate(peak.date)} (${fmt(peak.tokens)})` : '—',
    },
    {
      label: 'PEAK MONTH',
      value: peakMo ? `${formatMonthLabel(peakMo.month)} (${fmt(peakMo.tokens)})` : '—',
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
    providerKey,
    name: theme.name,
    totalIn,
    totalOut,
    totalCost,
    hasCost,
    costLabel,
    maxTokens,
    headerStats,
    bottomStats,
  };
}
