import chalk from 'chalk';

import { sumDayMap } from '../data/aggregate.js';
import { mergeDayMaps } from '../data/dayMap.js';
import type { DayMap, ProviderData } from '../data/types.js';
import { fmt, fmtUSD } from './format.js';
import { resolveProviderLayout } from './heatmap/layout.js';
import { providerStats } from './heatmap/providerStats.js';
import { formatMonthLabel } from './heatmap/stats.js';
import { providerLabel } from './providers.js';
import { defaultTableStyle, renderTerminalTable } from './terminalTable.js';

export interface TuiOptions {
  dark?: boolean;
  all?: boolean;
  year?: number;
}

interface StatsRow {
  provider: string;
  days: number;
  input: string;
  output: string;
  total: string;
  cost: string;
  streak: string;
  peak: string;
}

function summarizeDayMap(dayMap: DayMap, providerKey: string): StatsRow {
  const stats = providerStats(dayMap);
  return {
    provider: providerLabel(providerKey),
    days: stats.activeDays,
    input: fmt(stats.inputTokens),
    output: fmt(stats.outputTokens),
    total: fmt(stats.totalTokens),
    cost: stats.hasCost ? fmtUSD(stats.costUSD) : '—',
    streak: `${String(stats.currentStreak)} / ${String(stats.longestStreak)}`,
    peak: stats.peakMonth ? formatMonthLabel(stats.peakMonth.month) : '—',
  };
}

/**
 * Summarize every provider together.
 *
 * Merging the day maps first is what keeps the Days column honest: a date on
 * which two providers were both active is one day, not two, which is also how
 * --all counts it. Tokens and cost fall out of the same pass.
 */
function totalRow(dayMaps: DayMap[]): StatsRow {
  const merged: DayMap = new Map();
  for (const dayMap of dayMaps) mergeDayMaps(merged, dayMap);
  const { inputTokens, outputTokens, costUSD, hasCost, days } = sumDayMap(merged);

  // Streak and peak month are per-provider figures; a merged row would need a
  // different definition of each, so they are left blank rather than guessed.
  return {
    provider: 'TOTAL',
    days,
    input: fmt(inputTokens),
    output: fmt(outputTokens),
    total: fmt(inputTokens + outputTokens),
    cost: hasCost ? fmtUSD(costUSD) : '—',
    streak: '—',
    peak: '—',
  };
}

export function renderTui(providerData: ProviderData, options: TuiOptions = {}): string {
  const { layoutData, keys } = resolveProviderLayout(providerData, {
    all: options.all,
    year: options.year,
  });

  let bodyRows: StatsRow[];
  let footer: StatsRow | undefined;
  if (options.all) {
    const merged = layoutData.all;
    bodyRows = merged && merged.size > 0 ? [summarizeDayMap(merged, 'all')] : [];
  } else {
    const dayMaps = keys
      .map((key) => layoutData[key])
      .filter((dayMap): dayMap is DayMap => dayMap !== undefined);
    bodyRows = keys
      .map((key) => {
        const dayMap = layoutData[key];
        return dayMap ? summarizeDayMap(dayMap, key) : null;
      })
      .filter((row): row is StatsRow => row !== null);
    if (bodyRows.length > 1) footer = totalRow(dayMaps);
  }

  if (bodyRows.length === 0) return '';

  const isDark = Boolean(options.dark);
  const title =
    options.year === undefined
      ? chalk.bold('aitrack stats')
      : chalk.bold(`aitrack stats (${options.year})`);
  const subtitle = chalk.dim('Streak = current / longest (days)');

  const table = renderTerminalTable(
    [...bodyRows, ...(footer ? [footer] : [])],
    [
      { header: 'Provider', align: 'left', cell: (r) => r.provider },
      { header: 'Days', align: 'right', cell: (r) => String(r.days) },
      { header: 'Input', align: 'right', cell: (r) => r.input },
      { header: 'Output', align: 'right', cell: (r) => r.output },
      { header: 'Total', align: 'right', cell: (r) => r.total },
      { header: 'Est. cost', align: 'right', cell: (r) => r.cost },
      { header: 'Streak', align: 'right', cell: (r) => r.streak },
      { header: 'Peak month', align: 'left', cell: (r) => r.peak },
    ],
    {
      style: defaultTableStyle(isDark),
      bodyRows,
      footerRow: footer,
      firstColumnStyle: defaultTableStyle(isDark).header,
    },
  );

  return [title, subtitle, '', table].join('\n');
}
